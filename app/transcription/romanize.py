"""Devanagari -> casual romanised Hinglish ("karna hai", not "karanā hai").

Rule-based, no network, no model:
  * consonant + inherent vowel, with Hindi schwa deletion (word-final, and V C _ C V medially)
  * long vowels written double only in closed one-syllable words (baat, teen, doodh)
  * a small dictionary for the most common words, written the way people type them
Latin text (English words in Hinglish speech) passes through unchanged.
"""
from __future__ import annotations

import re

VIRAMA = "्"
NUKTA = "़"
ANUSVARA = "ं"
CHANDRABINDU = "ँ"
VISARGA = "ः"

CONSONANTS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n",
    "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
    "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
    "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
    "ष": "sh", "स": "s", "ह": "h", "ळ": "l",
    # precomposed nukta forms
    "क़": "q", "ख़": "kh", "ग़": "gh", "ज़": "z", "ड़": "r",
    "ढ़": "rh", "फ़": "f", "य़": "y",
}
NUKTA_MAP = {"k": "q", "kh": "kh", "g": "gh", "j": "z", "d": "d", "dh": "dh", "ph": "f", "y": "y"}  # ड़ -> d, as typed in Hinglish

# (short form, long form) for matras / independent vowels
MATRAS = {
    "ा": ("a", "aa"),  # ा
    "ि": ("i", "i"),   # ि
    "ी": ("i", "ee"),  # ी
    "ु": ("u", "u"),   # ु
    "ू": ("u", "oo"),  # ू
    "ृ": ("ri", "ri"),  # ृ
    "े": ("e", "e"),   # े
    "ै": ("ai", "ai"),  # ै
    "ो": ("o", "o"),   # ो
    "ौ": ("au", "au"),  # ौ
    "ॅ": ("e", "e"),   # ॅ
    "ॉ": ("o", "o"),   # ॉ
}
INDEPENDENT = {
    "अ": ("a", "a"), "आ": ("a", "aa"), "इ": ("i", "i"), "ई": ("i", "ee"),
    "उ": ("u", "u"), "ऊ": ("u", "oo"), "ऋ": ("ri", "ri"), "ए": ("e", "e"),
    "ऐ": ("ai", "ai"), "ओ": ("o", "o"), "औ": ("au", "au"), "ऑ": ("o", "o"), "ऍ": ("e", "e"),
}
DIGITS = {chr(0x0966 + i): str(i) for i in range(10)}
PUNCT = {"।": ".", "॥": "."}

COMMON = {
    "है": "hai", "हैं": "hain", "में": "mein", "नहीं": "nahi", "नही": "nahi", "और": "aur",
    "क्या": "kya", "यह": "yeh", "वह": "woh", "ये": "ye", "वो": "wo", "भी": "bhi", "तो": "toh",
    "हो": "ho", "ही": "hi", "की": "ki", "के": "ke", "का": "ka", "को": "ko", "से": "se", "पर": "par",
    "मैं": "main", "हम": "hum", "तुम": "tum", "आप": "aap", "कुछ": "kuch", "सब": "sab", "अब": "ab",
    "जब": "jab", "तब": "tab", "कब": "kab", "क्यों": "kyon", "कैसे": "kaise", "ऐसे": "aise",
    "बहुत": "bahut", "था": "tha", "थी": "thi", "थे": "the", "हूँ": "hoon", "हूं": "hoon",
    "एक": "ek", "दो": "do", "तीन": "teen", "चार": "char", "पांच": "paanch", "पाँच": "paanch",
    "लिए": "liye", "किया": "kiya", "दिया": "diya", "गया": "gaya", "रहा": "raha", "रही": "rahi",
    "रहे": "rahe", "सकते": "sakte", "चाहिए": "chahiye", "अपना": "apna", "अपने": "apne",
    "पैसा": "paisa", "पैसे": "paise", "यार": "yaar", "ठीक": "theek", "मत": "mat", "हाँ": "haan", "हां": "haan",
}

INHERENT = "INH"
_DEV = re.compile(r"[ऀ-ॿ]+")
_LABIALS = {"p", "ph", "b", "bh", "m", "f"}


class _Unit:
    __slots__ = ("cons", "vowel", "long", "nasal", "visarga", "independent")

    def __init__(self, cons: str = "", vowel: object = INHERENT, long: str | None = None):
        self.cons = cons
        self.vowel = vowel          # INHERENT | None (virama) | short string
        self.long = long            # long spelling (used for closed monosyllables)
        self.nasal = ""             # "n" / "m" from anusvara/chandrabindu
        self.visarga = False
        self.independent = False


def _units(word: str) -> list[_Unit]:
    units: list[_Unit] = []
    for ch in word:
        if ch in CONSONANTS:
            units.append(_Unit(CONSONANTS[ch]))
        elif ch == NUKTA and units:
            units[-1].cons = NUKTA_MAP.get(units[-1].cons, units[-1].cons)
        elif ch == VIRAMA and units:
            units[-1].vowel = None
        elif ch in MATRAS and units:
            short, long = MATRAS[ch]
            units[-1].vowel, units[-1].long = short, long
        elif ch in INDEPENDENT:
            short, long = INDEPENDENT[ch]
            u = _Unit("", short, long)
            u.independent = True
            units.append(u)
        elif ch in (ANUSVARA, CHANDRABINDU) and units:
            units[-1].nasal = "n"
        elif ch == VISARGA and units:
            units[-1].visarga = True
    return units


def _has_vowel(u: _Unit) -> bool:
    return u.vowel is not None


def _romanize_word(word: str) -> str:
    if word in COMMON:
        return COMMON[word]
    units = _units(word)
    if not units:
        return word
    n = len(units)

    # 1) word-final schwa deletion (keep for one-letter words like न)
    last = units[-1]
    if n > 1 and last.vowel == INHERENT and not last.nasal and not last.independent:
        last.vowel = None

    # 2) medial schwa deletion, right to left: V C [a] C V  ->  V C C V
    for i in range(n - 2, 0, -1):
        u, prev, nxt = units[i], units[i - 1], units[i + 1]
        if u.vowel != INHERENT or u.nasal or u.independent:
            continue
        if prev.nasal:  # कंपनी: kam-pa-ni, the previous syllable is already closed
            continue
        if _has_vowel(prev) and nxt.cons and _has_vowel(nxt):
            u.vowel = None

    # 3) one closed syllable (e.g. baat, teen, doodh) gets the long spelling
    voiced = [u for u in units if _has_vowel(u)]
    closed_mono = len(voiced) == 1 and not _has_vowel(units[-1])

    out: list[str] = []
    for i, u in enumerate(units):
        out.append(u.cons)
        if u.vowel is None:
            continue
        if u.vowel == INHERENT:
            v = "a"
        else:
            v = u.long if (closed_mono and u.long) else u.vowel  # type: ignore[assignment]
        out.append(v)
        if u.nasal:
            nxt = units[i + 1] if i + 1 < n else None
            if v == "e" and i == n - 1:
                out[-1] = "ei"  # में -> mein, कें -> kein
            out.append("m" if nxt is not None and nxt.cons in _LABIALS else "n")
        if u.visarga:
            out.append("h")
    return "".join(out)


def romanize(text: str) -> str:
    """Romanise every Devanagari run in `text`; leave everything else untouched."""
    if not text:
        return text
    for k, v in {**DIGITS, **PUNCT}.items():
        text = text.replace(k, v)
    return _DEV.sub(lambda m: _romanize_word(m.group(0)), text)


def has_devanagari(text: str) -> bool:
    return bool(_DEV.search(text or ""))
