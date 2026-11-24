/* Rich paste from Google Docs → plain script text.
   Hyperlinks become "text [LINK: url]"; yellow-highlighted (or yellow) text becomes "[CALLOUT: text]". */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VEKPaste = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var BLOCK = /^(P|DIV|LI|H[1-6]|TR|BR|UL|OL|TABLE|BLOCKQUOTE|SECTION)$/;

  function parseColor(c) {
    if (!c) return null;
    c = String(c).trim().toLowerCase();
    var m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
    if (m) {
      var h = m[1].length === 3 ? m[1].replace(/(.)/g, '$1$1') : m[1];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
    }
    m = c.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)$/);
    if (m) return [+m[1], +m[2], +m[3], m[4] == null ? 1 : +m[4]];
    if (c === 'yellow') return [255, 255, 0, 1];
    return null;
  }
  function isYellow(c) {
    var v = parseColor(c);
    return !!v && v[3] > 0.2 && v[0] >= 200 && v[1] >= 180 && v[2] <= 140;
  }
  function isCallout(el) {
    if (!el || !el.style) return false;
    return isYellow(el.style.backgroundColor) || isYellow(el.style.background) || isYellow(el.style.color) || (el.tagName === 'MARK');
  }

  function convert(rootNode) {
    var out = [];
    function nl() {
      var last = out.length ? out[out.length - 1] : '\n';
      if (last.charAt(last.length - 1) !== '\n') out.push('\n');
    }
    function walk(node, inCallout) {
      if (node.nodeType === 3) { out.push(node.nodeValue.replace(/\u00a0/g, ' ')); return; }
      if (node.nodeType !== 1) return;
      var tag = node.tagName;
      if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'META') return;
      if (tag === 'BR') { out.push('\n'); return; }
      var block = BLOCK.test(tag);
      if (block) nl();
      if (tag === 'A' && node.getAttribute('href')) {
        var t = node.textContent.replace(/\u00a0/g, ' ');
        var href = node.getAttribute('href');
        // Google wraps links in a redirect: https://www.google.com/url?q=REAL&...
        var gm = href.match(/^https?:\/\/www\.google\.com\/url\?q=([^&]+)/);
        if (gm) href = decodeURIComponent(gm[1]);
        out.push(t + ' [LINK: ' + href + ']');
        if (block) nl();
        return;
      }
      if (!inCallout && isCallout(node) && node.textContent.trim()) {
        out.push('[CALLOUT: ' + node.textContent.replace(/\s+/g, ' ').trim() + ']');
        if (block) nl();
        return;
      }
      for (var i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i], inCallout);
      if (block) nl();
    }
    walk(rootNode, false);
    return out.join('')
      .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
      .replace(/\]\s*\[CALLOUT:/g, '] [CALLOUT:')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  function htmlToScript(html, doc) {
    doc = doc || (typeof DOMParser !== 'undefined' ? new DOMParser().parseFromString(html, 'text/html') : null);
    if (!doc) return html;
    return convert(doc.body);
  }

  // Attach to a textarea: rich clipboard HTML is converted and inserted at the caret.
  function attach(textarea, onChange) {
    textarea.addEventListener('paste', function (e) {
      var html = e.clipboardData && e.clipboardData.getData('text/html');
      if (!html) return;
      e.preventDefault();
      var txt = htmlToScript(html);
      var s = textarea.selectionStart, en = textarea.selectionEnd, v = textarea.value;
      textarea.value = v.slice(0, s) + txt + v.slice(en);
      textarea.selectionStart = textarea.selectionEnd = s + txt.length;
      if (onChange) onChange();
    });
  }
  return { htmlToScript: htmlToScript, attach: attach, isYellow: isYellow };
});
