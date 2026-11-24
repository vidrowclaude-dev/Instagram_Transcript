'use strict';
// Script parsing, text normalisation, filler / director-talk detection, script coverage.

const SECTION_RE = /^\s*(?:#+\s*)?(?:\*\*)?\s*(hook\s*[-#]?\s*([123])|h\s*([123])|body)\b\s*(?:\*\*)?\s*[:\-–—.)]?\s*(.*)$/i;

function sectionName(m) {
  if (/^body/i.test(m[1])) return 'BODY';
  return 'H' + (m[2] || m[3]);
}

// Parse the pasted script into sections H1/H2/H3/BODY with spoken lines, links and callouts.
function parseScript(text) {
  const sections = { H1: [], H2: [], H3: [], BODY: [] };
  const links = []; const callouts = [];
  let cur = null;
  const pendingCallouts = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    const m = line.match(SECTION_RE);
    if (m) { cur = sectionName(m); line = (m[4] || '').trim(); if (!line) continue; }
    if (!cur) cur = 'BODY';
    const lineLinks = [];
    line = line.replace(/\[LINK:\s*([^\]]+)\]/gi, (_, url) => { lineLinks.push(url.trim()); return ''; });
    const lineCallouts = [];
    line = line.replace(/\[CALLOUT:\s*([^\]]+)\]/gi, (_, t) => { lineCallouts.push(t.trim()); return ''; });
    const spoken = line.replace(/\s+/g, ' ').replace(/^\d+[.)]\s*/, '').trim();
    const idx = sections[cur].length;
    if (spoken && /[\p{L}\p{N}]/u.test(spoken)) {
      sections[cur].push({ section: cur, idx, text: spoken });
      for (const c of pendingCallouts.splice(0)) callouts.push({ section: c.section, line: idx, text: c.text });
      lineCallouts.forEach((t) => callouts.push({ section: cur, line: idx, text: t }));
      lineLinks.forEach((u) => links.push({ section: cur, line: idx, url: u }));
    } else {
      // callout/link on its own line: attach to the next spoken line of this section
      lineCallouts.forEach((t) => pendingCallouts.push({ section: cur, text: t }));
      lineLinks.forEach((u) => links.push({ section: cur, line: Math.max(0, idx), url: u }));
    }
  }
  for (const c of pendingCallouts) callouts.push({ section: c.section, line: Math.max(0, sections[c.section].length - 1), text: c.text });
  return { sections, links, callouts };
}

function norm(w) {
  return String(w || '').toLowerCase().normalize('NFC')
    .replace(/[।॥]/g, '') // Devanagari danda
    .replace(/[^\p{L}\p{N}\p{M}']+/gu, '').replace(/'/g, '');
}
function tokens(text) { return String(text || '').split(/\s+/).map(norm).filter(Boolean); }

const FILLERS = new Set(['um', 'umm', 'ummm', 'uh', 'uhh', 'uhhh', 'uhm', 'uhmm', 'hmm', 'hmmm', 'hm', 'mm', 'mmm', 'mhm', 'er', 'erm', 'eh',
  'उम्म', 'उम', 'अम्म', 'हम्म', 'हम्मम', 'उह', 'ह्म्म', 'म्म']);
const STRAY = new Set(['okay', 'ok', 'okk', 'okayy', 'ओके', 'ओक़े', 'alright']);
const DIRECTOR_WORDS = new Set(['action', 'cut', 'rolling', 'speed', 'एक्शन', 'कट', 'रोलिंग']);
const DIRECTOR_PHRASES = [
  ['one', 'more'], ['once', 'more'], ['phir', 'se'], ['fir', 'se'], ['ek', 'aur'], ['ek', 'baar', 'aur'], ['from', 'the', 'top'],
  ['one', 'more', 'time'], ['take', 'two'], ['retake'], ['फिर', 'से'], ['एक', 'और'], ['वन', 'मोर'], ['एक', 'बार', 'और'],
];
// Ambiguous Hindi sounds that are NOT fillers: आ, अ, aa (they are often real words / vowels).

// Mark which words to drop. scriptTokens: Set of normalised script words (whole script).
// scriptText: normalised full script string (for phrase checks).
function markFillers(words, scriptTokens, scriptText) {
  const n = words.map((w) => norm(w.w));
  const drop = new Array(words.length).fill(false);
  const reason = new Array(words.length).fill('');
  for (let i = 0; i < n.length; i++) {
    const t = n[i];
    if (!t) { drop[i] = true; reason[i] = 'empty'; continue; }
    if (FILLERS.has(t) || /^u+m+$|^h+m+$|^u+h+$|^m{2,}$/.test(t)) { drop[i] = true; reason[i] = 'filler'; continue; }
    if (STRAY.has(t) && !scriptTokens.has(t)) { drop[i] = true; reason[i] = 'filler'; continue; }
    if (DIRECTOR_WORDS.has(t) && !scriptTokens.has(t)) { drop[i] = true; reason[i] = 'director'; continue; }
  }
  for (const ph of DIRECTOR_PHRASES) {
    const phStr = ph.join(' ');
    if (scriptText && (' ' + scriptText + ' ').includes(' ' + phStr + ' ')) continue;
    for (let i = 0; i + ph.length <= n.length; i++) {
      let ok = true;
      for (let k = 0; k < ph.length; k++) if (n[i + k] !== ph[k]) { ok = false; break; }
      if (ok) for (let k = 0; k < ph.length; k++) { drop[i + k] = true; reason[i + k] = 'director'; }
    }
  }
  return { drop, reason };
}

// Fraction of words (normalised) that appear in the script.
function scriptMatchRatio(words, scriptTokens) {
  const n = words.map((w) => norm(w.w)).filter(Boolean);
  if (!n.length) return 0;
  return n.filter((t) => scriptTokens.has(t)).length / n.length;
}

// Token overlap of a script line with a body of text (recall of the script line's tokens).
function coverage(lineText, textTokensSet) {
  const t = tokens(lineText);
  if (!t.length) return 1;
  return t.filter((x) => textTokensSet.has(x)).length / t.length;
}

// Latin transliteration-ish loose match for names (Bachatt ~ bachat, "app" ~ ऐप/एप).
function looseKey(s) {
  return norm(s).replace(/(.)\1+/g, '$1').replace(/[aeiou]/g, '');
}

module.exports = { parseScript, norm, tokens, markFillers, scriptMatchRatio, coverage, looseKey, FILLERS, DIRECTOR_PHRASES };
