/*!
 * mock-katago.js — 假的 KataGo 进程，只实现 Analysis Engine 的最小收发
 * ---------------------------------------------------------------
 * 用途：没装 KataGo 时也能验证 katago-bridge.js / katago-server.js 的协议是否正确
 *（进程管理、id 匹配、轮次、并发、超时）。它不产生任何真实棋力，返回的是固定着法。
 *
 *   KATAGO_BIN=$(which node) KATAGO_ARGS=./mock-katago.js PORT=8100 node katago-server.js
 */
// 模拟 KataGo Analysis Engine 的 stdin/stdout 行为，仅用于验证协议解析
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const movesBySize = {
  9: ['F6', 'D4', 'F4', 'D6', 'E3'],
  13: ['K10', 'D4', 'K4', 'D10', 'J3'],
  19: ['Q16', 'D4', 'Q4', 'D16', 'P3'],
};
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch (e) { return; }
  if (req.action === 'quit' || req.id === 'quit') { process.exit(0); }
  const moves = movesBySize[req.boardXSize] || movesBySize[19];
  const currentPlayer = req.initialPlayer || (req.moves.length ? 'W' : 'B');
  const perspective = req.overrideSettings?.reportAnalysisWinratesAs || 'SIDETOMOVE';
  const whitePerspective = perspective === 'WHITE' || (perspective === 'SIDETOMOVE' && currentPlayer === 'W');
  const winrateAsRequested = (blackWinrate) => whitePerspective ? 1 - blackWinrate : blackWinrate;
  const scoreAsRequested = (blackLead) => whitePerspective ? -blackLead : blackLead;
  const resp = {
    id: req.id,
    turnNumber: (req.analyzeTurns && req.analyzeTurns[0]) || 0,
    echoMoves: req.moves,
    rootInfo: {
      currentPlayer, winrate: winrateAsRequested(0.531), scoreLead: scoreAsRequested(3.2), visits: req.maxVisits,
    },
    moveInfos: moves.map((mv, i) => ({
      move: mv, order: i, visits: Math.round(req.maxVisits / (i + 2)),
      winrate: winrateAsRequested(0.531 - i * 0.01), scoreLead: scoreAsRequested(3.2 - i * 0.8),
      pv: [mv],
    })),
  };
  process.stdout.write(JSON.stringify(resp) + '\n');
});
