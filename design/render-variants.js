const { chromium } = require('playwright');
const OUT = '/home/user/Instagram_Transcript/design/renders';
const fruits = `<svg viewBox="0 0 400 260"><ellipse cx="200" cy="236" rx="150" ry="10" fill="rgba(90,40,0,.18)"/>
<path d="M120 90 C70 90 60 150 80 190 C95 225 125 232 140 222 C155 232 185 225 200 190 C220 150 205 90 160 92 C150 95 135 95 120 90Z" fill="#d7262e"/>
<path d="M140 92 C140 70 150 58 162 52" stroke="#5b3a1a" stroke-width="6" fill="none" stroke-linecap="round"/>
<path d="M150 70 C170 50 195 55 200 62 C185 78 165 80 150 70Z" fill="#3f9a2f"/>
<ellipse cx="105" cy="130" rx="10" ry="22" fill="rgba(255,255,255,.35)"/>
<circle cx="285" cy="168" r="62" fill="#f28b12"/><circle cx="285" cy="168" r="62" fill="url(#g)"/>
<defs><radialGradient id="g" cx=".35" cy=".3"><stop offset="0" stop-color="#ffc35a"/><stop offset="1" stop-color="#f28b12" stop-opacity="0"/></radialGradient></defs>
<path d="M285 106 l-6 -14 M285 106 c10 -14 26 -16 34 -10 c-10 12 -24 14 -34 10" stroke="#3f9a2f" stroke-width="5" fill="#3f9a2f"/>
<path d="M130 214 C200 246 300 240 344 196 C350 190 362 198 354 208 C312 258 200 262 130 232Z" fill="#f7d235"/>
<path d="M348 198 l10 -10" stroke="#5b3a1a" stroke-width="7" stroke-linecap="round"/></svg>`;
const audio = `<svg viewBox="0 0 400 260"><ellipse cx="200" cy="238" rx="150" ry="10" fill="rgba(0,20,60,.2)"/>
<path d="M110 160 C110 60 290 60 290 160" stroke="#20242c" stroke-width="22" fill="none" stroke-linecap="round"/>
<rect x="86" y="140" width="56" height="86" rx="24" fill="#20242c"/><rect x="258" y="140" width="56" height="86" rx="24" fill="#20242c"/>
<rect x="98" y="152" width="34" height="62" rx="16" fill="#e94f37"/><rect x="268" y="152" width="34" height="62" rx="16" fill="#e94f37"/>
<rect x="170" y="150" width="60" height="84" rx="12" fill="#f5f6f8"/><rect x="178" y="158" width="44" height="30" rx="6" fill="#20242c"/>
<circle cx="200" cy="212" r="12" fill="#d5d9e0"/></svg>`;
const skin = `<svg viewBox="0 0 400 260"><ellipse cx="200" cy="238" rx="150" ry="10" fill="rgba(90,0,40,.16)"/>
<rect x="90" y="60" width="64" height="172" rx="14" fill="#fff6f0"/><rect x="104" y="36" width="36" height="28" rx="5" fill="#c9a27a"/>
<rect x="100" y="120" width="44" height="60" rx="4" fill="#f3c7d6"/><rect x="108" y="134" width="28" height="4" fill="#7a2346"/><rect x="108" y="144" width="20" height="4" fill="#7a2346"/>
<rect x="172" y="104" width="70" height="128" rx="32" fill="#e7b6c9"/><rect x="194" y="70" width="26" height="38" rx="4" fill="#3a2a2f"/><rect x="188" y="62" width="38" height="14" rx="4" fill="#3a2a2f"/>
<rect x="186" y="150" width="42" height="40" rx="6" fill="#fff"/><rect x="194" y="162" width="26" height="4" fill="#7a2346"/>
<rect x="260" y="168" width="84" height="64" rx="10" fill="#f9e4d4"/><rect x="256" y="150" width="92" height="24" rx="8" fill="#c9a27a"/>
<rect x="282" y="190" width="40" height="5" fill="#b07a5a"/></svg>`;
const V = [
  { id:'tools', title:'Power Tools & More', badge:'60 MINS', cta:'Add to cart', panel:'#b5c824', btn:'#c8dc00', badgeC:'#4c5a1c', svg:null, bg:'#5a4a33', info:'#e8edd0' },
  { id:'fruits', title:'Farm-Fresh Fruits', badge:'15 MINS', cta:'Add to cart', panel:'#f59a2a', btn:'#ffd23f', badgeC:'#7a3a00', svg:fruits, bg:'#3d4a2a', info:'#fdf0df' },
  { id:'audio', title:'Headphones & Audio', badge:'30 MINS', cta:'Shop now', panel:'#5b86f0', btn:'#a8d8ff', badgeC:'#1b2c66', svg:audio, bg:'#2a3550', info:'#e8effd' },
  { id:'skincare', title:'Skincare Essentials', badge:'20 MINS', cta:'Add to bag', panel:'#ee9fbe', btn:'#ffd9e8', badgeC:'#7a2346', svg:skin, bg:'#4f3340', info:'#fcebf2' },
];
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport:{width:1600,height:1400}, deviceScaleFactor:2 });
  await p.goto('file:///home/user/Instagram_Transcript/design/split-screen-ad.html'); await p.waitForTimeout(1200);
  await p.addStyleTag({ content: '.ad.play .card,.ad.play .cta{animation:none!important}.placeholder span{display:none}.stage{background:transparent;padding:0}.app{grid-template-columns:1fr!important}.rail,header{display:none}' });
  for (const v of V) for (const r of ['', 'ratio-9x16']) {
    await p.evaluate(({v, r, def}) => {
      const ad = document.getElementById('ad');
      ad.classList.remove('ratio-9x16','ratio-1x1'); if (r) ad.classList.add(r);
      ad.style.setProperty('--panel', v.panel); ad.style.setProperty('--btn', v.btn); ad.style.setProperty('--badge', v.badgeC); ad.style.setProperty('--info', v.info);
      document.getElementById('titleText').textContent = v.title; document.getElementById('badgeText').textContent = v.badge; document.getElementById('ctaText').textContent = v.cta;
      if (!window.__def) window.__def = document.getElementById('product').innerHTML;
      document.getElementById('product').innerHTML = v.svg || window.__def;
      document.querySelector('.placeholder').style.background = `radial-gradient(circle at 25% 30%, rgba(255,230,190,.3) 0 4%, transparent 15%), radial-gradient(circle at 70% 65%, rgba(255,255,255,.12) 0 6%, transparent 24%), linear-gradient(160deg, ${v.bg}, #15130f)`;
    }, { v, r });
    await p.waitForTimeout(200);
    await p.locator('#ad').screenshot({ path: `${OUT}/${v.id}-${r ? '9x16' : '16x9'}.png` });
  }
  await b.close();
})();
