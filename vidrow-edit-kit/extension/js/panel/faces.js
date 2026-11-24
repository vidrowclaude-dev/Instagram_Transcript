/* Offline face detection in the panel with @vladmandic/face-api (bundled in lib/faceapi).
   - The library is evaluated with Node globals hidden (new Function('require','module','exports','process','define', code))
     so it picks its browser build inside CEP's mixed Node/browser context.
   - Weights are read from disk and decoded with tf.io.decodeWeights (no fetch).
   - SSD MobileNet first, Tiny Face Detector as a second opinion. */
(function (root, factory) {
  // CEP's mixed Node/browser context defines a global `module`, so always attach to window too.
  var api = factory();
  if (typeof window !== 'undefined') window.VEKFaces = api; else if (root) root.VEKFaces = api;
  if (typeof module === 'object' && module && module.exports && typeof window === 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
  var api = null, loading = null;

  // Core loader, independent of fs: code string + {name: {manifest, bytes(Uint8Array)}}
  function loadFromSources(code, models) {
    var factory = new Function('require', 'module', 'exports', 'process', 'define', code + '\n;return typeof faceapi !== "undefined" ? faceapi : this.faceapi;');
    var fa = factory.call(typeof window !== 'undefined' ? window : {}, undefined, undefined, undefined, undefined, undefined);
    var tf = fa.tf;
    var setBackend = (tf.setBackend ? tf.setBackend('webgl') : Promise.resolve(false));
    return Promise.resolve(setBackend).catch(function () { return false; }).then(function (ok) {
      if (!ok && tf.setBackend) return tf.setBackend('cpu');
    }).then(function () { return tf.ready(); }).then(function () {
      var map = { ssd_mobilenetv1: fa.nets.ssdMobilenetv1, tiny_face_detector: fa.nets.tinyFaceDetector };
      Object.keys(models).forEach(function (name) {
        var m = models[name];
        var specs = []; m.manifest.forEach(function (grp) { specs = specs.concat(grp.weights); });
        var bytes = m.bytes;
        var weightMap = tf.io.decodeWeights(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), specs);
        map[name].loadFromWeightMap(weightMap);
      });
      return fa;
    });
  }

  function load(extRoot, nodeRequire) {
    if (api) return Promise.resolve(api);
    if (loading) return loading;
    var fs = nodeRequire('fs'), path = nodeRequire('path');
    var dir = path.join(extRoot, 'lib', 'faceapi');
    var code = fs.readFileSync(path.join(dir, 'face-api.js'), 'utf8');
    var models = {};
    ['ssd_mobilenetv1', 'tiny_face_detector'].forEach(function (n) {
      var manifest = JSON.parse(fs.readFileSync(path.join(dir, 'model', n + '_model-weights_manifest.json'), 'utf8'));
      var buffers = [];
      manifest.forEach(function (grp) { grp.paths.forEach(function (p) { buffers.push(fs.readFileSync(path.join(dir, 'model', p))); }); });
      var all = Buffer.concat(buffers);
      models[n] = { manifest: manifest, bytes: new Uint8Array(all.buffer, all.byteOffset, all.byteLength) };
    });
    loading = loadFromSources(code, models).then(function (fa) { api = fa; return fa; });
    return loading;
  }

  function loadImg(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('cannot load ' + src)); };
      img.src = /^(file|data|https?):/.test(src) ? src : 'file://' + encodeURI(src).replace(/#/g, '%23');
    });
  }

  // Returns detections per frame, normalised: [[{x,y,w,h,score}], ...]
  function detectFrames(fa, sources) {
    var out = [];
    var chain = Promise.resolve();
    sources.forEach(function (src) {
      chain = chain.then(function () { return loadImg(src); }).then(function (img) {
        var W = img.naturalWidth, H = img.naturalHeight;
        return fa.detectAllFaces(img, new fa.SsdMobilenetv1Options({ minConfidence: 0.4 })).then(function (dets) {
          if (dets && dets.length) return dets;
          return fa.detectAllFaces(img, new fa.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.45 }));
        }).then(function (dets) {
          out.push((dets || []).map(function (d) { var b = d.box; return { x: b.x / W, y: b.y / H, w: b.width / W, h: b.height / H, score: d.score }; }));
        });
      }).catch(function () { out.push([]); });
    });
    return chain.then(function () { return out; });
  }

  return { load: load, loadFromSources: loadFromSources, detectFrames: detectFrames };
});
