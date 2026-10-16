'use strict';
/*
 * Egyptian-Arabic text preparation for the avatar's voice. No dependencies, no network.
 *
 *   egyptianize(text)            LLM output -> plain Egyptian wording (no diacritics, MSA words swapped for Egyptian ones)
 *   numbersToEgy(text)           digits -> Egyptian number words ("50%" -> "خمسين في المية", "3:30" -> "تلاتة ونص")
 *   arabizeLatin(text)           Latin words -> Arabic letters, for voices that cannot read English (Edge ar-EG)
 *   prepareSpeech(text, opts)    numbers + (optionally) Latin -> the exact string that is sent to the TTS engine
 *   alignWords(spoken, words)    makes the TTS engine's word timings line up 1:1 with the words the browser's
 *                                lip-sync will find in `spoken` (so the mouth uses real timings instead of a guess)
 */

// ------------------------------------------------------------------ numbers
const ONES = ['صفر', 'واحد', 'اتنين', 'تلاتة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'تمانية', 'تسعة'];
const TEENS = ['عشرة', 'احداشر', 'اتناشر', 'تلاتاشر', 'أربعتاشر', 'خمستاشر', 'ستاشر', 'سبعتاشر', 'تمنتاشر', 'تسعتاشر'];
const TENS = ['', '', 'عشرين', 'تلاتين', 'أربعين', 'خمسين', 'ستين', 'سبعين', 'تمانين', 'تسعين'];
const HUND = ['', 'مية', 'ميتين', 'تلتمية', 'ربعمية', 'خمسمية', 'ستمية', 'سبعمية', 'تمنمية', 'تسعمية'];
const THOUSAND_COUNT = ['', '', '', 'تلات', 'أربع', 'خمس', 'ست', 'سبع', 'تمن', 'تسع', 'عشر'];

function below1000(n) {
  const parts = [];
  const h = Math.floor(n / 100), r = n % 100;
  if (h) parts.push(HUND[h]);
  if (r) {
    if (r < 10) parts.push(ONES[r]);
    else if (r < 20) parts.push(TEENS[r - 10]);
    else { const u = r % 10, t = Math.floor(r / 10); parts.push(u ? `${ONES[u]} و${TENS[t]}` : TENS[t]); }
  }
  return parts.join(' و');
}
function intToEgy(n) {
  if (n === 0) return ONES[0];
  if (n >= 1e6) return String(n);                                  // too big to be worth reading out: leave the digits
  const th = Math.floor(n / 1000), rest = n % 1000, parts = [];
  if (th) {
    if (th === 1) parts.push('ألف');
    else if (th === 2) parts.push('ألفين');
    else if (th <= 10) parts.push(`${THOUSAND_COUNT[th]} تلاف`);
    else parts.push(`${below1000(th)} ألف`);
  }
  if (rest) parts.push(below1000(rest));
  return parts.join(' و');
}
const EASTERN = '٠١٢٣٤٥٦٧٨٩';
function numbersToEgy(text) {
  let s = String(text).replace(/[٠-٩]/g, d => String(EASTERN.indexOf(d)));
  s = s.replace(/٫/g, '.').replace(/(\d),(\d{3})(?!\d)/g, '$1$2');           // 1,500 -> 1500
  // clock times: 3:30 -> "تلاتة ونص", 4:15 -> "أربعة وربع", 5:00 -> "خمسة"
  s = s.replace(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g, (m, h, mi) => {
    const H = +h, M = +mi;
    if (H > 24 || M > 59) return m;
    const hh = intToEgy(H % 12 === 0 ? 12 : H % 12);
    if (M === 0) return hh;
    if (M === 30) return `${hh} ونص`;
    if (M === 15) return `${hh} وربع`;
    if (M === 45) return `${hh} إلا ربع`;
    return `${hh} و${intToEgy(M)}`;
  });
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, (m, n) => `${n} في المية`);
  s = s.replace(/(\d+)\.(\d+)/g, (m, a, b) => `${intToEgy(+a)} فاصل ${[...b].map(d => ONES[+d]).join(' ')}`);
  s = s.replace(/\d+/g, m => { const n = Number(m); return m.length > 7 || !Number.isSafeInteger(n) ? [...m].map(d => ONES[+d]).join(' ') : intToEgy(n); });
  return s;
}

// ------------------------------------------------------------------ wording
const TASHKEEL = /[ً-ْٰـ]/g;
const L = '\\u0621-\\u064A\\u0671-\\u06D3';
// Whole-word swaps. Only words that are unmistakably Modern Standard Arabic are replaced.
const MSA_TO_EGY = [
  ['ماذا', 'إيه'], ['لماذا', 'ليه'], ['كيف', 'إزاي'], ['أين', 'فين'], ['اين', 'فين'], ['متى', 'إمتى'],
  ['هذا', 'ده'], ['هذه', 'دي'], ['هذان', 'دول'], ['هؤلاء', 'دول'], ['ذلك', 'ده'], ['تلك', 'دي'],
  ['الآن', 'دلوقتي'], ['الان', 'دلوقتي'], ['حالياً', 'دلوقتي'], ['حاليا', 'دلوقتي'],
  ['جداً', 'أوي'], ['جدا', 'أوي'], ['كثيراً', 'كتير'], ['كثيرا', 'كتير'], ['كثير', 'كتير'],
  ['أريد', 'عايز'], ['اريد', 'عايز'], ['نعم', 'أيوه'], ['أجل', 'أيوه'], ['كلا', 'لأ'],
  ['الذي', 'اللي'], ['التي', 'اللي'], ['الذين', 'اللي'], ['اللذان', 'اللي'],
  ['ليس', 'مش'], ['لست', 'مش'], ['ليست', 'مش'], ['لن', 'مش'],
  ['يوجد', 'فيه'], ['توجد', 'فيه'], ['أيضاً', 'كمان'], ['أيضا', 'كمان'], ['ايضا', 'كمان'], ['كذلك', 'كمان'],
  ['لكن', 'بس'], ['لكنّ', 'بس'], ['لأن', 'عشان'], ['لان', 'عشان'],
  ['اليوم', 'النهارده'], ['غداً', 'بكرة'], ['غدا', 'بكرة'], ['أمس', 'إمبارح'],
  ['حسناً', 'ماشي'], ['حسنا', 'ماشي'], ['مرحباً', 'أهلاً'], ['مرحبا', 'أهلاً'],
  ['بخير', 'كويس'], ['جميل', 'حلو'], ['جميلة', 'حلوة'], ['رائع', 'جامد'], ['رائعة', 'جامدة'], ['مذهل', 'تحفة'],
  ['أستطيع', 'أقدر'], ['استطيع', 'أقدر'], ['فقط', 'بس'], ['كل شيء', 'كل حاجة'], ['شيء', 'حاجة'],
  ['الجميع', 'كلكم'], ['أحبك', 'بحبك'], ['شكراً', 'شكراً'],
];
const MSA_RE = MSA_TO_EGY.filter(([a, b]) => a !== b).map(([a, b]) => [new RegExp(`(?<![${L}])${a}(?![${L}])`, 'g'), b]);
function egyptianize(text) {
  let s = String(text || '').replace(TASHKEEL, '').normalize('NFKC');
  if (!/[؀-ۿ]/.test(s)) return s.trim();                       // no Arabic in it: nothing to localise
  s = s.replace(new RegExp(`(^|[.!؟?،,؛]\\s*)هل\\s+`, 'g'), '$1');          // "هل" is not used in Egyptian questions
  s = s.replace(new RegExp(`(?<![${L}])سوف\\s+`, 'g'), 'هـ');
  for (const [re, to] of MSA_RE) s = s.replace(re, to);
  s = s.replace(/هـ\s+/g, 'هـ').replace(/هـ(?=[^ء-ي])/g, 'هـ');
  s = s.replace(/هـ([ء-ي])/g, 'ه$1');                          // "هـ"+verb -> plain "ه"+verb (e.g. هقولك)
  return s.replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------------------------ Latin -> Arabic letters
const WORDS = {
  ok: 'أوكيه', okay: 'أوكيه', hi: 'هاي', hello: 'هالو', hey: 'هاي', bye: 'باي', live: 'لايف', stream: 'ستريم', streaming: 'ستريمنج',
  like: 'لايك', likes: 'لايكس', share: 'شير', subscribe: 'سابسكرايب', comment: 'كومنت', comments: 'كومنتس', chat: 'شات',
  wow: 'واو', yes: 'يس', no: 'نو', please: 'بليز', thanks: 'ثانكس', thank: 'ثانك', you: 'يو', price: 'برايس', product: 'برودكت',
  offer: 'أوفر', discount: 'ديسكاونت', sale: 'سيل', link: 'لينك', online: 'أونلاين', mobile: 'موبايل', video: 'فيديو',
  voice: 'فويس', avatar: 'أفاتار', magic: 'ماجيك', spell: 'سبيل', game: 'جيم', love: 'لاف', cool: 'كول', nice: 'نايس',
  good: 'جود', super: 'سوبر', vip: 'في آي بي', ai: 'إيه آي', tv: 'تي في', pc: 'بي سي', usb: 'يو إس بي', meeting: 'ميتينج',
  presentation: 'بريزنتيشن', iphone: 'أيفون', samsung: 'سامسونج', youtube: 'يوتيوب', tiktok: 'تيك توك', facebook: 'فيسبوك',
  instagram: 'إنستجرام', whatsapp: 'واتساب', google: 'جوجل', upside: 'أبسايد', down: 'داون', the: 'ذا', and: 'آند', of: 'أوف',
  shop: 'شوب', store: 'ستور', free: 'فري', new: 'نيو', best: 'بيست', top: 'توب', pro: 'برو', max: 'ماكس', plus: 'بلس',
};
// common first names (viewer names are spoken in every greeting, so they matter more than most words)
Object.assign(WORDS, {
  omar: 'عمر', ahmed: 'أحمد', ahmad: 'أحمد', mohamed: 'محمد', mohammed: 'محمد', mohammad: 'محمد', muhammad: 'محمد', mo: 'مو', mody: 'مودي',
  ali: 'علي', hassan: 'حسن', hussein: 'حسين', hossam: 'حسام', khaled: 'خالد', khalid: 'خالد', youssef: 'يوسف', yousef: 'يوسف', yusuf: 'يوسف',
  mostafa: 'مصطفى', mustafa: 'مصطفى', mahmoud: 'محمود', ibrahim: 'إبراهيم', ismail: 'إسماعيل', karim: 'كريم', kareem: 'كريم', tarek: 'طارق',
  tamer: 'تامر', amr: 'عمرو', amir: 'أمير', samir: 'سمير', sherif: 'شريف', sameh: 'سامح', walid: 'وليد', waleed: 'وليد', hany: 'هاني', hani: 'هاني',
  adel: 'عادل', saeed: 'سعيد', said: 'سعيد', zaki: 'زكي', essam: 'عصام', kamal: 'كمال', sayed: 'سيد', abdullah: 'عبدالله', abdelrahman: 'عبدالرحمن',
  sara: 'سارة', sarah: 'سارة', lina: 'لينا', nour: 'نور', noor: 'نور', mona: 'منى', mariam: 'مريم', maryam: 'مريم', fatma: 'فاطمة', fatima: 'فاطمة',
  aya: 'آية', asmaa: 'أسماء', esraa: 'إسراء', hanan: 'حنان', yasmin: 'ياسمين', yasmine: 'ياسمين', omnia: 'أمنية', salma: 'سلمى', heba: 'هبة',
  rana: 'رنا', dina: 'دينا', rania: 'رانيا', nada: 'ندى', laila: 'ليلى', layla: 'ليلى', jana: 'جنى', malak: 'ملك', hoda: 'هدى', mai: 'مي', may: 'مي',
  john: 'جون', mike: 'مايك', david: 'ديفيد', james: 'جيمس', alex: 'أليكس', anna: 'آنا', maria: 'ماريا', emma: 'إيما', sam: 'سام', tom: 'توم',
  guest: 'ضيف', admin: 'أدمن',
});
const LETTER_NAMES = { a: 'إيه', b: 'بي', c: 'سي', d: 'دي', e: 'إي', f: 'إف', g: 'جي', h: 'إتش', i: 'آي', j: 'جاي', k: 'كي', l: 'إل', m: 'إم',
  n: 'إن', o: 'أو', p: 'بي', q: 'كيو', r: 'آر', s: 'إس', t: 'تي', u: 'يو', v: 'في', w: 'دبليو', x: 'إكس', y: 'واي', z: 'زد' };
const DIGRAPHS = [['tch', 'تش'], ['sch', 'سك'], ['sh', 'ش'], ['ch', 'تش'], ['th', 'ث'], ['ph', 'ف'], ['ck', 'ك'], ['kh', 'خ'], ['gh', 'غ'], ['oo', 'و'],
  ['ee', 'ي'], ['ou', 'او'], ['ea', 'ي'], ['qu', 'كو'], ['ie', 'ي'], ['ai', 'ي'], ['ay', 'ي'], ['ow', 'او']];
const SINGLE = { a: 'ا', b: 'ب', c: 'ك', d: 'د', e: 'ي', f: 'ف', g: 'ج', h: 'ه', i: 'ي', j: 'ج', k: 'ك', l: 'ل', m: 'م', n: 'ن', o: 'و', p: 'ب',
  q: 'ك', r: 'ر', s: 'س', t: 'ت', u: 'و', v: 'ف', w: 'و', x: 'كس', y: 'ي', z: 'ز' };
function arabizeWord(w) {
  const lw = w.toLowerCase();
  if (WORDS[lw]) return WORDS[lw];
  if (/^[A-Z]{2,4}$/.test(w)) return [...lw].map(c => LETTER_NAMES[c]).join(' ');          // acronym: read the letters
  let out = '', i = 0;
  while (i < lw.length) {
    const d = DIGRAPHS.find(([k]) => lw.startsWith(k, i));
    if (d) { out += d[1]; i += d[0].length; continue; }
    const c = lw[i];
    if (c === 'c' && /[eiy]/.test(lw[i + 1] || '')) out += 'س';
    else if (c === 'g' && /[eiy]/.test(lw[i + 1] || '') && i > 0) out += 'ج';
    else if (i === 0 && c === 'a') out += 'أ';
    else if (i === 0 && c === 'e') out += 'إ';
    else if (i === 0 && c === 'o') out += 'أو';
    else if (i === 0 && c === 'u') out += 'أو';
    else if (i === 0 && c === 'i') out += 'إي';
    else if (i === lw.length - 1 && c === 'e' && lw.length > 3) { /* silent final e */ }
    else out += SINGLE[c] || '';
    i++;
  }
  return out || w;
}
function arabizeLatin(text) {
  return String(text).replace(/[A-Za-z][A-Za-z'’]*/g, m => arabizeWord(m.replace(/['’]s$/i, '').replace(/['’]/g, '')));
}

// ------------------------------------------------------------------ one call for the server
// keepLatin = true for engines that read English themselves (VoiceTut code-switching); false for Edge's Egyptian voices.
function prepareSpeech(text, { keepLatin = false } = {}) {
  let s = numbersToEgy(String(text || '').replace(TASHKEEL, ''));
  if (!keepLatin) s = arabizeLatin(s);
  return s.replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------------------------ word timings
// The browser (web/lipsync.js) splits the text it is given into words with this regex and only trusts the engine's timings
// when the counts are equal. Edge's boundaries can include punctuation or split/join words differently, so reconcile them here.
const TOKEN_RE = /[\p{L}\p{M}\p{N}'’ـ]+/gu;
const norm = s => String(s || '').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
function tokensOf(text) { return (String(text || '').normalize('NFKC').match(TOKEN_RE) || []); }
function alignWords(spoken, words) {
  if (!Array.isArray(words) || !words.length) return null;
  const toks = tokensOf(spoken);
  const ew = words.filter(w => w && norm(w.w).length > 0 && w.type !== 'SentenceBoundary');
  if (!toks.length || !ew.length) return null;
  if (ew.length === toks.length) return ew.map(w => ({ t: w.t, d: w.d, w: w.w }));
  const out = [];
  let i = 0, j = 0;
  while (i < toks.length && j < ew.length) {
    const tn = norm(toks[i]), en = norm(ew[j].w);
    if (tn === en) { out.push({ t: ew[j].t, d: ew[j].d, w: toks[i] }); i++; j++; }
    else if (en.startsWith(tn) && tn.length < en.length) {                 // one engine word spans several tokens: split its time by length
      let k = i, acc = '', group = [];
      while (k < toks.length && en.startsWith(acc + norm(toks[k]))) { acc += norm(toks[k]); group.push(toks[k]); k++; if (acc === en) break; }
      if (acc !== en) return null;
      let t = ew[j].t; const total = acc.length;
      for (const g of group) { const d = ew[j].d * norm(g).length / total; out.push({ t, d, w: g }); t += d; }
      i = k; j++;
    } else if (tn.startsWith(en) && en.length < tn.length) {               // one token spans several engine words: merge them
      let k = j, acc = '';
      while (k < ew.length && tn.startsWith(acc + norm(ew[k].w))) { acc += norm(ew[k].w); k++; if (acc === tn) break; }
      if (acc !== tn) return null;
      out.push({ t: ew[j].t, d: ew[k - 1].t + ew[k - 1].d - ew[j].t, w: toks[i] });
      i++; j = k;
    } else return null;
  }
  return i === toks.length && j === ew.length ? out : null;
}

module.exports = { egyptianize, numbersToEgy, intToEgy, arabizeLatin, prepareSpeech, alignWords, tokensOf };
