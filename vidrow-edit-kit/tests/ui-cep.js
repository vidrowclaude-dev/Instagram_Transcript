'use strict';
// Loads the panel the way CEP does (mixed context: Node's module/exports/require/process are globals,
// window.__adobe_cep__ and window.cep.fs exist) and clicks every button. Catches startup crashes that
// leave the panel looking fine but dead.
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const http = require('http');
const fs = require('fs');
const EXT = path.join(__dirname, '..', 'extension');
function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const p = path.join(EXT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
      if (!p.startsWith(EXT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    // Node globals present in CEP's mixed context
    window.module = { exports: {} }; window.exports = window.module.exports;
    window.process = { versions: { node: '15.9.0' }, platform: 'darwin' };
    window.require = function (m) { throw new Error('no node in test: ' + m); };
    window.__evalCalls = [];
    const items = [
      { name: 'A001_take1.mov', bin: 'Shoot Day 1', path: '/Shoot/A001_take1.mov' },
      { name: 'A001_take2.mov', bin: 'Shoot Day 1', path: '/Shoot/A001_take2.mov' },
      { name: 'app_home.png', bin: 'Client', path: '/Client/app_home.png' }];
    window.__adobe_cep__ = {
      getSystemPath: () => '',
      evalScript(code, cb) {
        window.__evalCalls.push(code);
        let r = { ok: true, log: [] };
        if (/VEK\.ping/.test(code)) r = { ok: true, app: 'Premiere Pro', version: '25.0', project: 'Test.prproj', log: [] };
        if (/VEK\.listProject/.test(code)) r = { ok: true, items, log: [] };
        if (/VEK\.getSelection/.test(code)) r = { ok: true, items: [items[1]], log: [] };
        setTimeout(() => cb(JSON.stringify(r)), 0);
      },
    };
    window.cep = { fs: { showOpenDialogEx: (multi, folder) => ({ err: 0, data: folder ? ['/Shoot/Day2'] : ['/Shoot/B002_take1.mov', '/Shoot/B002_take2.mov'] }) }, util: { openURLInDefaultBrowser() {} } };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(() => window.VEKApp);
  const count = (sel) => page.$$eval(sel, (els) => els.length);

  // connection dot turns green from ping
  await page.waitForSelector('#conn.ok', { timeout: 6000 });

  // Footage: Add files, Add folder, Use selection, From Project panel
  await page.click('.tab[data-tab=footage]');
  await page.click('#fAddFiles');
  assert.strictEqual(await count('#listFootage li'), 2, 'Add files');
  await page.click('#fAddFolder');
  assert.strictEqual(await count('#listFootage li'), 3, 'Add folder');
  await page.click('#fUseSel');
  await page.waitForFunction(() => document.querySelectorAll('#listFootage li').length === 4);
  await page.click('#fFromProject');
  await page.waitForSelector('#projModal:not([hidden]) .proj-item');
  await page.check('.proj-item input[value="/Shoot/A001_take1.mov"]');
  await page.click('#projAdd');
  assert.strictEqual(await count('#listFootage li'), 5, 'From Project panel');
  await page.click('#listFootage li .x');
  assert.strictEqual(await count('#listFootage li'), 4, 'remove');
  assert.strictEqual(await page.textContent('#cntFootage'), '4');

  // Format: pick a format, reference type
  await page.click('.tab[data-tab=format]');
  await page.click('.fmt[data-id=skit]');
  assert.ok((await page.textContent('#formatDetail')).includes('Skit'));
  await page.click('#refType button[data-v=link]');
  assert.ok(await page.isVisible('#refUrl'));

  // Client: assets + links + callout style
  await page.click('.tab[data-tab=client]');
  await page.click('#aAddFiles');
  assert.strictEqual(await count('#listAssets li'), 2);
  await page.click('#addLink');
  await page.fill('.linkrow input', 'https://www.figma.com/design/abc/X?node-id=1-2');
  assert.strictEqual(await page.$eval('.linkrow select', (s) => s.value), 'figma', 'link type auto-detected');
  await page.check('input[name=callout][value=black]');

  // Settings open / close
  await page.click('#btnSettings');
  assert.ok(await page.isVisible('#setModal'));
  await page.click('#setModal [data-close]');
  assert.ok(!(await page.isVisible('#setModal')));

  // Generate without Node shows a clear message (not silence)
  await page.click('#btnGenerate');
  assert.ok(/inside Premiere Pro/.test(await page.textContent('#status')), await page.textContent('#status'));

  assert.deepStrictEqual(errors, [], 'no page errors');
  await browser.close();
  server.close();
  console.log('CEP-context UI test passed (all buttons respond).');
})().catch((e) => { console.error(e); process.exit(1); });
