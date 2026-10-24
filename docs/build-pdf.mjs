// Builds docs/IMPLEMENTATION_GUIDE.pdf from docs/IMPLEMENTATION_GUIDE.md.
// Markdown -> HTML (marked) with a cover, table of contents and print CSS, then printed by a local
// Chrome/Edge through puppeteer-core (page numbers in the footer). Usage: npm run docs:pdf
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Marked } from 'marked';
import puppeteer from 'puppeteer-core';

const docs = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(docs, 'IMPLEMENTATION_GUIDE.md'), 'utf8');

const front = /^---\n([\s\S]*?)\n---\n/.exec(source);
const meta = Object.fromEntries(
  (front?.[1] ?? '')
    .split('\n')
    .map((l) => l.split(/:\s*/, 2))
    .filter((p) => p.length === 2),
);
const body = front ? source.slice(front[0].length) : source;

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const toc = [];
const marked = new Marked({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = slug(text);
      if (depth === 1) toc.push({ id, text });
      return `<h${depth} id="${id}">${text}</h${depth}>\n`;
    },
    image({ href, text }) {
      return `<figure><img src="${href}" alt="${text}"><figcaption>${text}</figcaption></figure>`;
    },
  },
});
const content = marked.parse(body);
const date = new Date().toISOString().slice(0, 10);

const css = `
@page { size: A4; margin: 18mm 16mm 20mm; }
* { box-sizing: border-box; }
body { font-family: 'Segoe UI', Helvetica, Arial, sans-serif; color: #0f172a; font-size: 10.5pt; line-height: 1.5; }
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: center; page-break-after: always; }
.cover .bar { width: 64px; height: 8px; background: #c2410c; border-radius: 4px; margin-bottom: 28px; }
.cover h1 { font-size: 34pt; margin: 0; letter-spacing: -0.02em; border: none; padding: 0; page-break-before: avoid; }
.cover h2 { font-size: 18pt; font-weight: 400; color: #475569; margin: 8px 0 40px; border: none; }
.cover .meta { color: #475569; font-size: 10.5pt; line-height: 1.8; }
.toc { page-break-after: always; }
.toc h2 { font-size: 18pt; border: none; }
.toc ol { list-style: none; padding: 0; columns: 1; }
.toc li { padding: 6px 0; border-bottom: 1px dotted #cbd5e1; font-size: 11pt; }
.toc a { color: #0f172a; text-decoration: none; }
h1 { font-size: 17pt; color: #9a3412; border-bottom: 2px solid #fed7aa; padding-bottom: 6px; margin-top: 0; page-break-before: always; }
h2 { font-size: 13pt; margin-top: 18px; }
h3 { font-size: 11.5pt; }
p, li { orphans: 3; widows: 3; }
code { font-family: 'Cascadia Mono', Consolas, monospace; font-size: 9pt; background: #f1f5f9; padding: 1px 4px; border-radius: 3px; }
pre { background: #0f172a; color: #e2e8f0; padding: 10px 12px; border-radius: 6px; font-size: 8.6pt; line-height: 1.45; overflow: hidden; white-space: pre-wrap; page-break-inside: avoid; }
pre code { background: none; color: inherit; padding: 0; }
table { width: 100%; border-collapse: collapse; margin: 10px 0 14px; font-size: 8.8pt; page-break-inside: auto; }
th, td { border: 1px solid #e2e8f0; padding: 5px 7px; vertical-align: top; text-align: left; }
th { background: #f8fafc; font-weight: 600; }
tr { page-break-inside: avoid; }
figure { margin: 12px 0 16px; text-align: center; page-break-inside: avoid; }
figure img { max-width: 100%; max-height: 120mm; border: 1px solid #e2e8f0; border-radius: 6px; }
figcaption { color: #64748b; font-size: 8.8pt; margin-top: 4px; }
strong { color: #0f172a; }
a { color: #c2410c; }
`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<base href="${pathToFileURL(`${docs}/`).href}"><title>${meta.title ?? 'Guide'}</title><style>${css}</style></head><body>
<section class="cover"><div class="bar"></div><h1>${meta.title ?? ''}</h1><h2>${meta.subtitle ?? ''}</h2>
<div class="meta">Backend take-home: POS synchronization<br>NestJS · PostgreSQL · Drizzle · React<br>Generated ${date} from docs/IMPLEMENTATION_GUIDE.md</div></section>
<section class="toc"><h2>Contents</h2><ol>${toc.map((t) => `<li><a href="#${t.id}">${t.text}</a></li>`).join('')}</ol></section>
${content}
</body></html>`;

mkdirSync(resolve(docs, '.build'), { recursive: true });
const htmlPath = resolve(docs, '.build', 'guide.html');
writeFileSync(htmlPath, html);

const executablePath = [
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p));
if (!executablePath) throw new Error('No Chrome/Edge found; set CHROME_PATH');

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--allow-file-access-from-files'],
  // Keep the browser profile inside docs/.build (gitignored) instead of the system temp dir.
  userDataDir: resolve(docs, '.build', 'browser-profile'),
});
const page = await browser.newPage();
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
await page.pdf({
  path: resolve(docs, 'IMPLEMENTATION_GUIDE.pdf'),
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;font-size:8px;color:#64748b;padding:0 16mm;display:flex;justify-content:space-between;font-family:Segoe UI,Arial">' +
    '<span>EZeats POS Synchronization · Implementation Guide</span>' +
    '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
  margin: { top: '16mm', bottom: '18mm', left: '16mm', right: '16mm' },
});
await browser.close();
console.log('wrote docs/IMPLEMENTATION_GUIDE.pdf');
