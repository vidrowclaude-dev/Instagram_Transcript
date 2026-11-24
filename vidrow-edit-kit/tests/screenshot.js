'use strict';
// UI check: serve the panel over http, screenshot each tab with Playwright, and run the browser-side
// pieces (rich paste conversion, canvas renderers, face-api loader with hidden Node globals) in Chromium.
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const EXT = path.join(__dirname, '..', 'extension');
const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const p = path.join(EXT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
      if (!p.startsWith(EXT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 440, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  await page.goto(base);
  await page.waitForSelector('.fmt', { state: 'attached' });

  // fill a realistic draft
  await page.fill('#jobName', 'EMI Ad');
  await page.fill('#script', 'Hook 1\nKya aap bhi EMI se pareshan ho?\nHook 2\nMaine 30 din mein paise bachaye.\nHook 3\nYeh trick koi nahi batata.\nBody\n[CALLOUT: 0% EMI]\nBachatt app pe zero percent EMI milta hai.\nAaj hi download karo [LINK: https://bachatt.example/offer]');
  await page.dispatchEvent('#script', 'input');
  await page.evaluate(() => {
    const s = window.VEKApp.state;
    s.footage.push({ path: '/Shoot/A001_C003_take1.mov', name: 'A001_C003_take1.mov', kind: 'video', bin: 'Shoot Day 1' }, { path: '/Shoot/A001_C004_take2.mov', name: 'A001_C004_take2.mov', kind: 'video', bin: 'Shoot Day 1' });
    s.assets.push({ path: '/Client/app_home.png', name: 'app_home.png', kind: 'image' }, { path: '/Client/logo.mov', name: 'logo_4444.mov', kind: 'video' });
    s.links.push({ type: 'figma', url: 'https://www.figma.com/design/AbC123/Screens?node-id=1-2' }, { type: 'drive', url: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp' });
    window.VEKApp.refresh();
  });
  const shots = [];
  for (const tab of ['script', 'footage', 'format', 'client', 'music', 'brief']) {
    await page.click(`.tab[data-tab=${tab}]`);
    if (tab === 'brief') {
      await page.evaluate(() => {
        window.VEKApp.state.lastJobDir = '/Users/editor/Movies/Vidrow Edit Kit/EMI_Ad';
        window.VEKApp.showLastEdit({ planSummary: 'H1 pain question, H2 result claim, H3 pattern interrupt; body from take 1 (cleanest).', jobDir: '/Users/editor/Movies/Vidrow Edit Kit/EMI_Ad',
          summary: [{ name: 'Bachatt_EMI_Ad_H1', duration: 31.4, bodyStart: 3.1, cuts: 14, overlays: 4, callouts: 1, music: 'switch at 3.1 s', markers: 19 },
            { name: 'Bachatt_EMI_Ad_H2', duration: 31.9, bodyStart: 3.6, cuts: 15, overlays: 4, callouts: 1, music: 'switch at 3.6 s', markers: 19 }],
          warnings: ['Script line not covered: H3 #1 "Yeh trick koi nahi batata." (0% of its words found in the cut)'], cutCheck: { Bachatt_EMI_Ad_H1: '14 exact' } });
        window.VEKApp.readyStatus();
      });
    }
    const f = path.join(OUT, `tab-${tab}.png`);
    await page.screenshot({ path: f });
    shots.push(f);
  }
  // status link opens the Brief tab and scrolls to the results
  await page.click('.tab[data-tab=script]');
  await page.click('#toBrief');
  assert.ok(await page.isVisible('#pane-brief'), 'status link opens Brief tab');
  // settings sheet
  await page.click('#btnSettings');
  await page.screenshot({ path: path.join(OUT, 'settings.png') });
  await page.click('#setModal [data-close]');

  // drafts survive a reload
  await page.reload();
  await page.waitForSelector('.fmt', { state: 'attached' });
  assert.strictEqual(await page.inputValue('#jobName'), 'EMI Ad', 'draft restored after reload');
  assert.ok((await page.inputValue('#script')).includes('Hook 2'));

  // ---- rich paste conversion (Google Docs HTML)
  const converted = await page.evaluate(() => window.VEKPaste.htmlToScript(
    '<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-1"><p dir="ltr"><span style="color:#000000;background-color:transparent">Hook 1</span></p>' +
    '<p dir="ltr"><span style="background-color:#ffff00">0% EMI on all phones</span></p>' +
    '<p dir="ltr"><span>Kya aap bhi </span><a href="https://www.google.com/url?q=https://bachatt.example/offer&amp;sa=D"><span style="color:#1155cc;text-decoration:underline">yeh offer</span></a><span> dekha?</span></p></b>'));
  assert.strictEqual(converted, 'Hook 1\n[CALLOUT: 0% EMI on all phones]\nKya aap bhi yeh offer [LINK: https://bachatt.example/offer] dekha?', converted);

  // ---- canvas renderers
  const rend = await page.evaluate(async () => {
    const R = window.VEKRenderers.makeRenderers(null);
    const frame = { w: 1080, h: 1920 };
    const callout = await R.renderCallout({ text: '0% EMI on everything', style: 'brand', brandColor: '#715BE4', frame, topPct: 0.15 });
    // geometry identical to framing.phoneGeometry (Node) for 1080x1920
    const H = Math.round(1920 * 0.94), W = Math.round(H * 0.485), x = Math.round((1080 - W) / 2), y = Math.round((1920 - H) / 2), bez = Math.round(W * 0.035), r = Math.round(W * 0.14);
    const g = { body: { x, y, w: W, h: H, r }, hole: { x: x + bez, y: y + bez, w: W - 2 * bez, h: H - 2 * bez, r: r - bez }, island: { w: Math.round(W * 0.3), h: Math.round(W * 0.085), x: Math.round(540 - W * 0.15), y: y + bez + Math.round(W * 0.03) }, shadow: Math.round(W * 0.06) };
    const shot = document.createElement('canvas'); shot.width = 1170; shot.height = 2532;
    const sc = shot.getContext('2d'); const gr = sc.createLinearGradient(0, 0, 0, 2532); gr.addColorStop(0, '#F5FA5E'); gr.addColorStop(1, '#715BE4'); sc.fillStyle = gr; sc.fillRect(0, 0, 1170, 2532);
    sc.fillStyle = '#111'; sc.font = 'bold 120px Helvetica'; sc.fillText('App home', 120, 400);
    const phoneShot = await R.renderPhone({ screenshot: shot.toDataURL(), frame, geometry: g });
    const phoneFrame = await R.renderPhone({ screenshot: null, frame, geometry: g });
    const alphaAt = async (url, px, py) => { const img = await window.VEKRenderers.loadImage(url); const c = document.createElement('canvas'); c.width = 1080; c.height = 1920; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); return ctx.getImageData(px, py, 1, 1).data[3]; };
    return {
      callout, phoneShot, phoneFrame,
      calloutCorner: await alphaAt(callout, 5, 5), calloutCenter: await alphaAt(callout, 540, Math.round(1920 * 0.15) + 40),
      holeCenter: await alphaAt(phoneFrame, 540, 960), bezel: await alphaAt(phoneFrame, x + 4, 960), outside: await alphaAt(phoneFrame, 10, 960),
      shotCenter: await alphaAt(phoneShot, 540, 960),
    };
  });
  assert.strictEqual(rend.calloutCorner, 0, 'callout canvas transparent outside the box');
  assert.strictEqual(rend.calloutCenter, 255, 'callout box opaque at ~15% down');
  assert.strictEqual(rend.holeCenter, 0, 'phone frame: screen hole transparent for the recording');
  assert.strictEqual(rend.bezel, 255, 'phone frame: bezel opaque');
  assert.strictEqual(rend.outside, 0, 'phone frame: outside the phone transparent (blurred footage shows)');
  assert.strictEqual(rend.shotCenter, 255, 'screenshot drawn inside the phone');
  for (const [k, v] of Object.entries({ callout: rend.callout, phone_screenshot: rend.phoneShot, phone_frame: rend.phoneFrame })) {
    fs.writeFileSync(path.join(OUT, `render-${k}.png`), Buffer.from(v.split(',')[1], 'base64'));
  }

  // ---- face-api: load with Node globals hidden, weights from bytes via tf.io.decodeWeights, run detection
  const code = fs.readFileSync(path.join(EXT, 'lib/faceapi/face-api.js'), 'utf8');
  const models = {};
  for (const n of ['ssd_mobilenetv1', 'tiny_face_detector']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(EXT, `lib/faceapi/model/${n}_model-weights_manifest.json`), 'utf8'));
    const bytes = Buffer.concat(manifest.flatMap((g) => g.paths.map((p) => fs.readFileSync(path.join(EXT, 'lib/faceapi/model', p)))));
    models[n] = { manifest, b64: bytes.toString('base64') };
  }
  const faceRes = await page.evaluate(async ({ code, models }) => {
    // simulate CEP mixed context: Node-ish globals present on window
    window.require = function () { throw new Error('face-api must not call require'); };
    window.module = { exports: {} }; window.process = { versions: { node: '16' } };
    const m = {};
    for (const k of Object.keys(models)) {
      const bin = atob(models[k].b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      m[k] = { manifest: models[k].manifest, bytes: u };
    }
    const fa = await window.VEKFaces.loadFromSources(code, m);
    const c = document.createElement('canvas'); c.width = 640; c.height = 360; const ctx = c.getContext('2d'); ctx.fillStyle = '#777'; ctx.fillRect(0, 0, 640, 360);
    const dets = await window.VEKFaces.detectFrames(fa, [c.toDataURL('image/jpeg')]);
    return { loaded: fa.nets.ssdMobilenetv1.isLoaded && fa.nets.tinyFaceDetector.isLoaded, backend: fa.tf.getBackend(), frames: dets.length, faces: dets[0].length };
  }, { code, models });
  assert.ok(faceRes.loaded, 'face models loaded from decoded weights');
  assert.strictEqual(faceRes.frames, 1); assert.strictEqual(faceRes.faces, 0, 'no faces on a blank frame');

  assert.deepStrictEqual(errors, [], 'no page errors');
  await browser.close();
  server.close();
  console.log('UI check passed:', JSON.stringify(faceRes));
  console.log('Screenshots:', shots.concat([path.join(OUT, 'settings.png')]).map((s) => path.relative(process.cwd(), s)).join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
