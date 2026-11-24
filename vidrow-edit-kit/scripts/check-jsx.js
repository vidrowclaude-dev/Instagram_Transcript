#!/usr/bin/env node
// host.jsx must be ES3 (ExtendScript). acorn --ecma3 catches syntax; this also catches ES5+ runtime methods.
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const file = path.join(__dirname, '..', 'extension', 'jsx', 'host.jsx');
const src = fs.readFileSync(file, 'utf8');
try { acorn.parse(src, { ecmaVersion: 3 }); } catch (e) { console.error(`host.jsx is not ES3: ${e.message}`); process.exit(1); }
const banned = [/\.forEach\(/, /\.map\(/, /\.filter\(/, /\.reduce\(/, /\.some\(/, /\.every\(/, /\.indexOf\(/, /\.trim\(/, /\bJSON\./, /\.find\(/, /Object\.keys/, /Array\.isArray/, /\.bind\(/];
const lines = src.split('\n');
let bad = 0;
lines.forEach((l, i) => {
  const code = /^\s*(\*|\/\*)/.test(l) ? '' : l.replace(/\/\/.*$/, '');
  for (const re of banned) if (re.test(code)) { console.error(`host.jsx:${i + 1}: ES5+ method not available in ExtendScript: ${l.trim()}`); bad++; }
});
if (bad) process.exit(1);
console.log('host.jsx: ES3 OK');
