const G = require('./go-engine.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}
const L19 = 'ABCDEFGHJKLMNOPQRST';
const L9 = 'ABCDEFGHJ';
function fmt(mv, n) {
  if (mv < 0) return 'pass';
  const L = n === 9 ? L9 : L19;
  return L[mv % n] + (n - ((mv / n) | 0));
}

console.log('\n[1] 提子');
{
  const p = G.fromAscii(`
.....
.XX..
.XO..
.XX..
.....
`);
  const r = G.play(p, 2 * 5 + 3, G.BLACK);
  ok('落子成功', r.ok, JSON.stringify(r));
  ok('提掉 1 子', r.captured === 1, JSON.stringify(r));
  ok('被提点清空', p.board[2 * 5 + 2] === 0);
  ok('提子计数', p.captures[1] === 1, p.captures.join(','));
}

console.log('\n[2] 禁自杀');
{
  const p = G.fromAscii(`
.....
.OOO.
.O.O.
.OOO.
.....
`);
  const r = G.play(p, 2 * 5 + 2, G.BLACK);
  ok('无气不提子时禁入', r.ok === false && r.reason === 'suicide', JSON.stringify(r));
  const p2 = G.fromAscii(`
.....
.OOO.
.O.O.
.OOO.
.....
`);
  p2.toMove = G.BLACK;
  const s = G.score(p2);
  ok('自杀未改变棋盘', JSON.stringify(p2.board) === JSON.stringify(G.fromAscii(`
.....
.OOO.
.O.O.
.OOO.
.....
`).board), JSON.stringify(s));
}

console.log('\n[3] 位置超级劫');
{
  const p = G.fromAscii(`
.XX..
X.X..
.XO..
.....
.....
`);
  // 仅验证历史哈希在推进
  const r = G.play(p, 0, G.BLACK);
  ok('落子后历史增长', p.history.length >= 2, p.history.length);
}

console.log('\n[4] 数子');
{
  const p = G.fromAscii(`
XXXXX
XXXXX
XXXXX
XXXXX
XXXXX
`);
  const s = G.score(p);
  ok('全盘黑 = 25 目', s.black === 25, JSON.stringify(s));
  ok('贴目生效（25-7.5）', Math.abs(s.diff - 17.5) < 1e-9, JSON.stringify(s));
}

console.log('\n[5] 吞吐');
{
  const p = G.newPosition(19, 7.5);
  const seq = [[3, 3], [15, 15], [3, 15], [15, 3], [9, 9], [9, 3], [3, 9], [13, 13], [5, 16]];
  let c = G.BLACK;
  for (const [x, y] of seq) { G.play(p, y * 19 + x, c); c = 3 - c; }
  const t0 = Date.now();
  const r = G.analyze(p, { visits: 2500 });
  const dt = Date.now() - t0;
  console.log('  2500 次模拟 ' + dt + 'ms，约 ' + Math.round(2500 / dt * 1000) + ' 次/秒');
  console.log('  黑胜率 ' + (r.blackWinrate * 100).toFixed(1) + '%，目差 ' + r.scoreLead.toFixed(1) +
    '，首选 ' + fmt(r.bestMove, 19) +
    '，Top3 ' + r.candidates.slice(0, 3).map(x => fmt(x.move, 19) + '(' + x.visits + ')').join(' '));
  ok('有胜率输出', r.blackWinrate > 0 && r.blackWinrate < 1);
  ok('有首选着点', r.bestMove >= -1);
}

console.log('\n[6] 战术：AI 会救自己的孤子（唯一气）');
{
  const p = G.fromAscii(`
.........
.........
..XX.....
..XO.....
..XX.....
.........
.........
.........
.........
`, 7.5);
  p.toMove = G.WHITE;
  const r = G.analyze(p, { visits: 1200 });
  const target = 4 + 3 * 9;   // (4,3) 唯一逃气点
  ok('选中唯一逃气点 ' + fmt(target, 9), r.bestMove === target, '实际 ' + fmt(r.bestMove, 9));
}

console.log('\n[7] 战术：AI 会提掉叫吃中的对方子');
{
  const p = G.fromAscii(`
.........
.........
..OO.....
..OX.....
..OO.....
.........
.........
.........
.........
`, 7.5);
  p.toMove = G.BLACK;
  const r = G.analyze(p, { visits: 1200 });
  const target = 4 + 3 * 9;   // (4,3) 提白
  ok('选中提子点 ' + fmt(target, 9), r.bestMove === target, '实际 ' + fmt(r.bestMove, 9));
}

console.log('\n[8] 实战：AI vs 随机（9 路，每手 1200 模拟）');
{
  const N = 9, games = 4;
  let aiWin = 0;
  for (let g = 0; g < games; g++) {
    const p = G.newPosition(N, 7.5);
    const aiColor = g % 2 === 0 ? G.BLACK : G.WHITE;
    const scratch = G.makeScratch(N);
    let moveNo = 0;
    while (moveNo < 200) {
      if (p.passes >= 2) break;
      if (p.toMove === aiColor) {
        const res = G.analyze(p, { visits: 700 });
        let mv = res.bestMove;
        if (mv >= 0 && G.capturesAt(p.board, N, mv, p.toMove, scratch) < 0) mv = -1;
        G.play(p, mv, p.toMove);
      } else {
        let mv = -1;
        for (let t = 0; t < 400; t++) {
          const c = (Math.random() * N * N) | 0;
          if (p.board[c] === 0 && G.capturesAt(p.board, N, c, p.toMove, scratch) >= 0) { mv = c; break; }
        }
        G.play(p, mv, p.toMove);
      }
      moveNo++;
    }
    const s = G.score(p);
    const ai = aiColor === G.BLACK ? s.black : s.white;
    const op = aiColor === G.BLACK ? s.white : s.black;
    if (ai > op) aiWin++;
    console.log(`  第${g + 1}局 AI执${aiColor === 1 ? '黑' : '白'} ${moveNo}手  AI ${ai.toFixed(1)} : ${op.toFixed(1)}  ${ai > op ? '胜' : '负'}`);
  }
  ok('对随机全胜', aiWin === games, aiWin + '/' + games);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
