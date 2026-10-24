// Captures the admin UI screenshots used in docs/IMPLEMENTATION_GUIDE.md from a running stack.
// Usage: start the API (with ADMIN_TOKEN), the fake POS and `npm run dev:admin`, then
//   node docs/capture-screenshots.mjs [http://localhost:5173]
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, 'images');
const url = process.argv[2] ?? 'http://localhost:5173';
const token = process.env.ADMIN_TOKEN ?? 'dev-admin-token';

const browsers = [
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = browsers.find((p) => existsSync(p));
if (!executablePath) throw new Error('No Chrome/Edge found; set CHROME_PATH');

mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

const shot = async (name) => {
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: resolve(out, `${name}.png`) });
  console.log(`saved images/${name}.png`);
};

await page.goto(url, { waitUntil: 'networkidle0' });
await shot('01-token-gate');
await page.type('input[type=password]', token);
await page.click('button[type=submit]');
await page.waitForSelector('table.table');
await shot('02-dashboard');

await page.click('button[title="Show only: failed sync"]');
await page.waitForFunction(() => document.querySelectorAll('tbody tr').length > 0);
await shot('03-failed-filter');

await page.click('tbody tr');
await page.waitForSelector('.drawer .timeline, .drawer .panel');
await shot('04-details-drawer');

await page.click('.drawer .btn--primary');
await page.waitForSelector('[role=alertdialog]');
await shot('05-retry-dialog');

await page.click('[role=alertdialog] .btn--primary');
await page.waitForSelector('.toast');
await shot('06-retry-result');

await page.keyboard.press('Escape');
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.cards');
await shot('07-mobile');

await browser.close();
