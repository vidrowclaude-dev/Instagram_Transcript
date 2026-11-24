/* Minimal CEP host wrapper (replaces Adobe's CSInterface.js for what this panel needs).
   Works in a plain browser too (for UI previews): host calls then report "not connected". */
(function () {
  var cep = window.__adobe_cep__;
  var inCEP = !!cep;
  var nodeRequire = (window.cep_node && window.cep_node.require) || (typeof window.require === 'function' ? window.require : null);

  function systemPath(type) {
    var p = '';
    try { if (inCEP) p = decodeURI(cep.getSystemPath(type) || ''); } catch (e) { p = ''; }
    p = p.replace(/^file:\/\/\/?/, '/').replace(/^\/([A-Za-z]:)/, '$1');
    // fallback: the folder index.html was loaded from
    if (!p && type === 'extension' && location.protocol === 'file:') p = decodeURI(location.pathname).replace(/\/[^\/]*$/, '');
    return p;
  }

  window.VEKHost = {
    inCEP: inCEP,
    node: nodeRequire,
    extensionPath: function () { return systemPath('extension'); },
    evalScript: function (script, cb) {
      if (!inCEP) { setTimeout(function () { cb('EvalScript error.'); }, 0); return; }
      cep.evalScript(script, cb || function () {});
    },
    openURL: function (url) {
      try { if (window.cep && window.cep.util) return window.cep.util.openURLInDefaultBrowser(url); } catch (e) { }
      window.open(url, '_blank');
    },
    // native file dialogs (CEP); returns array of paths or null if unavailable
    pick: function (opts) {
      if (!window.cep || !window.cep.fs || !window.cep.fs.showOpenDialogEx) return null;
      var r = window.cep.fs.showOpenDialogEx(!!opts.multiple, !!opts.folder, opts.title || '', opts.initial || '', opts.types || []);
      return (r && r.data) ? r.data : [];
    },
  };
})();
