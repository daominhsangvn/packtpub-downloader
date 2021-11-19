const puppeteer = require("puppeteer");
const fs = require('fs');
const path = require('path');

(async () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'book.html'), 'utf8');

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  await page.setContent(html, {
    waitUntil: 'networkidle0'
  });

  await page.pdf({
    path: path.join(process.cwd(), 'book.pdf'),
    printBackground: true,
    margin: {
      top: 30,
      bottom: 30,
      left: 20,
      right: 20
    }
  });

  await page.close();
  await browser.close();
})()
