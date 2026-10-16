// Extracts the data tables from the project's egy.js so the Python port never re-types them.
// usage: node tools/extract_tables.js tools/egy.reference.js data/egy_tables.json
const fs = require('fs'), Module = require('module');
const [src, out] = process.argv.slice(2);
const code = fs.readFileSync(src, 'utf8') +
  '\n;module.exports.__t={ONES,TEENS,TENS,HUND,THOUSAND_COUNT,MSA_TO_EGY,WORDS,LETTER_NAMES,DIGRAPHS,SINGLE};';
const m = new Module(src); m.filename = src; m.paths = []; m._compile(code, src);
fs.writeFileSync(out, JSON.stringify(m.exports.__t, null, 1));
console.log('wrote', out, Object.fromEntries(Object.entries(m.exports.__t).map(([k, v]) => [k, Array.isArray(v) ? v.length : Object.keys(v).length])));
