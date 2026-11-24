/* Canvas renderers that run in the panel: callout boxes and the phone frame.
   Output: full-frame transparent PNGs (placed in Premiere at Scale 100, centred = exact). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VEKRenderers = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var LIME = '#F5FA5E', PURPLE = '#715BE4';

  function canvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  function fileURL(p) { return 'file://' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F'); }
  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Could not load image ' + src)); };
      img.src = /^(file|data|https?):/.test(src) ? src : fileURL(src);
    });
  }
  function save(c, out, nodeRequire) {
    var data = c.toDataURL('image/png').split(',')[1];
    if (nodeRequire) { nodeRequire('fs').writeFileSync(out, Buffer.from(data, 'base64')); return out; }
    return 'data:image/png;base64,' + data;
  }

  function wrap(ctx, text, maxW) {
    var words = String(text).split(/\s+/), lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var t = cur ? cur + ' ' + words[i] : words[i];
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = words[i]; } else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // style: 'white' (white box, black text) | 'black' (black box, white text) | 'brand' (brand colour, white text)
  function drawCallout(opts) {
    var f = opts.frame, k = f.w / 1080;
    var c = canvas(f.w, f.h), ctx = c.getContext('2d');
    var size = Math.round(62 * k), pad = Math.round(34 * k), radius = Math.round(26 * k);
    ctx.font = 'bold ' + size + 'px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    var lines = wrap(ctx, opts.text, f.w * 0.78 - 2 * pad);
    var lh = Math.round(size * 1.22);
    var w = 0; for (var i = 0; i < lines.length; i++) w = Math.max(w, ctx.measureText(lines[i]).width);
    var bw = Math.round(w + 2 * pad), bh = Math.round(lines.length * lh + 2 * pad * 0.8);
    var x = Math.round((f.w - bw) / 2), y = Math.round(f.h * (opts.topPct || 0.15));
    var bg = opts.style === 'black' ? '#000000' : opts.style === 'brand' ? (opts.brandColor || PURPLE) : '#FFFFFF';
    var fg = opts.style === 'white' || !opts.style ? '#000000' : '#FFFFFF';
    ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = Math.round(18 * k); ctx.shadowOffsetY = Math.round(6 * k);
    rr(ctx, x, y, bw, bh, radius); ctx.fillStyle = bg; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = fg; ctx.textAlign = 'center';
    for (var j = 0; j < lines.length; j++) ctx.fillText(lines[j], f.w / 2, y + pad * 0.8 + lh * (j + 0.5));
    return c;
  }

  // Phone: rounded black body, thin bezel, dynamic-island pill, soft shadow. Screenshot drawn inside
  // (cover, focusY band); without a screenshot the screen area is left transparent for a recording underneath.
  function drawPhone(opts, img) {
    var f = opts.frame, g = opts.geometry, b = g.body, h = g.hole, isl = g.island;
    var c = canvas(f.w, f.h), ctx = c.getContext('2d');
    // soft shadow
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = g.shadow; ctx.shadowOffsetY = Math.round(g.shadow * 0.35);
    rr(ctx, b.x, b.y, b.w, b.h, b.r); ctx.fillStyle = '#0b0b0d'; ctx.fill(); ctx.restore();
    // thin bezel highlight
    rr(ctx, b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3, b.r - 1.5); ctx.lineWidth = Math.max(2, b.w * 0.004); ctx.strokeStyle = '#3a3a40'; ctx.stroke();
    // screen
    ctx.save(); rr(ctx, h.x, h.y, h.w, h.h, h.r); ctx.clip();
    if (img) {
      var s = Math.max(h.w / img.naturalWidth, h.h / img.naturalHeight);
      var dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      var fy = opts.focusY == null ? 0 : opts.focusY; // phone shows the top of a screenshot by default
      var dy = h.y - Math.max(0, Math.min(dh - h.h, fy * dh - h.h / 2));
      ctx.drawImage(img, h.x + (h.w - dw) / 2, dy, dw, dh);
    } else {
      ctx.clearRect(h.x, h.y, h.w, h.h); // transparent hole for the recording on the track below
    }
    ctx.restore();
    // dynamic island
    rr(ctx, isl.x, isl.y, isl.w, isl.h, isl.h / 2); ctx.fillStyle = '#000'; ctx.fill();
    return c;
  }

  function makeRenderers(nodeRequire) {
    return {
      renderCallout: function (opts) { return Promise.resolve(save(drawCallout(opts), opts.out, nodeRequire)); },
      renderPhone: function (opts) {
        var p = opts.screenshot ? loadImage(opts.screenshot) : Promise.resolve(null);
        return p.then(function (img) { return save(drawPhone(opts, img), opts.out, nodeRequire); });
      },
    };
  }
  return { makeRenderers: makeRenderers, drawCallout: drawCallout, drawPhone: drawPhone, loadImage: loadImage, LIME: LIME, PURPLE: PURPLE };
});
