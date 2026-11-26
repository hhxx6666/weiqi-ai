const assert = require('node:assert/strict');
const engine = require('./go-engine.js');
const ending = require('./go-ending.js');

function assertTerritoryMatchesScore(position, result) {
  const points = [...result.ownership];
  assert.equal(points.filter(color => color === engine.BLACK).length, result.black);
  assert.equal(points.filter(color => color === engine.WHITE).length + position.komi, result.white);
  assert.equal(result.black - result.white, result.diff);
}

const board = engine.fromAscii('XXO..\nXXO.O\nOOO..\nO.OX.\n..O..', 6.5);
assert.deepEqual(ending.group(board.board, 5, 0).sort((a, b) => a - b), [0, 1, 5, 6]);
assert.deepEqual(ending.group(board.board, 5, 18), [18]);
assert.deepEqual(ending.group(board.board, 5, 3), []);
assert.deepEqual(ending.group(board.board, 5, -1), []);

const saved = engine.clonePosition(board);
const unchanged = ending.score(board);
const { ownership, ...totals } = unchanged;
assert.deepEqual(totals, engine.score(board));
assert.equal(ownership[18], engine.BLACK);
assert.equal(ownership[19], engine.EMPTY);
assertTerritoryMatchesScore(board, unchanged);

const marked = ending.score(board, new Set(ending.group(board.board, 5, 18)));
assert.equal(marked.ownership[18], engine.WHITE);
assert.equal(marked.ownership[19], engine.WHITE);
assertTerritoryMatchesScore(board, marked);
assert.deepEqual(board, saved);

for (const size of [9, 13, 19]) {
  const empty = engine.newPosition(size, 7.5);
  assert.equal(engine.play(empty, engine.PASS).ok, true);
  assert.equal(engine.play(empty, engine.PASS).ok, true);
  const finished = ending.score(empty, []);
  assertTerritoryMatchesScore(empty, finished);
  assert.equal(finished.ownership.every(color => color === engine.EMPTY), true);
  assert.equal(finished.black, 0);
  assert.equal(finished.white, 7.5);
}

console.log('PASS: groups, neutral area, dead-stone removal, komi, and non-mutating end scoring');
