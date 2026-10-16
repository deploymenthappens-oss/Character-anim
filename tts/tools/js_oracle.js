// reads a JSON array of strings on stdin, writes the reference egy.js results on stdout
const egy = require('./egy.reference.js');
const inp = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(JSON.stringify(inp.map(t => ({
  numbers: egy.numbersToEgy(t), egyptianize: egy.egyptianize(t), arabize: egy.arabizeLatin(t),
  speech_keep: egy.prepareSpeech(t, { keepLatin: true }), speech_arabized: egy.prepareSpeech(t, { keepLatin: false }) }))));
