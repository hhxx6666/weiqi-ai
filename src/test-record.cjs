const assert = require('node:assert/strict');
const { parse, stringify } = require('./go-record.js');

const mainLine = String.raw`(;GM[1]FF[4]CA[UTF-8]SZ[9]KM[0.5]HA[2]PL[W]
  AB[cc:dc][gg]AW[ee]C[主线\]注释，括号 (;B[aa) 与反斜线 \\]
  ;AE[cc];W[ef];B[tt](;W[];C[结束]RE[B+R])(;W[bb];B[bc]))`;
const record = parse(mainLine);
assert.deepEqual(record, {
  size: 9,
  komi: 0.5,
  handicap: 2,
  setup: [{ color: 1, move: 21 }, { color: 2, move: 40 }, { color: 1, move: 60 }],
  toMove: 2,
  moves: [{ color: 2, move: 49 }, { color: 1, move: -1 }, { color: 2, move: -1 }],
  result: 'B+R',
});
assert.deepEqual(parse(stringify(record)), record);
assert.match(stringify(record), /;B\[\];W\[\]/);

const whiteFirst = parse('\uFEFF(;GM[1]SZ[13:13]KM[6.5]C[first\\\r\nline];W[mm];B[aa])');
assert.deepEqual(whiteFirst.moves, [{ color: 2, move: 168 }, { color: 1, move: 0 }]);
assert.equal(whiteFirst.toMove, 2);
assert.equal(whiteFirst.result, null);
assert.equal(parse('(;GM[1])').size, 19);
assert.equal(parse('(;GM[1])').komi, 0);
assert.equal(parse('(;GM[1]HA[2]AB[dd][pp])').toMove, 2);
assert.equal(parse('(;GaMe[1]SiZe[9])').size, 9);

for (const size of [9, 13, 19]) {
  const value = {
    size, komi: -1.2e-12, handicap: 0, setup: [], toMove: 1,
    moves: [{ color: 1, move: size * size - 1 }, { color: 2, move: -1 }],
    result: 'Custom ] and \\ text',
  };
  assert.deepEqual(parse(stringify(value)), value);
}

const invalid = [
  ['(;GM[2])', /只支持围棋/],
  ['(;SZ[9:13])', /正方形/],
  ['(;SZ[0x13])', /正方形/],
  ['(;SZ[9];B[jj])', /坐标/],
  ['(;AB[tt])', /坐标/],
  ['(;AB[aa:bb]AW[bb])', /重复摆子/],
  ['(;AB[bb:aa])', /摆子范围/],
  ['(;PL[X])', /应为 B 或 W/],
  ['(;SZ[9];B[aa];AW[bb])', /第一手落子前/],
  ['(;KM[NaN])', /贴目值/],
  ['(;SZ[9])(;SZ[19])', /含多局棋谱/],
  ['(;GM[1];B[aa]W[bb])', /只能记一手棋/],
  ['(;GM[1];W[bc][cc])', /只有一个值/],
  ['(;C[注释未关闭)', /缺少右方括号/],
  ['(;B[aa]', /应为 \)/],
];
for (const [text, error] of invalid) assert.throws(() => parse(text), error, text);
assert.throws(() => stringify({ ...record, toMove: 3 }), /行棋方/);
assert.throws(() => stringify({ ...record, setup: [{ color: 1, move: 2 }, { color: 2, move: 2 }] }), /重复摆子/);

console.log('PASS: SGF game info, setup ranges, escape sequences, pass, played line and malformed records');
