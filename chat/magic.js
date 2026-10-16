'use strict';
/*
 * Comment -> magic trick. A viewer types something like "افتح العالم المقلوب" / "ارقص" / "upside down" and the avatar
 * answers with a trick (the cinematic Upside-Down spell, or a gesture) plus one short Egyptian line, instead of a chat reply.
 * Pure keyword rules: no network, instant, and a stranger can only ever trigger the fixed tricks listed here.
 */
const L = '\\u0621-\\u064A';
// `re` matches the comment (Arabic dialect words and English). Order matters: the first match wins.
const INTENTS = [
  { id: 'spell-off', kind: 'spell', on: false,
    re: new RegExp(`(اقفل|قفل|سكر|رجّع|رجع|ارجع|close|stop).{0,24}(البوابة|البوابه|العالم|الاوضة|الأوضة|الاوضه|الدنيا|السحر|spell|portal|upside)|back to normal|رجعها زي ما كانت|رجّع كل حاجة|رجع كل حاجة`, 'i'),
    lines: ['حاضر يا {n}، بقفل البوابة... وأرجّع كل حاجة زي ما كانت!', 'تمام يا {n}، السحر خلص. رجعنا للأوضة العادية!'],
    already: ['الأوضة عادية خلاص يا {n}، مفيش حاجة مقلوبة!'] },
  { id: 'spell-on', kind: 'spell', on: true,
    re: new RegExp(`upside\\s*-?\\s*down|العالم المقلوب|عالم مقلوب|افتح (ال)?(بوابة|بوابه|عالم)|اقلب (ال)?(اوضة|أوضة|اوضه|دنيا|غرفة|المكان)|تعويذ[ةه]|abracadabra|ابرا كدابرا|أبرا كادابرا|(^|[^${L}])سحر(ي|ها|لنا)?([^${L}]|$)|\\bspell\\b|\\bmagic\\b`, 'i'),
    lines: ['حاضر يا {n}! ركّزوا في الأوضة... هفتح العالم المقلوب!', 'طلبك أوامر يا {n}! خدوا نفس... السحر هيبدأ دلوقتي!'],
    already: ['العالم المقلوب مفتوح خلاص يا {n}، بصّ حواليك!'] },
  { id: 'dance', kind: 'gesture', gesture: 'dance', re: /ارقص|رقص|ترقص|دانس|\bdance\b|\bdancing\b/i,
    lines: ['حاضر يا {n}! شوف الرقص ده!', 'عيونيا يا {n}! اتفرج على الحركات!'] },
  { id: 'celebrate', kind: 'gesture', gesture: 'celebrate', re: /احتفل|احتفال|مبروك|هيييه|celebrate|congrat|party/i,
    lines: ['هيييه! مبروك يا {n}! يلا نحتفل!', 'ألف مبروك! يلا يا {n} نفرّح الدنيا!'] },
  { id: 'wave', kind: 'gesture', gesture: 'wave', re: /سلّم علينا|سلم علينا|لوّح|لوح بإيدك|لوح بايدك|\bwave\b/i,
    lines: ['أهلاً أهلاً بيكم كلكم! نورتوا يا جماعة!', 'أهلاً يا {n}! سلام ليك ولكل الحاضرين!'] },
  { id: 'nod', kind: 'gesture', gesture: 'nod', re: /هز راسك|هز رأسك|وافق|\bnod\b/i,
    lines: ['تمام يا {n}، موافق!', 'ماشي يا {n}، حاضر!'] },
  { id: 'surprise', kind: 'gesture', gesture: 'surprise', re: /اتفاجئ|اتفاجأ|اتصدم|اتخض|\bsurprise\b/i,
    lines: ['يا نهار أبيض! مكنتش متوقع ده خالص!', 'إيه ده يا {n}! أنا اتخضيت!'] },
  { id: 'shrug', kind: 'gesture', gesture: 'shrug', re: /هز كتافك|هز كتفك|\bshrug\b/i,
    lines: ['مش عارف والله يا {n}، معرفش!', 'ولا أعرف يا {n}! أنا بس بتفرج!'] },
  { id: 'jump', kind: 'gesture', gesture: 'bounce', re: /اقفز|نط|نطّ|\bjump\b|\bbounce\b/i,
    lines: ['حاضر يا {n}! هوب هوب!', 'طلبك عندي يا {n}، شوف النطّة دي!'] },
  { id: 'glasses', kind: 'gesture', gesture: 'glasses', re: /نضارة|نظارة|نضّارة|\bglasses\b/i,
    lines: ['تمام يا {n}، لبست النضارة! شكلي مثقف دلوقتي!'] },
  { id: 'march', kind: 'gesture', gesture: 'march', re: /امشي في مكانك|عسكري|\bmarch\b/i,
    lines: ['تحت أمرك يا {n}! واحد اتنين، واحد اتنين!'] },
];
const busy = ['استنى شوية يا {n}، السحر محتاج يرتاح شوية وبعدين نرجع نعمله!', 'هدّي اللعب يا {n}! كمان شوية وأعملهالك تاني.'];

function detect(text) {
  const t = String(text || '');
  for (const it of INTENTS) if (it.re.test(t)) return it;
  return null;
}
const fill = (line, name) => String(line).replace(/\{n\}/g, name || '');
let pick = 0;
const choose = arr => arr[pick++ % arr.length];

module.exports = { detect, fill, choose, INTENTS, busy };
