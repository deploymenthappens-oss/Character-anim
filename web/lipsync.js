/*
 * lipsync.js - text -> mouth shapes (English + Arabic), aligned to the REAL voice audio.
 * Works in the browser (window.Lipsync) and in Node (require) so it can be unit-tested.
 *
 * The rig's mouth ids (checked by rendering every one of them on the character):
 *   0 rest (closed, small smile)        7  B M P  - lips pressed together
 *   1 A E I   - wide open "ah"          8  F V    - upper teeth on the lower lip
 *   2 L       - tongue tip up           9  EE     - lips spread, medium open
 *   3 Q W     - small pursed circle    10  O      - tall rounded oval
 *   4 TH      - tongue between teeth   11  U      - round, slightly smaller oval
 *   5 N       - teeth together         12  Ch J Sh- wide, teeth showing, lips pushed out
 *   6 C D G K R S T ... - neutral half-open consonant mouth
 *
 * Pipeline:
 *   parseText()   text -> phrases -> words -> units {v, w, ph, ch}   (v = mouth id, w = relative duration)
 *   analyze()     audio samples -> voiced/silent frames + a "voiced clock"
 *   makePlan()    puts the units on the audio: per word if the TTS gave word timings, otherwise phrase
 *                 by phrase, anchored on the real pauses of the audio. Then refine() keeps every closure
 *                 and rounding visible for long enough to be seen, and shifts the lips a little ahead of
 *                 the sound the way real lips lead.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Lipsync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ tunables
  const CONFIG = {
    lead: 0.035,          // s: the mouth moves this much BEFORE the sound (lips lead the voice)
    minHold: 0.058,       // s: shortest time any mouth shape stays (a shorter one is never seen at 30 fps)
    gapClose: 0.11,       // s: a silence at least this long closes the mouth; shorter ones hold the last shape
    anchorGap: 0.09,      // s: a pause at least this long may be used as a phrase boundary anchor
    anchorWindow: 0.20,   // how far (fraction of the speech) a phrase boundary may sit from where the text says
    linger: 0.35,         // loud (stressed) frames advance the voiced clock a little slower: the mouth lingers there
    edgeMaxShift: 0.30,   // s: largest correction applied to the TTS word timestamps
  };

  const VISEMES = [
    { id: 0,  label: 'Rest',       look: 'lips closed, small smile' },
    { id: 1,  label: 'A / E / I',  look: 'wide open "ah"' },
    { id: 2,  label: 'L',          look: 'tongue tip raised behind the upper teeth' },
    { id: 3,  label: 'W / Q',      look: 'small pursed circle' },
    { id: 4,  label: 'TH',         look: 'tongue between the teeth' },
    { id: 5,  label: 'N / S',      look: 'teeth together, lips apart' },
    { id: 6,  label: 'T D K R ...', look: 'neutral half-open consonant mouth' },
    { id: 7,  label: 'B / M / P',  look: 'lips pressed together' },
    { id: 8,  label: 'F / V',      look: 'upper teeth on the lower lip' },
    { id: 9,  label: 'EE',         look: 'lips spread, medium open' },
    { id: 10, label: 'O',          look: 'tall rounded oval' },
    { id: 11, label: 'U',          look: 'round oval, slightly smaller' },
    { id: 12, label: 'Ch / J / Sh', look: 'wide, teeth showing, lips pushed out' },
  ];

  // Which shapes must never be lost when they are very short (a closure you cannot see is a lip-sync error).
  const PRIORITY = { 0: 0, 5: 1, 6: 1, 1: 2, 9: 2, 2: 3, 4: 3, 3: 4, 10: 4, 11: 4, 12: 4, 7: 5, 8: 5 };
  const isVowelViseme = v => v === 1 || v === 9 || v === 10 || v === 11;

  // ------------------------------------------------------------------ Arabic
  // For every letter: IPA sound, where it is made, the mouth id and a relative length, and a note.
  // MSA sound values (Standard Arabic phonology); dialect overrides are in DIALECT below.
  //   v : mouth id     w : relative duration of the consonant
  const AR_LETTERS = {
    'ب': { name: 'baa',   ipa: 'b',  place: 'bilabial',            v: 7,  w: 0.62, note: 'lips pressed together' },
    'م': { name: 'miim',  ipa: 'm',  place: 'bilabial (nasal)',    v: 7,  w: 0.80, note: 'lips pressed together, held a little longer than b' },
    'ف': { name: 'faa',   ipa: 'f',  place: 'labiodental',         v: 8,  w: 0.90, note: 'upper teeth touch the lower lip' },
    'ث': { name: 'thaa',  ipa: 'θ',  place: 'interdental',         v: 4,  w: 0.95, note: 'tongue tip between the teeth' },
    'ذ': { name: 'dhaal', ipa: 'ð',  place: 'interdental',         v: 4,  w: 0.85, note: 'tongue tip between the teeth' },
    'ظ': { name: 'DHaa',  ipa: 'ðˤ', place: 'interdental, emphatic', v: 4, w: 0.90, note: 'tongue between the teeth; neighbouring vowels open and back', emph: true },
    'ت': { name: 'taa',   ipa: 't',  place: 'dental stop',         v: 6,  w: 0.60, note: 'neutral mouth, tongue behind the teeth' },
    'د': { name: 'daal',  ipa: 'd',  place: 'dental stop',         v: 6,  w: 0.60, note: 'neutral mouth, tongue behind the teeth' },
    'ط': { name: 'Taa',   ipa: 'tˤ', place: 'dental stop, emphatic', v: 6, w: 0.68, note: 'neutral mouth; neighbouring vowels open and back', emph: true },
    'ض': { name: 'Daad',  ipa: 'dˤ', place: 'dental stop, emphatic', v: 6, w: 0.68, note: 'neutral mouth; neighbouring vowels open and back', emph: true },
    'س': { name: 'siin',  ipa: 's',  place: 'alveolar sibilant',   v: 5,  w: 0.90, note: 'teeth together, lips spread' },
    'ز': { name: 'zaay',  ipa: 'z',  place: 'alveolar sibilant',   v: 5,  w: 0.85, note: 'teeth together, lips spread' },
    'ص': { name: 'Saad',  ipa: 'sˤ', place: 'alveolar sibilant, emphatic', v: 5, w: 0.95, note: 'teeth together; neighbouring vowels open and back', emph: true },
    'ن': { name: 'nuun',  ipa: 'n',  place: 'alveolar nasal',      v: 5,  w: 0.72, note: 'teeth together' },
    'ل': { name: 'laam',  ipa: 'l',  place: 'alveolar lateral',    v: 2,  w: 0.70, note: 'tongue tip visible behind the upper teeth' },
    'ر': { name: 'raa',   ipa: 'r',  place: 'alveolar trill',      v: 6,  w: 0.62, note: 'neutral mouth, tongue tip flutters' },
    'ش': { name: 'shiin', ipa: 'ʃ',  place: 'post-alveolar',       v: 12, w: 1.00, note: 'lips pushed out, teeth showing' },
    'ج': { name: 'jiim',  ipa: 'dʒ', place: 'post-alveolar affricate', v: 12, w: 0.85, note: 'as sh; in Egyptian speech it is a hard g (neutral mouth)' },
    'ي': { name: 'yaa',   ipa: 'j',  place: 'palatal glide / long ii', v: 9, w: 0.70, note: 'lips spread' },
    'ك': { name: 'kaaf',  ipa: 'k',  place: 'velar stop',          v: 6,  w: 0.62, note: 'neutral mouth, back of tongue' },
    'ق': { name: 'qaaf',  ipa: 'q',  place: 'uvular stop',         v: 6,  w: 0.66, note: 'neutral mouth; neighbouring vowels open and back', emph: true },
    'خ': { name: 'khaa',  ipa: 'χ',  place: 'uvular fricative',    v: 6,  w: 0.90, note: 'neutral mouth, breathy rasp; neighbouring vowels open and back', emph: true },
    'غ': { name: 'ghayn', ipa: 'ʁ',  place: 'uvular fricative',    v: 6,  w: 0.85, note: 'neutral mouth, voiced rasp; neighbouring vowels open and back', emph: true },
    'ح': { name: 'Haa',   ipa: 'ħ',  place: 'pharyngeal',          v: 1,  w: 0.90, note: 'jaw drops, tongue root pulled back' },
    'ع': { name: 'ayn',   ipa: 'ʕ',  place: 'pharyngeal',          v: 1,  w: 0.90, note: 'jaw drops, tongue root pulled back' },
    'ه': { name: 'haa',   ipa: 'h',  place: 'glottal',             v: 6,  w: 0.50, note: 'breath; the mouth is already in the next vowel shape' },
    'ء': { name: 'hamza', ipa: 'ʔ',  place: 'glottal stop',        v: -1, w: 0.20, note: 'a catch in the throat: the lips do not move' },
    'و': { name: 'waaw',  ipa: 'w / uː', place: 'labio-velar glide / long vowel', v: 3, w: 0.75, note: 'lips rounded (as a consonant); long uu is the U mouth' },
    'ا': { name: 'alif',  ipa: 'aː', place: 'long open vowel',     v: 1,  w: 1.70, note: 'wide open, held twice as long as a short a' },
    'ى': { name: 'alif maqsura', ipa: 'aː', place: 'long open vowel', v: 1, w: 1.70, note: 'sounds like alif at the end of a word' },
    'ة': { name: 'taa marbuta',  ipa: 'a / t', place: 'word-final a', v: 1, w: 0.60, note: 'a short a at the end of a word' },
    'أ': { name: 'alif + hamza above', ipa: 'ʔa / ʔu', place: 'glottal stop + vowel', v: 1, w: 0.80, note: 'a short a (u if it has a damma)' },
    'إ': { name: 'alif + hamza below', ipa: 'ʔi', place: 'glottal stop + vowel', v: 9, w: 0.80, note: 'a short i' },
    'آ': { name: 'alif madda',  ipa: 'ʔaː', place: 'glottal stop + long a', v: 1, w: 1.90, note: 'long open a' },
    'ؤ': { name: 'waaw + hamza', ipa: 'ʔu', place: 'glottal stop + vowel', v: 11, w: 0.80, note: 'a short u' },
    'ئ': { name: 'yaa + hamza',  ipa: 'ʔi', place: 'glottal stop + vowel', v: 9, w: 0.80, note: 'a short i' },
  };
  // letters from other alphabets that show up in Arabic-script text
  const AR_ALIAS = { 'ک': 'ك', 'ی': 'ي', 'ۆ': 'ؤ', 'ڤ': 'ف', 'پ': 'ب', 'چ': 'ج', 'گ': 'ك', 'ڨ': 'ق', 'ٱ': 'ا' };
  const AR_MARKS = {
    fatha:   { ch: '\u064E', name: 'fatha',    ipa: 'a',  v: 1,  note: 'short a: open mouth' },
    damma:   { ch: '\u064F', name: 'damma',    ipa: 'u',  v: 11, note: 'short u: lips round (O shape next to an emphatic letter)' },
    kasra:   { ch: '\u0650', name: 'kasra',    ipa: 'i',  v: 9,  note: 'short i: lips spread' },
    sukun:   { ch: '\u0652', name: 'sukun',    ipa: '',   v: -1, note: 'no vowel: the consonant closes the syllable' },
    shadda:  { ch: '\u0651', name: 'shadda',   ipa: 'CC', v: -1, note: 'doubled consonant: the mouth stays on the shape about twice as long' },
    fathatan:{ ch: '\u064B', name: 'tanween a', ipa: 'an', v: 1, note: 'a then n' },
    dammatan:{ ch: '\u064C', name: 'tanween u', ipa: 'un', v: 11, note: 'u then n' },
    kasratan:{ ch: '\u064D', name: 'tanween i', ipa: 'in', v: 9, note: 'i then n' },
    dagger:  { ch: '\u0670', name: 'dagger alif', ipa: 'aː', v: 1, note: 'a hidden long a' },
  };
  const SUN = 'تثدذرزسشصضطظلن';       // the ل of ال assimilates to these ("ash-shams")
  const EMPH = 'صضطظقخغ';               // emphatic and uvular letters: neighbouring vowels are open and back
  const AR_CONS = new Set('بتثجحخدذرزسشصضطظعغفقكلمنه'.split('').concat(['ء']));
  // dialect overrides for the letters whose sound changes with the speaker. 'msa' = Standard Arabic; 'egy' = Egyptian.
  const DIALECT = {
    msa: {},
    egy: { 'ج': { v: 6, ipa: 'g' }, 'ث': { v: 6, ipa: 't~s' }, 'ذ': { v: 6, ipa: 'd~z' }, 'ظ': { v: 5, ipa: 'zˤ' } },
  };

  const markKind = c => {
    for (const k in AR_MARKS) if (AR_MARKS[k].ch === c) return k;
    return null;
  };
  const isArabicMark = c => /[\u064B-\u065F\u0670\u06D6-\u06ED]/.test(c);
  const isArabicWord = w => /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFEFF]/.test(w);

  // One Arabic word -> phoneme units [{v, w, ph, ch, kind}]. `dialect` is 'msa' or 'egy'.
  function arabicWord(raw, dialect) {
    const dia = DIALECT[dialect] || DIALECT.msa;
    // 1. split into letters with the vowel marks that follow them
    const src = String(raw).normalize('NFKC').replace(/\u0640/g, '');
    const U = [];
    for (const c of src) {
      if (isArabicMark(c)) {
        const k = markKind(c); if (!k || !U.length) continue;
        const u = U[U.length - 1];
        if (k === 'shadda') u.shadda = true;
        else if (k === 'sukun') u.sukun = true;
        else if (k === 'fatha') u.fatha = true;
        else if (k === 'damma') u.damma = true;
        else if (k === 'kasra') u.kasra = true;
        else if (k === 'fathatan') u.tan = 'a';
        else if (k === 'dammatan') u.tan = 'u';
        else if (k === 'kasratan') u.tan = 'i';
        else if (k === 'dagger') u.dagger = true;
        continue;
      }
      const ch = AR_ALIAS[c] || c;
      if (AR_LETTERS[ch]) U.push({ ch });
      // anything else (digits, latin) is not part of an Arabic word
    }
    if (!U.length) return [];
    const n = U.length;
    const hasMarks = U.some(u => u.fatha || u.damma || u.kasra);

    // 2. the definite article "al-" (optionally after wa-/fa-/bi-/ka-): assimilate before a sun letter
    let p = 0;
    if (n > 3 && 'وفبك'.includes(U[0].ch) && U[1].ch === 'ا' && U[2].ch === 'ل') p = 1;
    if (n - p > 3 && U[p].ch === 'ا' && U[p + 1].ch === 'ل' && !U[p + 1].shadda) {
      U[p].article = true; U[p + 1].article = true;
      if (SUN.includes(U[p + 2].ch)) { U[p + 1].assimilated = true; U[p + 2].geminate = true; }
    }

    const out = [];
    const emit = (v, w, ph, ch, kind, extra) => { if (v !== -1 || kind === 'V') out.push(Object.assign({ v, w, ph, ch, kind }, extra || {})); };
    // does an emphatic / uvular letter sit next to position i? (Egyptian spreads it over the whole word)
    const emphNear = i => {
      if (dialect === 'egy') return U.some(u => EMPH.includes(u.ch));
      return (i > 0 && EMPH.includes(U[i - 1].ch)) || (i + 1 < n && EMPH.includes(U[i + 1].ch)) || EMPH.includes(U[i].ch);
    };
    const vowel = (i, kind, extra) => {          // kind: 'a' 'i' 'u' 'aa' 'ii' 'uu'
      const emph = emphNear(i);
      let v = kind[0] === 'a' ? 1 : kind[0] === 'i' ? 9 : (emph ? 10 : 11);
      const long = kind.length === 2;
      const w = (long ? 1.7 : 0.8) * (extra && extra.implicit ? 0.62 : 1);
      emit(v, w, kind, U[i].ch, 'V', extra);
    };
    const isConsonantRole = i => {
      const u = U[i], ch = u.ch;
      if (ch === 'و' || ch === 'ي') {
        if (i === 0) return true;
        if (u.shadda || u.fatha || u.damma || u.kasra || u.tan) return true;
        const nx = U[i + 1];
        if (nx && nx.ch === 'ا' && i + 2 < n) return true;        // "waa-" inside a word: consonant + long a
        if (nx && nx.ch === 'ا' && i + 2 === n && ch === 'ي') return true;
        return false;
      }
      return AR_CONS.has(ch) && ch !== 'ء';
    };
    const lastIdx = n - 1;

    for (let i = 0; i < n; i++) {
      const u = U[i], ch = u.ch, L = AR_LETTERS[ch];
      const prev = U[i - 1];

      // ---------- vowel carriers
      if (ch === 'ا') {
        if (u.article && i === p) { emit(1, 0.7, 'a', ch, 'V'); continue; }              // the "a" of al-
        if (i === 0) {                                                                    // initial alif (hamzat wasl): "ism", "ibn"
          if (u.tan) { vowel(i, 'a'); emit(5, 0.7, 'n', ch, 'C'); }
          else emit(9, 0.7, 'i', ch, 'V');
          continue;
        }
        if (u.tan === 'a') { vowel(i, 'a'); emit(5, 0.7, 'n', ch, 'C'); continue; }       // shukran: alif carries the tanween
        if (prev && prev.tan === 'a') continue;                                           // silent tanween carrier
        if (i === lastIdx && prev && prev.ch === 'و' && !isConsonantRole(i - 1)) continue;   // plural "-uu" + silent alif (katabuu)
        vowel(i, 'aa'); continue;
      }
      if (ch === 'آ') { emit(1, 1.9, 'ʔaa', ch, 'V'); continue; }
      if (ch === 'ى') { vowel(i, 'aa'); continue; }
      if (ch === 'أ' || ch === 'إ' || ch === 'ؤ' || ch === 'ئ') {
        if (u.sukun) continue;
        let k = ch === 'إ' || ch === 'ئ' ? 'i' : ch === 'ؤ' ? 'u' : 'a';
        if (u.damma) k = 'u'; else if (u.kasra) k = 'i'; else if (u.fatha) k = 'a';
        vowel(i, k);
        if (u.tan) emit(5, 0.7, 'n', ch, 'C');
        continue;
      }
      if (ch === 'ء') {                                                                    // free-standing hamza: catch in the throat
        const k = u.fatha ? 'a' : u.damma ? 'u' : u.kasra ? 'i' : null;
        if (k) vowel(i, k);
        continue;
      }
      if (ch === 'ة') {
        if (u.kasra || u.damma || u.fatha || u.tan) {                                     // "-atu / -ati": the t is pronounced
          emit(6, 0.6, 't', ch, 'C');
          vowel(i, u.damma || u.tan === 'u' ? 'u' : u.kasra || u.tan === 'i' ? 'i' : 'a');
          if (u.tan) emit(5, 0.7, 'n', ch, 'C');
        } else emit(1, 0.6, 'a', ch, 'V');
        continue;
      }

      // ---------- و / ي : glide or long vowel
      if ((ch === 'و' || ch === 'ي') && !isConsonantRole(i)) {
        const glide = ch === 'و' ? 3 : 9;
        if (prev && prev.fatha && u.sukun && hasMarks) {                                  // diphthong aw / ay
          emit(glide, 0.9, ch === 'و' ? 'w' : 'y', ch, 'C');
        } else {
          vowel(i, ch === 'و' ? 'uu' : 'ii');
        }
        continue;
      }

      // ---------- consonants
      if (u.assimilated) continue;                                                        // the ل of al- before a sun letter
      let v = L.v, ipa = L.ipa, w = L.w;
      const ov = dia[ch]; if (ov) { if (ov.v !== undefined) v = ov.v; if (ov.ipa) ipa = ov.ipa; }
      if (ch === 'و') { v = 3; ipa = 'w'; } else if (ch === 'ي') { v = 9; ipa = 'j'; }
      const gem = u.shadda || u.geminate;
      if (gem) w *= 1.8;
      if (v === 7 && gem) w *= 1.1;                                                       // a doubled bilabial: the closure is held
      emit(v, w, ipa + (gem ? 'ː' : ''), ch, 'C', { emph: !!L.emph });

      // the vowel that follows this consonant
      const nx = U[i + 1];
      const nextIsLong = nx && ((nx.ch === 'ا' && !(nx.article && i + 1 === p)) || nx.ch === 'آ' || nx.ch === 'ى' ||
                          ((nx.ch === 'و' || nx.ch === 'ي') && !isConsonantRole(i + 1)));
      if (u.dagger) { vowel(i, 'aa'); continue; }
      if (u.fatha) { vowel(i, 'a'); }
      else if (u.damma) { vowel(i, 'u'); }
      else if (u.kasra) { vowel(i, 'i'); }
      else if (u.tan) { vowel(i, u.tan); emit(5, 0.7, 'n', ch, 'C'); }
      else if (u.sukun) { /* closed syllable */ }
      else if (!nextIsLong) {
        // Unmarked letter. Standard Arabic syllables never start with a vowel or a cluster, so in ordinary
        // (undiacritized) text a short vowel is heard after almost every consonant except the last one.
        const single = n === 1;
        const beforeTaaMarbuta = nx && nx.ch === 'ة' && i + 1 === lastIdx && !nx.kasra && !nx.damma && !nx.fatha && !nx.tan;
        if (!hasMarks && (i < lastIdx || single) && !beforeTaaMarbuta) vowel(i, 'a', { implicit: true });
      }
    }
    // a doubled consonant between two vowels is one long closure: merge the repeats the rules above created
    return out;
  }

  // ------------------------------------------------------------------ English
  const EN_DIGRAPHS = { th: 4, ch: 12, sh: 12, ph: 8, ee: 9, ea: 9, ie: 9, oo: 11, ou: 11, ow: 11, oa: 10, oi: 10, oy: 10,
                        qu: 3, ai: 1, ay: 1, ng: 5, ck: 6, wh: 3, augh: 10, ough: 10, eigh: 1, tion: 12, sion: 12, dge: 12 };
  const EN_KEYS = Object.keys(EN_DIGRAPHS).sort((a, b) => b.length - a.length);
  // identical to the mapping the project shipped with (the rig's own grouping), so English replies look as before
  const EN_SINGLE = { a: 1, e: 1, i: 1, o: 10, u: 11, l: 2, n: 5, w: 3, q: 3, f: 8, v: 8, b: 7, m: 7, p: 7, j: 12,
                      c: 6, d: 6, g: 6, k: 6, r: 6, s: 6, t: 6, x: 6, y: 6, z: 6 };
  const EN_HOLD = { 1: 1.5, 2: 1.0, 3: 1.15, 4: 1.05, 5: 0.95, 6: 0.72, 7: 0.62, 8: 0.95, 9: 1.3, 10: 1.5, 11: 1.6, 12: 1.05 };

  function englishWord(raw) {
    const s = String(raw).toLowerCase().replace(/[^a-z]/g, '');
    const out = [];
    for (let i = 0; i < s.length;) {
      let hit = false;
      for (const k of EN_KEYS) if (s.startsWith(k, i)) { const v = EN_DIGRAPHS[k]; out.push({ v, w: (EN_HOLD[v] || 1) * (isVowelViseme(v) ? 1 : 0.75), ph: k, ch: k, kind: isVowelViseme(v) ? 'V' : 'C' }); i += k.length; hit = true; break; }
      if (hit) continue;
      const v = EN_SINGLE[s[i]];
      if (v !== undefined) out.push({ v, w: (EN_HOLD[v] || 1) * (isVowelViseme(v) ? 1 : 0.75), ph: s[i], ch: s[i], kind: isVowelViseme(v) ? 'V' : 'C' });
      i++;
    }
    // repeats / doubled letters extend one shape instead of flickering
    const merged = [];
    for (const e of out) { const l = merged[merged.length - 1]; if (l && l.v === e.v) { l.w += e.w * 0.5; l.ph += e.ph; } else merged.push(e); }
    return merged;
  }
  function digitsWord(raw) {                     // spoken numbers: an open/neutral pulse per digit
    const out = [];
    for (const c of raw) { if (/[0-9\u0660-\u0669]/.test(c)) { out.push({ v: 6, w: 0.5, ph: c, ch: c, kind: 'C' }, { v: 1, w: 1.0, ph: c, ch: c, kind: 'V' }); } }
    return out;
  }

  // ------------------------------------------------------------------ text -> phrases -> words
  const PAUSE_W = { ',': 0.5, '،': 0.5, ';': 0.7, '؛': 0.7, ':': 0.7, '.': 1.2, '!': 1.2, '?': 1.3, '؟': 1.3, '…': 1.4, '\n': 1.5 };
  const TOKEN_RE = /([\p{L}\p{M}\p{N}'’\u0640]+)|([,;:.!?،؛؟…]+|\n+)/gu;

  function dialectFor(opts) {
    const d = opts && opts.dialect;
    if (d === 'egy' || d === 'msa') return d;
    const voice = String((opts && opts.voice) || '');
    return /^ar-EG/i.test(voice) ? 'egy' : 'msa';
  }

  function parseText(text, opts) {
    const dialect = dialectFor(opts);
    const phrases = [];
    let cur = { words: [], brk: 0 };
    const str = String(text == null ? '' : text).normalize('NFKC');
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(str))) {
      if (m[1]) {
        const tok = m[1];
        let units, lang;
        if (isArabicWord(tok)) { units = arabicWord(tok, dialect); lang = 'ar'; }
        else if (/^[0-9\u0660-\u0669]+$/.test(tok)) { units = digitsWord(tok); lang = 'num'; }
        else { units = englishWord(tok); lang = 'en'; }
        if (units.length) cur.words.push({ text: tok, lang, units, w: units.reduce((s, u) => s + u.w, 0) });
        else cur.words.push({ text: tok, lang, units: [], w: 0 });
      } else if (m[2]) {
        let s = 0; for (const c of m[2]) s = Math.max(s, PAUSE_W[c] || 0);
        cur.brk = s;
        if (cur.words.length) { phrases.push(cur); cur = { words: [], brk: 0 }; }
      }
    }
    if (cur.words.length) phrases.push(cur);
    return { phrases, dialect };
  }

  // Flat list [{v,w}] for compatibility / quick inspection (pauses are not part of it any more)
  function textToVisemes(text, opts) {
    const seq = [];
    for (const ph of parseText(text, opts).phrases) for (const wd of ph.words) for (const u of wd.units) {
      const l = seq[seq.length - 1];
      if (l && l.v === u.v) l.w += u.w * 0.5; else seq.push({ v: u.v, w: u.w });
    }
    return seq;
  }

  // ------------------------------------------------------------------ audio analysis
  function analyze(data, sampleRate) {
    const hop = Math.max(1, Math.round(sampleRate * 0.01));
    const n = Math.floor(data.length / hop);
    const rms = new Float32Array(n);
    let max = 0;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < hop; j++) { const x = data[i * hop + j]; sum += x * x; }
      rms[i] = Math.sqrt(sum / hop);
      if (rms[i] > max) max = rms[i];
    }
    const thr = Math.max(0.004, max * 0.06);
    const voiced = new Uint8Array(n);
    for (let i = 0; i < n; i++) voiced[i] = rms[i] > thr ? 1 : 0;
    // very short dips inside a word (a stop closure) are still speech
    for (let i = 0; i < n;) {
      if (voiced[i]) { i++; continue; }
      let j = i; while (j < n && !voiced[j]) j++;
      if (i > 0 && j < n && j - i < 5) voiced.fill(1, i, j);
      i = j;
    }
    // the "voiced clock": advances only while there is sound, a little slower on loud (stressed) frames
    const cum = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + voiced[i] * (1 - CONFIG.linger * (max > 0 ? rms[i] / max : 0));
    return { voiced, cum, n, total: cum[n], rms, rate: 100, duration: n / 100 };
  }

  // inverse of the voiced clock: the frame at which the clock reaches c
  function frameAtClock(A, c) {
    let lo = 0, hi = A.n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (A.cum[mid + 1] < c) lo = mid + 1; else hi = mid; }
    return lo;
  }
  // interior silences [{s,e}] (frames), between the first and the last voiced frame
  function findGaps(A) {
    let f0 = 0; while (f0 < A.n && !A.voiced[f0]) f0++;
    let f1 = A.n - 1; while (f1 > f0 && !A.voiced[f1]) f1--;
    const gaps = [];
    for (let i = f0; i <= f1;) {
      if (A.voiced[i]) { i++; continue; }
      let j = i; while (j <= f1 && !A.voiced[j]) j++;
      gaps.push({ s: i, e: j, len: j - i });
      i = j;
    }
    return { f0, f1: f1 + 1, gaps };
  }

  // ------------------------------------------------------------------ alignment
  // Lay `units` (with weights) over the frames [a, b) proportionally on the voiced clock.
  function layUnits(A, units, a, b, out) {
    if (!units.length || b <= a) return;
    const c0 = A.cum[a], c1 = A.cum[b];
    if (c1 <= c0) return;
    let W = 0; for (const u of units) W += u.w;
    if (W <= 0) return;
    let acc = 0;
    for (const u of units) {
      const s = frameAtClock(A, c0 + (acc / W) * (c1 - c0));
      acc += u.w;
      const e = frameAtClock(A, c0 + (acc / W) * (c1 - c0));
      out.push({ t0: Math.max(a, s) / A.rate, t1: Math.min(b, Math.max(e, s)) / A.rate, v: u.v, ph: u.ph, ch: u.ch, kind: u.kind });
    }
    // make the block contiguous: each unit runs until the next one starts
    for (let i = out.length - units.length; i < out.length - 1; i++) out[i].t1 = out[i + 1].t0;
    out[out.length - 1].t1 = b / A.rate;
  }

  // Phrase-by-phrase alignment anchored on the real pauses of the audio.
  function alignByPhrases(parsed, A) {
    const { f0, f1, gaps } = findGaps(A);
    const phrases = parsed.phrases.filter(p => p.words.some(w => w.units.length));
    const out = [];
    if (!phrases.length || f1 <= f0) return out;
    const weights = phrases.map(p => p.words.reduce((s, w) => s + w.w, 0));
    const totalW = weights.reduce((s, x) => s + x, 0);
    const minGap = Math.round(CONFIG.anchorGap * A.rate);
    const cand = gaps.filter(g => g.len >= minGap);
    const clockTotal = A.cum[f1] - A.cum[f0];
    const anchors = [];                       // chosen gaps, in order
    let acc = 0, lastUsed = -1;
    for (let k = 0; k < phrases.length - 1; k++) {
      acc += weights[k];
      const F = acc / totalW;
      let best = -1, bestScore = -1e9;
      for (let gi = 0; gi < cand.length; gi++) {
        if (gi <= lastUsed) continue;
        const g = cand[gi];
        const pos = clockTotal > 0 ? (A.cum[g.s] - A.cum[f0]) / clockTotal : 0;
        const dist = Math.abs(pos - F);
        if (dist > CONFIG.anchorWindow) continue;
        const score = Math.min(g.len, 60) / 60 - dist * 3 + (phrases[k].brk >= 1 ? 0.15 * Math.min(g.len, 40) / 40 : 0);
        if (score > bestScore) { bestScore = score; best = gi; }
      }
      if (best >= 0) { anchors.push({ k, gap: cand[best] }); lastUsed = best; }
    }
    // blocks: consecutive phrases with no anchor between them are merged
    let start = f0, from = 0;
    const blocks = [];
    for (const an of anchors) {
      blocks.push({ units: phrases.slice(from, an.k + 1).flatMap(p => p.words.flatMap(w => w.units)), a: start, b: an.gap.s });
      start = an.gap.e; from = an.k + 1;
    }
    blocks.push({ units: phrases.slice(from).flatMap(p => p.words.flatMap(w => w.units)), a: start, b: f1 });
    for (const bl of blocks) layUnits(A, bl.units, bl.a, bl.b, out);
    return out;
  }

  // Word-by-word alignment from the TTS engine's own word timestamps (seconds). Returns null if they do not fit the text.
  function alignByWords(parsed, A, words) {
    const list = parsed.phrases.flatMap(p => p.words);
    if (!words || !words.length || words.length !== list.length) return null;
    const { f0 } = findGaps(A);
    let shift = f0 / A.rate - words[0].t;                       // the engine's clock vs the decoded audio (encoder delay, lead-in)
    if (!isFinite(shift) || Math.abs(shift) > CONFIG.edgeMaxShift) shift = 0;
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const wd = list[i]; if (!wd.units.length) continue;
      let a = Math.round((words[i].t + shift) * A.rate);
      let b = Math.round((words[i].t + words[i].d + shift) * A.rate);
      a = Math.max(0, Math.min(A.n - 1, a)); b = Math.max(a + 1, Math.min(A.n, b));
      while (a < b && !A.voiced[a]) a++;                          // trim silence off the word window
      while (b > a && !A.voiced[b - 1]) b--;
      if (b - a < 2) continue;
      layUnits(A, wd.units, a, b, out);
    }
    for (let i = 0; i < out.length - 1; i++) if (out[i + 1].t0 < out[i].t1) out[i].t1 = out[i + 1].t0;   // windows may overlap a hair
    return out;
  }

  // Close the mouth in real silences; hold the shape across tiny ones; then make every shape visible.
  function refine(segs, A) {
    const C = CONFIG;
    if (!segs.length) return segs;
    // 1. fill holes between segments: short holes hold the previous shape, long holes are rest
    const filled = [];
    for (let i = 0; i < segs.length; i++) {
      const s = Object.assign({}, segs[i]);
      const prev = filled[filled.length - 1];
      if (prev && s.t0 - prev.t1 > 1e-6) {
        const gap = s.t0 - prev.t1;
        if (gap < C.gapClose) prev.t1 = s.t0;
        else filled.push({ t0: prev.t1, t1: s.t0, v: 0, ph: '', ch: '', kind: 'pause' });
      }
      filled.push(s);
    }
    // 2. any audio silence inside a segment that is long enough closes the mouth
    const sil = [];
    for (let i = 0; i < A.n;) {
      if (A.voiced[i]) { i++; continue; }
      let j = i; while (j < A.n && !A.voiced[j]) j++;
      if ((j - i) / A.rate >= C.gapClose) sil.push([i / A.rate, j / A.rate]);
      i = j;
    }
    let segsB = filled;
    for (const [s0, s1] of sil) {
      const next = [];
      for (const g of segsB) {
        if (g.t1 <= s0 || g.t0 >= s1 || g.kind === 'pause') { next.push(g); continue; }
        if (g.t0 < s0) next.push(Object.assign({}, g, { t1: s0 }));
        next.push({ t0: Math.max(g.t0, s0), t1: Math.min(g.t1, s1), v: 0, ph: '', ch: '', kind: 'pause' });
        if (g.t1 > s1) next.push(Object.assign({}, g, { t0: s1 }));
      }
      segsB = next;
    }
    // 3. merge equal neighbours
    let cur = [];
    for (const g of segsB) {
      if (g.t1 - g.t0 <= 1e-6) continue;
      const l = cur[cur.length - 1];
      if (l && l.v === g.v && g.kind !== 'pause' && l.kind !== 'pause') l.t1 = g.t1; else cur.push(g);
    }
    // 4. minimum visible time: a short low-priority shape is absorbed; a short high-priority one takes time from a neighbour
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < cur.length; i++) {
        const g = cur[i], d = g.t1 - g.t0;
        if (d >= C.minHold || g.kind === 'pause') continue;
        const pr = PRIORITY[g.v] || 0;
        const L = cur[i - 1], R = cur[i + 1];
        const lp = L && L.kind !== 'pause' ? (PRIORITY[L.v] || 0) : 99, rp = R && R.kind !== 'pause' ? (PRIORITY[R.v] || 0) : 99;
        if (pr >= 3) {                                                     // must be seen: borrow the missing time
          let need = C.minHold - d;
          for (const [nb, side] of [[L, 'l'], [R, 'r']]) {
            if (!nb || need <= 0) continue;
            if (nb.kind !== 'pause' && (PRIORITY[nb.v] || 0) >= pr) continue;
            // a rest is a fine donor (a closed mouth either way) as long as a real pause is left
            const spare = nb.kind === 'pause' ? Math.max(0, (nb.t1 - nb.t0) - 0.12) : Math.max(0, (nb.t1 - nb.t0) - C.minHold * 0.6);
            const take = Math.min(spare, need);
            if (take <= 0) continue;
            if (side === 'l') { nb.t1 -= take; g.t0 -= take; } else { nb.t0 += take; g.t1 += take; }
            need -= take;
          }
        } else {                                                           // not visible anyway: give the time to the stronger neighbour
          const canL = !!L && L.kind !== 'pause', canR = !!R && R.kind !== 'pause';
          if (!canL && !canR) continue;
          const toLeft = canL && (!canR || lp >= rp);
          if (toLeft) L.t1 = g.t1; else R.t0 = g.t0;
          g.t1 = g.t0;
        }
      }
      cur = cur.filter(g => g.t1 - g.t0 > 1e-6);
      const m2 = [];
      for (const g of cur) { const l = m2[m2.length - 1]; if (l && l.v === g.v && l.kind !== 'pause' && g.kind !== 'pause') l.t1 = g.t1; else m2.push(g); }
      cur = m2;
    }
    // 5. lips lead the voice
    if (C.lead > 0) for (const g of cur) { g.t0 = Math.max(0, g.t0 - C.lead); g.t1 = Math.max(g.t0, g.t1 - C.lead); }
    return cur;
  }

  /**
   * Build the mouth plan for one utterance.
   *   text   what is spoken
   *   audio  {getChannelData(0), sampleRate}  (a decoded AudioBuffer) - or pass opts.analysis
   *   opts   { voice, dialect, words: [{t, d}] }  words = TTS word timings in seconds (optional)
   */
  function makePlan(text, audio, opts) {
    opts = opts || {};
    const parsed = parseText(text, opts);
    const A = opts.analysis || analyze(audio.getChannelData(0), audio.sampleRate);
    let segs = null, mode = 'phrases';
    if (opts.words) { segs = alignByWords(parsed, A, opts.words); if (segs) mode = 'words'; }
    if (!segs) segs = alignByPhrases(parsed, A);
    const timeline = refine(segs, A);
    return {
      timeline, parsed, mode, dialect: parsed.dialect,
      visemeAt(t) {
        if (!timeline.length || t < 0) return 0;
        let lo = 0, hi = timeline.length - 1;
        if (t < timeline[0].t0 || t >= timeline[hi].t1) return 0;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (timeline[mid].t0 <= t) lo = mid; else hi = mid - 1; }
        return t < timeline[lo].t1 ? timeline[lo].v : 0;
      },
      env: A.rms, rate: A.rate,
      voicedFrames: A.total,
    };
  }

  // ------------------------------------------------------------------ inspection helpers for the dashboard / docs
  function arabicTable(dialect) {
    const dia = DIALECT[dialect] || DIALECT.msa;
    const order = 'ابتثجحخدذرزسشصضطظعغفقكلمنهويءةىأإآؤئ'.split('');
    return order.map(ch => {
      const L = AR_LETTERS[ch], o = dia[ch] || {};
      return { ch, name: L.name, ipa: o.ipa || L.ipa, place: L.place, v: o.v !== undefined ? o.v : L.v, note: L.note, emph: !!L.emph };
    });
  }
  function marksTable() { return Object.keys(AR_MARKS).map(k => Object.assign({ key: k }, AR_MARKS[k])); }
  // Turn text into a readable list of "letter -> sound -> mouth" for the tester panel.
  function explain(text, opts) {
    const parsed = parseText(text, opts);
    return parsed.phrases.flatMap(p => p.words).map(w => ({
      word: w.text, lang: w.lang,
      units: w.units.map(u => ({ ch: u.ch, ph: u.ph, v: u.v, w: +u.w.toFixed(2), kind: u.kind })),
    }));
  }
  // Mouth-only demo timeline (no audio): each unit gets `msPerWeight` * weight. For "watch the mouth" previews.
  function demoTimeline(text, opts, msPerWeight) {
    const parsed = parseText(text, opts), k = (msPerWeight || 105) / 1000;
    const segs = []; let t = 0;
    for (const ph of parsed.phrases) {
      for (const wd of ph.words) {
        for (const u of wd.units) { segs.push({ t0: t, t1: t + u.w * k, v: u.v, ph: u.ph, ch: u.ch, kind: u.kind }); t += u.w * k; }
        t += 0.04;
      }
      t += (ph.brk || 0.3) * 0.35;
    }
    return segs;
  }

  return { CONFIG, VISEMES, PRIORITY, AR_LETTERS, AR_MARKS, DIALECT, parseText, arabicWord, englishWord, textToVisemes,
           analyze, makePlan, refine, alignByPhrases, alignByWords, arabicTable, marksTable, explain, demoTimeline, isArabicWord };
});
