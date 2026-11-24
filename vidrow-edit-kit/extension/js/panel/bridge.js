/* Panel ⇄ ExtendScript bridge helpers (UMD: used in the panel and in Node tests). */
(function (root, factory) {
  // CEP's mixed Node/browser context defines a global `module`, so always attach to window too.
  var api = factory();
  if (typeof window !== 'undefined') window.VEKBridge = api; else if (root) root.VEKBridge = api;
  if (typeof module === 'object' && module && module.exports && typeof window === 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Turn an object into a JS string literal for evalScript: JSON text, then quoted, with every
  // non-ASCII character escaped as \uXXXX so ExtendScript's parser never sees raw UTF-8.
  function toArg(obj) {
    var json = typeof obj === 'string' ? obj : JSON.stringify(obj);
    var lit = JSON.stringify(json);
    return lit.replace(/[\u007f-\uffff]/g, function (c) { return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4); });
  }
  function call(cs, fn, obj) {
    return new Promise(function (resolve, reject) {
      var code = 'VEK.' + fn + '(' + (obj === undefined ? '' : toArg(obj)) + ')';
      cs.evalScript(code, function (res) {
        if (res === 'EvalScript error.' || res === undefined || res === null) return reject(new Error('Premiere did not answer (' + fn + '). Is host.jsx loaded?'));
        try { resolve(JSON.parse(res)); } catch (e) { reject(new Error('Bad reply from Premiere: ' + String(res).slice(0, 200))); }
      });
    });
  }
  return { toArg: toArg, call: call };
});
