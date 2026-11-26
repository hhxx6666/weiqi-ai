const assert = require('node:assert/strict');
const path = require('node:path');

const project = path.resolve(process.argv[2] || __dirname);
const { KataGoBridge, gtpToIdx } = require(path.join(project, 'katago-bridge.js'));

async function main() {
  const bridge = new KataGoBridge({
    bin: process.execPath,
    args: [path.join(project, 'mock-katago.js')],
    timeoutMs: 2000,
  });
  const requests = [];
  const send = bridge._request.bind(bridge);
  bridge._request = (payload, turn) => {
    requests.push(JSON.parse(JSON.stringify(payload)));
    return send(payload, turn);
  };
  const board = new Int8Array(361);
  board[gtpToIdx('D4', 19)] = 1;
  board[gtpToIdx('Q4', 19)] = 1;

  try {
    const [white, black] = await Promise.all([
      bridge.analyze({ board, toMove: 2, komi: 0, maxVisits: 12000, maxTime: 14 }),
      bridge.analyze({ board, toMove: 1, komi: 7.5, maxVisits: 3500 }),
    ]);
    assert.deepEqual(requests[0].initialStones, [['B', 'D4'], ['B', 'Q4']]);
    assert.equal(requests[0].komi, 0);
    assert.equal(requests[0].initialPlayer, 'W');
    assert.equal(requests[1].initialPlayer, 'B');
    assert.deepEqual(requests[0].analyzeTurns, [0]);
    assert.equal(requests[0].maxVisits, 12000);
    assert.equal(requests[1].maxVisits, 3500);
    assert.equal('maxTime' in requests[0], false);
    assert.deepEqual(requests[0].overrideSettings, {
      reportAnalysisWinratesAs: 'BLACK', maxTime: 14,
    });
    assert.deepEqual(requests[1].overrideSettings, { reportAnalysisWinratesAs: 'BLACK' });

    for (const [result, color, visits] of [[white, 'W', 12000], [black, 'B', 3500]]) {
      assert.deepEqual(result.raw.echoMoves, []);
      assert.equal(result.raw.turnNumber, 0);
      assert.equal(result.raw.rootInfo.currentPlayer, color);
      assert.equal(result.move, gtpToIdx('Q16', 19));
      assert.equal(result.visits, visits);
      assert.equal(result.winrate, 0.531);
      assert.equal(result.scoreLead, 3.2);
      assert.equal(result.candidates[0].winrate, 0.531);
      assert.equal(result.candidates[0].scoreLead, 3.2);
    }
    console.log('PASS: concurrent KataGo bridge requests preserve turn, visits, time limit and Black scoring perspective');
  } finally {
    bridge.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
