/*!
 * katago-bridge.js — 把 KataGo 接成"职业段位"的执子者
 * ---------------------------------------------------------------
 * 走 KataGo 官方 Analysis Engine（JSON over stdin/stdout），比 GTP 好解析、
 * 支持批量、返回胜率/目差/候选点，正好对上本项目的面板接口。
 *
 * 前提：本机装了 KataGo 二进制 + 一个权重文件。
 *   https://github.com/lightvector/KataGo/releases
 *   权重：kata1-b18c384nbt-*.bin.gz（约 100MB，CPU 也能跑，GPU 更快）
 *
 * 用法：
 *   const { KataGoBridge } = require('./katago-bridge.js');
 *   const kg = new KataGoBridge({
 *     bin: '/opt/katago/katago',
 *     model: '/opt/katago/kata1-b18c384nbt.bin.gz',
 *     config: '/opt/katago/analysis.cfg',
 *   });
 *   const res = await kg.analyze({ board, toMove: 1, komi: 7.5, maxVisits: 400 });
 *   // res = { move: 172, winrate: 0.53, scoreLead: 3.4, candidates: [...] }
 *   kg.close();
 */
'use strict';

const { spawn } = require('child_process');
const readline = require('readline');

const LET = 'ABCDEFGHJKLMNOPQRST';

function gtpCoord(idx, n) {
  if (idx == null || idx < 0) return 'pass';
  const x = idx % n, y = Math.floor(idx / n);
  return LET[x] + (n - y);
}

function gtpToIdx(str, n) {
  if (!str || str.toLowerCase() === 'pass') return -1;
  const x = LET.indexOf(str[0].toUpperCase());
  const y = n - parseInt(str.slice(1), 10);
  if (x < 0 || isNaN(y)) return -1;
  return y * n + x;
}

/** 盘面 → KataGo 的 initialStones（用摆子表示，不需要走子历史） */
function toInitialStones(board, n) {
  const out = [];
  for (let i = 0; i < board.length; i++) {
    if (!board[i]) continue;
    out.push([board[i] === 1 ? 'B' : 'W', gtpCoord(i, n)]);
  }
  return out;
}

class KataGoBridge {
  constructor(opts) {
    opts = opts || {};
    this.bin = opts.bin || 'katago';
    this.model = opts.model;
    this.config = opts.config;
    this.timeoutMs = opts.timeoutMs || 30000;
    this.args = opts.args || null;      // 自定义参数（测试/自编译版本用）
    this.n = opts.boardSize || 19;
    this.proc = null;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    this._start();
  }

  _start() {
    if (!this.args && !this.model) throw new Error('KataGoBridge: 缺少 model 权重路径');
    const args = this.args || ['analysis', '-model', this.model];
    if (!this.args && this.config) args.push('-config', this.config);
    this.proc = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (e) { return; }
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      if (msg.error) {
        this.pending.delete(msg.id);
        slot.reject(new Error('KataGo: ' + msg.error));
        return;
      }
      if (msg.warning || msg.isDuringSearch) return;
      // 一个请求可能回多个 turn，这里只关心 analyzeTurns 指定的那个
      if (msg.turnNumber != null && slot.turn != null && msg.turnNumber !== slot.turn) return;
      this.pending.delete(msg.id);
      slot.resolve(msg);
    });

    let stderrTail = '';
    this.proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });

    this.proc.on('exit', (code) => {
      for (const [, slot] of this.pending) {
        slot.reject(new Error('KataGo 进程退出 code=' + code + ' ' + stderrTail));
      }
      this.pending.clear();
      this.proc = null;
    });
  }

  _request(payload, turn) {
    if (!this.proc) this._start();
    const id = 'q' + (++this.seq);
    payload.id = id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('KataGo 超时（' + this.timeoutMs + 'ms）'));
      }, this.timeoutMs);
      this.pending.set(id, {
        turn,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  /**
   * @param {{board:Int8Array, toMove:1|2, komi?:number, maxVisits?:number, maxTime?:number, n?:number}} p
   * @returns {Promise<{move:number, winrate:number, scoreLead:number, candidates:Array, raw:object}>}
   */
  async analyze(p) {
    const n = p.n || this.n;
    const komi = p.komi == null ? 7.5 : p.komi;
    const turn = 0;
    const overrideSettings = { reportAnalysisWinratesAs: 'BLACK' };
    if (p.maxTime) overrideSettings.maxTime = p.maxTime;

    const payload = {
      initialStones: toInitialStones(p.board, n),
      initialPlayer: p.toMove === 2 ? 'W' : 'B',
      moves: [],
      rules: 'chinese',
      komi: komi,
      boardXSize: n,
      boardYSize: n,
      analyzeTurns: [turn],
      maxVisits: p.maxVisits || 400,
      includePolicy: false,
      overrideSettings,
    };

    const msg = await this._request(payload, turn);
    const infos = (msg.moveInfos || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const root = msg.rootInfo || {};
    const candidates = infos.slice(0, 8).map((m, i) => ({
      move: gtpToIdx(m.move, n),
      order: m.order == null ? i : m.order,
      visits: m.visits,
      winrate: m.winrate,          // 黑视角
      scoreLead: m.scoreLead,      // 正 = 黑领先
    }));

    const best = candidates.length ? candidates[0].move : -1;
    return {
      move: best,
      winrate: root.winrate,
      scoreLead: root.scoreLead,
      visits: root.visits,
      candidates: candidates,
      engine: 'katago',
      raw: msg,
    };
  }

  close() {
    this.closed = true;
    if (this.proc) {
      try { this.proc.stdin.write('{"id":"quit","action":"quit"}\n'); } catch (e) {}
      try { this.proc.kill(); } catch (e) {}
      this.proc = null;
    }
  }
}

module.exports = { KataGoBridge, gtpCoord, gtpToIdx, toInitialStones };
