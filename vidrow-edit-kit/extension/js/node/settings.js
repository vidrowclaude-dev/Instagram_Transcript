'use strict';
// Settings live only on this Mac: ~/Library/Application Support/Vidrow Edit Kit/settings.json (mode 600).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DEFAULT_OUTPUT } = require('./util');

const DIR = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Vidrow Edit Kit')
  : path.join(os.homedir(), '.vidrow-edit-kit');
const FILE = path.join(DIR, 'settings.json');

const DEFAULTS = {
  anthropicKey: '', defaultModel: 'claude-opus-5-5', defaultEffort: 'high',
  transcriber: 'openai', openaiKey: '', whisperCppBin: '', whisperCppModel: '',
  language: 'hinglish', figmaToken: '', googleKey: '', ytdlpPath: '', ffmpegPath: '',
  browserCookies: 'off', outputFolder: DEFAULT_OUTPUT, presetPath: '', autoStartQueue: true,
};

function load(file) {
  try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(file || FILE, 'utf8'))); } catch (e) { return Object.assign({}, DEFAULTS); }
}
function save(s, file) {
  const f = file || FILE;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(Object.assign({}, DEFAULTS, s), null, 2), { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch (e) { /* ignore */ }
  return f;
}
module.exports = { load, save, DEFAULTS, FILE };
