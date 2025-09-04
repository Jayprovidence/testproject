// 引入所需套件
const { addExtra } = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const puppeteer = addExtra(require('puppeteer'));
const fs = require('fs-extra');
const path = require('path');
const { Storage } = require('@google-cloud/storage');

// --- 專案設定 ---
const BUCKET_NAME = 'foreclosure-data-bucket-lin-2025';
const PROJECT_ID = 'daring-tracer-470401-u1';
const JSON_FILENAME = 'auctionData.json';
// ----------------

puppeteer.use(StealthPlugin());
const storage = new Storage({ projectId: PROJECT_ID, keyFilename: './key.json' });
const bucket = storage.bucket(BUCKET_NAME);
const jsonOutputPath = path.resolve('/tmp', JSON_FILENAME);

/**
 * 主函式：遍歷所有案件，抓取其 PDF 與圖片的 URL
 */
async function scrapeCaseDetails() {
    console.log(`開始執行案件詳情 URL 更新任務...`);

    // 1. 讀取現有資料
    let allCases = [];
    try {
        const data = await bucket.file(JSON_FILENAME).download();
        allCases = JSON.parse(data.toString()).data;
        console.log(`成功讀取 ${allCases.length} 筆現有案件。`);
    } catch (error) {
        console.error('讀取主要資料檔案時發生錯誤:', error);
        return;
    }

    // 2. 啟動瀏覽器
    let browser;
    try {
        console.log('啟動瀏覽器...');
        const launchOptions = { headless: "new", args: ['--no-sandbox'] };
         if (process.env.CLOUD_RUN_JOB) {
            launchOptions.executablePath = '/usr/bin/google-chrome';
        }
        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();

        // 3. 遍歷需要更新的案件
        for (const caseItem of allCases) {
            // 如果案件已有 assets 資訊，可以選擇跳過以節省時間
            if (caseItem.assets && caseItem.assets.detailPageUrl) {
                console.log(`案號 ${caseItem.caseNumber} 已有資料，跳過。`);
                continue;
            }

            console.log(`正在處理案號: ${caseItem.caseNumber}`);
            try {
                await page.goto('https://aomp109.judicial.gov.tw/judbp/wkw/WHD1A02.htm', { waitUntil: 'networkidle2' });

                const formFrame = await page.waitForFrame(frame => frame.name() === 'bottom');
                if (!formFrame) throw new Error('找不到 "bottom" iframe');

                const caseMatch = caseItem.caseNumber.match(/(\d+)(\S+?字第)(\d+)號/);
                if (!caseMatch) {
                    console.warn(`案號格式不符，無法查詢: ${caseItem.caseNumber}`);
                    continue;
                }
                const [, crmyy, crmid, crmno] = caseMatch;
                
                await formFrame.type('#crmyy', crmyy);
                await formFrame.type('#crmid', crmid);
                await formFrame.type('#crmno', crmno);
                await formFrame.click('#btn_ok');

                const resultsFrame = await page.waitForFrame(frame => frame.name() === 'frame-main' && frame.url().includes('WHD1A03'));
                
                // 4. 從結果列表中，抓取「圖片」和「筆錄」的 URL
                const links = await resultsFrame.evaluate(() => {
                    const firstRow = document.querySelector('#row1');
                    if (!firstRow) return null;
                    const detailLink = firstRow.querySelector('a[href*="WHD1A02_DETAIL"]');
                    const pdfLink = firstRow.querySelector('a[href*="DO_VIEWPDF"]');
                    return {
                        detailPageUrl: detailLink ? detailLink.href : null,
                        pdfUrl: pdfLink ? pdfLink.href : null
                    };
                });

                if (!links || !links.detailPageUrl) {
                    console.log(` -> 找不到案號 ${caseItem.caseNumber} 的詳情頁連結。`);
                    continue;
                }

                // 5. 將找到的 URL 存入案件資料中
                caseItem.assets = {
                    pdfs: [],
                    images: [],
                    detailPageUrl: links.detailPageUrl
                };
                if (links.pdfUrl) {
                    caseItem.assets.pdfs.push({ name: '拍賣筆錄 (PDF)', url: links.pdfUrl });
                }

                // 6. 前往圖片詳情頁，抓取所有圖片的 URL
                await page.goto(links.detailPageUrl, { waitUntil: 'networkidle2' });
                const imageUrls = await page.evaluate(() => {
                    const images = Array.from(document.querySelectorAll('img[src*="/judbp/wkw/WHD1A02/"]'));
                    return images.map(img => img.src);
                });
                caseItem.assets.images = imageUrls;
                
                console.log(`  -> 成功抓取 ${imageUrls.length} 張圖片, ${links.pdfUrl ? 1 : 0} 份 PDF。`);

            } catch (error) {
                console.error(`處理案號 ${caseItem.caseNumber} 時發生錯誤:`, error.message);
            }
        }

    } finally {
        if (browser) await browser.close();
    }

    // 7. 將更新後的完整資料寫回 GCS
    fs.writeFileSync(jsonOutputPath, JSON.stringify({ data: allCases }, null, 2));
    console.log(`準備將更新後的 ${allCases.length} 筆資料寫回 GCS...`);
    await bucket.upload(jsonOutputPath, { destination: REAL_ESTATE_FILENAME });
    console.log('所有案件詳情 URL 更新完成！');
}

// 主執行流程
scrapeCaseDetails()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('案件詳情爬蟲執行失敗:', error);
        process.exit(1);
    });
