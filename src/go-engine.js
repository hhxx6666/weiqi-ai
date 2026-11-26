/*!
 * go-engine.js — 围棋规则内核 + MCTS 搜索 + 胜率评估
 * ---------------------------------------------------------------
 * 无任何依赖，浏览器（<script>）与 Node（require）通用。
 * 19 路 / 13 路 / 9 路；中国规则数子（Tromp-Taylor），贴目可配置（默认 7.5）。
 * 支持：提子、禁自杀、全局同形禁止（位置超级劫）、停一手、数子判定。
 *
 * 浏览器: <script src="./go-engine.js"></script>  ->  window.GoEngine
 * Node  : const GoEngine = require('./go-engine.js')
 */
(function (root) {
  'use strict';

  var EMPTY = 0, BLACK = 1, WHITE = 2, PASS = -1;

  /* ------------------------------------------------------------------ */
  /* 邻接表                                                              */
  /* ------------------------------------------------------------------ */
  var NBR_CACHE = Object.create(null);
  function neighbors(n) {
    var t = NBR_CACHE[n];
    if (t) return t;
    t = new Array(n * n);
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        var i = y * n + x, a = [];
        if (x > 0) a.push(i - 1);
        if (x < n - 1) a.push(i + 1);
        if (y > 0) a.push(i - n);
        if (y < n - 1) a.push(i + n);
        t[i] = a;
      }
    }
    NBR_CACHE[n] = t;
    return t;
  }

  // 对角邻接（判断真眼用）
  var DIAG_CACHE = Object.create(null);
  function diagonals(n) {
    var t = DIAG_CACHE[n];
    if (t) return t;
    t = new Array(n * n);
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        var a = [];
        if (x > 0 && y > 0) a.push((y - 1) * n + x - 1);
        if (x < n - 1 && y > 0) a.push((y - 1) * n + x + 1);
        if (x > 0 && y < n - 1) a.push((y + 1) * n + x - 1);
        if (x < n - 1 && y < n - 1) a.push((y + 1) * n + x + 1);
        t[y * n + x] = a;
      }
    }
    DIAG_CACHE[n] = t;
    return t;
  }

  /* ------------------------------------------------------------------ */
  /* 全局临时数组（单线程，非重入，避免 GC 抖动）                        */
  /* ------------------------------------------------------------------ */
  var MAXP = 21 * 21;
  var STACK = new Int32Array(MAXP);
  var STONES = new Int32Array(MAXP);
  var CAPBUF = new Int32Array(MAXP);
  var MARK = new Int32Array(MAXP);
  var LIBSEEN = new Int32Array(MAXP);
  var REGION = new Int32Array(MAXP);
  var EMPTYVIS = new Int32Array(MAXP);
  var markGen = 0, libGen = 0, regionGen = 0;

  /* ------------------------------------------------------------------ */
  /* 位置对象                                                            */
  /* ------------------------------------------------------------------ */
  function newPosition(size, komi) {
    size = size || 19;
    komi = (komi === undefined || komi === null) ? 7.5 : komi;
    return {
      n: size,
      komi: komi,
      board: new Int8Array(size * size),
      toMove: BLACK,
      ko: -1,
      captures: [0, 0, 0],   // [_, 黑提子, 白提子]
      passes: 0,
      moves: [],             // [{x,y,color,pass}]
      hash: '0',
      history: ['0'],
      lastMove: -1
    };
  }

  function clonePosition(p) {
    return {
      n: p.n,
      komi: p.komi,
      board: new Int8Array(p.board),
      toMove: p.toMove,
      ko: p.ko,
      captures: [p.captures[0], p.captures[1], p.captures[2]],
      passes: p.passes,
      moves: p.moves.slice(),
      hash: p.hash,
      history: p.history.slice(),
      lastMove: p.lastMove
    };
  }

  function positionKey(p) {
    // 位置 + 轮走方，用于全局同形判断
    return p.hash + '|' + p.toMove;
  }

  /* ------------------------------------------------------------------ */
  /* 落子：完整规则版（对局用）                                          */
  /* ------------------------------------------------------------------ */
  function applyMove(b, n, idx, color, ko) {
    var NBR = neighbors(n);
    if (idx < 0) return { ok: true, pass: true, captured: 0, ko: -1 };
    if (b[idx] !== EMPTY) return { ok: false, reason: 'occupied' };
    if (idx === ko) return { ok: false, reason: 'ko' };

    var opp = 3 - color;
    b[idx] = color;
    markGen++;
    var captured = 0, capCount = 0, singleCapPoint = -1;
    var nb0 = NBR[idx], k, j, q, s;

    for (k = 0; k < nb0.length; k++) {
      var p0 = nb0[k];
      if (b[p0] !== opp) continue;
      if (MARK[p0] === markGen) continue;
      libGen++;
      var top = 0, libs = 0, cnt = 0;
      STACK[top++] = p0; MARK[p0] = markGen; STONES[cnt++] = p0;
      while (top > 0) {
        s = STACK[--top];
        var sn = NBR[s];
        for (j = 0; j < sn.length; j++) {
          q = sn[j];
          if (b[q] === EMPTY) {
            if (LIBSEEN[q] !== libGen) { LIBSEEN[q] = libGen; libs++; }
          } else if (b[q] === opp && MARK[q] !== markGen) {
            MARK[q] = markGen; STACK[top++] = q; STONES[cnt++] = q;
          }
        }
      }
      if (libs === 0) {
        for (j = 0; j < cnt; j++) { b[STONES[j]] = EMPTY; CAPBUF[capCount++] = STONES[j]; }
        captured += cnt;
        if (cnt === 1) singleCapPoint = STONES[0];
      }
    }

    // 自杀判定 + 打劫点计算
    libGen++;
    var top2 = 0, ownLibs = 0, ownCnt = 0;
    STACK[top2++] = idx; markGen++; MARK[idx] = markGen;
    while (top2 > 0) {
      s = STACK[--top2];
      var sn2 = NBR[s];
      for (j = 0; j < sn2.length; j++) {
        q = sn2[j];
        if (b[q] === EMPTY) {
          if (LIBSEEN[q] !== libGen) { LIBSEEN[q] = libGen; ownLibs++; }
        } else if (b[q] === color && MARK[q] !== markGen) {
          MARK[q] = markGen; STACK[top2++] = q; ownCnt++;
        }
      }
    }

    if (ownLibs === 0) {
      // 自杀：撤销
      b[idx] = EMPTY;
      for (j = 0; j < capCount; j++) b[CAPBUF[j]] = opp;
      return { ok: false, reason: 'suicide' };
    }

    var newKo = -1;
    if (captured === 1 && ownCnt === 1 && ownLibs === 1) newKo = singleCapPoint;

    return { ok: true, captured: captured, ko: newKo, capPoints: capCount };
  }

  // 井字哈希（用于全局同形）
  var ZH = null;
  function zobrist(n) {
    if (ZH && ZH.n === n) return ZH;
    var a = 0x9e3779b9 >>> 0, b0 = 0x85ebca6b >>> 0;
    function next() {
      a ^= a << 13; a >>>= 0;
      a ^= a >>> 17;
      a ^= a << 5; a >>>= 0;
      b0 ^= b0 << 7; b0 >>>= 0;
      b0 ^= b0 >>> 11;
      b0 ^= b0 << 3; b0 >>>= 0;
      return a ^ b0 >>> 0;
    }
    var t = new Int32Array(n * n * 2), i;
    for (i = 0; i < n * n * 2; i++) t[i] = next() | 0;
    ZH = { n: n, t: t };
    return ZH;
  }

  function boardHash(b, n, toMove) {
    var Z = zobrist(n).t;
    var h1 = 0x811c9dc5 | 0, h2 = 0x01000193 | 0;
    for (var i = 0; i < b.length; i++) {
      var c = b[i];
      if (!c) continue;
      var z = Z[i * 2 + (c - 1)];
      h1 = (h1 ^ z) * 16777619 | 0;
      h2 = (h2 + z) * 2654435761 | 0;
    }
    h1 = (h1 ^ (toMove * 0x9e3779b9)) | 0;
    return (h1 >>> 0).toString(36) + '.' + (h2 >>> 0).toString(36);
  }

  /**
   * 在位置 p 上落子（完整规则：含禁自杀 / 位置超级劫 / 记录历史）
   * @returns {{ok:boolean, reason?:string, captured?:number}}
   */
  function play(p, idx, color) {
    if (color === undefined) color = p.toMove;
    if (color !== p.toMove) return { ok: false, reason: 'not_your_turn' };

    var snap = idx >= 0 ? new Int8Array(p.board) : null;
    var r = applyMove(p.board, p.n, idx, color, p.ko);
    if (!r.ok) return r;

    var nextToMove = 3 - color;
    var h = boardHash(p.board, p.n, nextToMove);
    var key = h + '|' + nextToMove;

    if (idx >= 0 && p.history.indexOf(key) !== -1) {
      // 全局同形禁止：整盘回滚
      p.board.set(snap);
      return { ok: false, reason: 'superko' };
    }

    p.history.push(key);
    p.hash = h;
    p.ko = r.ko;
    p.toMove = nextToMove;
    p.lastMove = idx;
    p.passes = idx < 0 ? p.passes + 1 : 0;
    if (idx >= 0) p.captures[color] += r.captured;
    if (p.history.length > 400) p.history.splice(0, 100);
    p.moves.push({ x: idx < 0 ? -1 : idx % p.n, y: idx < 0 ? -1 : (idx / p.n) | 0, color: color, pass: idx < 0, captured: r.captured || 0 });
    return { ok: true, captured: r.captured || 0, ko: p.ko };
  }

  /* ------------------------------------------------------------------ */
  /* 数子（Tromp-Taylor 区域计分）                                       */
  /* ------------------------------------------------------------------ */
  function scoreArea(b, n, komi) {
    var NBR = neighbors(n);
    var black = 0, white = 0, i, j;
    regionGen++;
    for (i = 0; i < b.length; i++) {
      if (b[i] === BLACK) { black++; continue; }
      if (b[i] === WHITE) { white++; continue; }
      if (EMPTYVIS[i] === regionGen) continue;
      // 空区 flood
      var top = 0, cnt = 0, hasB = false, hasW = false;
      STACK[top++] = i; EMPTYVIS[i] = regionGen; REGION[cnt++] = i;
      while (top > 0) {
        var s = STACK[--top];
        var sn = NBR[s];
        for (j = 0; j < sn.length; j++) {
          var q = sn[j];
          if (b[q] === EMPTY) {
            if (EMPTYVIS[q] !== regionGen) { EMPTYVIS[q] = regionGen; STACK[top++] = q; REGION[cnt++] = q; }
          } else if (b[q] === BLACK) hasB = true;
          else hasW = true;
        }
      }
      // 必须被"单方棋子"围住才算地；空盘或双方共界都不算
      if (hasB && !hasW) black += cnt;
      else if (hasW && !hasB) white += cnt;
    }
    return { black: black, white: white + komi, diff: black - white - komi };
  }

  function score(p) {
    return scoreArea(p.board, p.n, p.komi);
  }

  /* ------------------------------------------------------------------ */
  /* 快速落子（推演用，只处理提子/自杀，不含超级劫）                     */
  /* ------------------------------------------------------------------ */
  function fastPlay(b, n, idx, color, ko, scratch) {
    var NBR = scratch.NBR;
    if (idx === ko || b[idx] !== EMPTY) return -2;
    var opp = 3 - color;
    b[idx] = color;
    var capGen = ++scratch.gen;
    var captured = 0, capturedPoint = -1;
    var nb0 = NBR[idx], k, j, q, s;

    for (k = 0; k < nb0.length; k++) {
      var p0 = nb0[k];
      if (b[p0] !== opp || scratch.mark[p0] === capGen) continue;
      var top = 0, libs = 0, cnt = 0;
      var libG = ++scratch.libGen;
      scratch.stack[top++] = p0; scratch.mark[p0] = capGen; scratch.stones[cnt++] = p0;
      while (top > 0) {
        s = scratch.stack[--top];
        var sn = NBR[s];
        for (j = 0; j < sn.length; j++) {
          q = sn[j];
          if (b[q] === EMPTY) {
            if (scratch.lib[q] !== libG) { scratch.lib[q] = libG; libs++; }
          } else if (b[q] === opp && scratch.mark[q] !== capGen) {
            scratch.mark[q] = capGen; scratch.stack[top++] = q; scratch.stones[cnt++] = q;
          }
        }
      }
      if (libs === 0) {
        capturedPoint = scratch.stones[0];
        for (j = 0; j < cnt; j++) b[scratch.stones[j]] = EMPTY;
        captured += cnt;
      }
    }

    // 自杀
    var ownG = ++scratch.libGen, top2 = 0, ownLibs = 0, ownStones = 1;
    scratch.mark[idx] = ++scratch.gen;
    var mg = scratch.mark[idx];
    scratch.stack[top2++] = idx;
    while (top2 > 0) {
      s = scratch.stack[--top2];
      var sn2 = NBR[s];
      for (j = 0; j < sn2.length; j++) {
        q = sn2[j];
        if (b[q] === EMPTY) {
          if (scratch.lib[q] !== ownG) { scratch.lib[q] = ownG; ownLibs++; }
        } else if (b[q] === color && scratch.mark[q] !== mg) {
          scratch.mark[q] = mg; scratch.stack[top2++] = q; ownStones++;
        }
      }
    }
    if (ownLibs === 0) {
      b[idx] = EMPTY;
      return -1;
    }
    scratch.ko = captured === 1 && ownStones === 1 && ownLibs === 1 ? capturedPoint : -1;
    return captured;
  }

  /* ------------------------------------------------------------------ */
  /* 真眼判断：所有正邻是自己 + 对角不是对方（边角更严格）               */
  /* ------------------------------------------------------------------ */
  function isSelfEye(b, n, idx, color) {
    var NBR = neighbors(n), DIAG = diagonals(n);
    var nb = NBR[idx], dg = DIAG[idx], i;
    for (i = 0; i < nb.length; i++) if (b[nb[i]] !== color) return false;
    if (nb.length < 4) {
      // 边/角：对角有对方子则不是眼
      for (i = 0; i < dg.length; i++) if (b[dg[i]] === 3 - color) return false;
      return true;
    }
    for (i = 0; i < dg.length; i++) if (b[dg[i]] === 3 - color) return false;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* MCTS 推演策略：局部应对 + 提子/逃气优先 + 随机分散                  */
  /* ------------------------------------------------------------------ */
  function makeScratch(n) {
    return {
      NBR: neighbors(n),
      DIAG: diagonals(n),
      stack: new Int32Array(n * n + 4),
      stones: new Int32Array(n * n + 4),
      cand: new Int32Array(n * n + 4),
      mark: new Int32Array(n * n),
      lib: new Int32Array(n * n),
      gen: 0,
      libGen: 0
    };
  }

  // 真眼：正邻全己方，对角无对方子
  function eyeCheck(b, sc, idx, color) {
    var nb = sc.NBR[idx], dg = sc.DIAG[idx], i, opp = 3 - color;
    for (i = 0; i < nb.length; i++) if (b[nb[i]] !== color) return false;
    for (i = 0; i < dg.length; i++) if (b[dg[i]] === opp) return false;
    return true;
  }

  function capturesAt(b, n, idx, color, scratch) {
    // 返回该点提子数；自杀返回 -1；被占返回 -2
    var NBR = scratch.NBR;
    if (b[idx] !== EMPTY) return -2;
    var opp = 3 - color, total = 0, j;
    var nb = NBR[idx];
    var mg = ++scratch.gen;
    for (var k = 0; k < nb.length; k++) {
      var p0 = nb[k];
      if (b[p0] !== opp || scratch.mark[p0] === mg) continue;
      var top = 0, libs = 0, cnt = 0, libG = ++scratch.libGen;
      scratch.stack[top++] = p0; scratch.mark[p0] = mg; scratch.stones[cnt++] = p0;
      while (top > 0) {
        var s = scratch.stack[--top];
        var sn = NBR[s];
        for (j = 0; j < sn.length; j++) {
          var q = sn[j];
          if (b[q] === EMPTY) {
          if (q !== idx && scratch.lib[q] !== libG) { scratch.lib[q] = libG; libs++; }
          } else if (b[q] === opp && scratch.mark[q] !== mg) {
            scratch.mark[q] = mg; scratch.stack[top++] = q; scratch.stones[cnt++] = q;
          }
        }
      }
      if (libs === 0) total += cnt;
    }
    if (total > 0) return total;
    // 检查自身是否有气
    var ownLibG = ++scratch.libGen, top2 = 0, ownLibs = 0;
    var mm = ++scratch.gen;
    scratch.mark[idx] = mm; scratch.stack[top2++] = idx;
    while (top2 > 0) {
      var s2 = scratch.stack[--top2];
      var sn2 = NBR[s2];
      for (j = 0; j < sn2.length; j++) {
        var q2 = sn2[j];
        if (b[q2] === EMPTY) {
          // 注意：待落点本身不算气（这一手会把该点填掉）
          if (q2 !== idx && scratch.lib[q2] !== ownLibG) { scratch.lib[q2] = ownLibG; ownLibs++; }
        } else if (b[q2] === color && scratch.mark[q2] !== mm) {
          scratch.mark[q2] = mm; scratch.stack[top2++] = q2;
        }
      }
    }
    return ownLibs > 0 ? 0 : -1;
  }

  function policyMove(b, n, color, last, ko, sc, rnd) {
    var NBR = sc.NBR, i;

    // 1) 局部应对（上一手周围）
    if (last >= 0 && rnd() < 0.9) {
      var nb = NBR[last], cnt = 0;
      for (i = 0; i < nb.length; i++) {
        var c = nb[i];
        if (b[c] !== EMPTY || c === ko) continue;
        if (eyeCheck(b, sc, c, color)) continue;
        var captures = capturesAt(b, n, c, color, sc);
        if (captures > 0) return c;
        if (captures === 0) sc.cand[cnt++] = c;
      }
      if (cnt > 0) {
        if (cnt === 1) return sc.cand[0];
        return sc.cand[(rnd() * cnt) | 0];
      }
    }

    // 2) 全局随机（避开真眼与自杀）
    var total = n * n;
    for (var t = 0; t < 40; t++) {
      var m = (rnd() * total) | 0;
      if (b[m] !== EMPTY || m === ko) continue;
      if (eyeCheck(b, sc, m, color)) continue;
      if (capturesAt(b, n, m, color, sc) >= 0) return m;
    }
    return PASS;
  }

  function groupLibsIsOne(b, n, at, scratch) {
    var NBR = scratch.NBR;
    var color = b[at];
    if (!color) return false;
    var libG = ++scratch.libGen, top = 0, libs = 0;
    var mg = ++scratch.gen;
    scratch.mark[at] = mg; scratch.stack[top++] = at;
    while (top > 0) {
      var s = scratch.stack[--top];
      var sn = NBR[s];
      for (var j = 0; j < sn.length; j++) {
        var q = sn[j];
        if (b[q] === EMPTY) {
          if (scratch.lib[q] !== libG) { scratch.lib[q] = libG; libs++; if (libs > 1) return false; }
        } else if (b[q] === color && scratch.mark[q] !== mg) {
          scratch.mark[q] = mg; scratch.stack[top++] = q;
        }
      }
    }
    return libs === 1;
  }

  /* ------------------------------------------------------------------ */
  /* 一次推演：返回 {diff, winner, amaf}                                 */
  /* ------------------------------------------------------------------ */
  var AMAF_BUF = new Int32Array(MAXP);
  var AMAF_TOUCH = new Int32Array(MAXP);

  function playout(b, n, color, ko, komi, scratch, rnd, rootColor, amafGen, passes, last) {
    var maxSteps = n * n * 2;
    var step = 0;
    var touched = 0;

    while (passes < 2 && step++ < maxSteps) {
      var mv = policyMove(b, n, color, last, ko, scratch, rnd);
      if (mv < 0) {
        passes++;
        last = -1;
        ko = -1;
        color = 3 - color;
        if (passes >= 2) break;
        continue;
      }
      passes = 0;
      var captured = fastPlay(b, n, mv, color, ko, scratch);
      if (captured < 0) {          // 被占 / 自杀：换手，不落子
        ko = -1;
        last = -1;
        color = 3 - color;
        continue;
      }
      if (color === rootColor && AMAF_BUF[mv] !== amafGen) {
        AMAF_BUF[mv] = amafGen;
        AMAF_TOUCH[touched++] = mv;
      }
      ko = scratch.ko;
      last = mv;
      color = 3 - color;
    }

    var sc = scoreArea(b, n, komi);
    return { diff: sc.diff, touched: touched };
  }

  /* ------------------------------------------------------------------ */
  /* 分析器                                                              */
  /* ------------------------------------------------------------------ */
  function Node(parent, move) {
    this.parent = parent;
    this.move = move;
    this.children = null;
    this.untried = null;
    this.v = 0;
    this.w = 0;
  }

  function Analyzer(pos, opts) {
    opts = opts || {};
    this.n = pos.n;
    this.komi = pos.komi;
    this.rootColor = pos.toMove;
    this.c = opts.c !== undefined ? opts.c : 0.9;
    this.rnd = opts.rnd || Math.random;

    // 根位置的工作副本
    this.rootBoard = new Int8Array(pos.board);
    this.rootKo = pos.ko == null ? -1 : pos.ko;
    this.rootLast = pos.lastMove;
    this.rootPasses = pos.passes || 0;
    this.history = new Set(pos.history);
    this.replyWidth = opts.replyWidth || 0;
    this._work = new Int8Array(this.n * this.n);

    // 合法着点（根）
    this.legal = [];
    var _sc = (this._sc = makeScratch(this.n));
    for (var i = 0; i < this.n * this.n; i++) {
      if (this._validMove(this.rootBoard, i, this.rootColor, this.rootKo)) this.legal.push(i);
    }
    // 根节点先验过滤：去掉一线、自己的真眼、自家地盘里的废着（大幅提高搜索效率）
    this.ownArea = this._ownArea(_sc);
    var reasonable = this.legal.filter(function (mv) { return this._reasonable(mv, _sc); }, this);
    if (reasonable.length) this.legal = reasonable;

    // 战略基准：当前形势（黑视角）
    this.rootEval = evaluate(this.rootBoard, this.n, this.komi);
    this.sign = this.rootColor === BLACK ? 1 : -1;

    // 先验排序，只把模拟次数投在最像样的 K 个点上
    this.stoneCount = 0;
    for (var s0 = 0; s0 < this.rootBoard.length; s0++) if (this.rootBoard[s0]) this.stoneCount++;

    var self = this;
    this.priorOf = new Float64Array(this.n * this.n + 1);
    var scored = [], tactical = [];
    for (var k = 0; k < this.legal.length; k++) {
      var t = this._tacticalScore(this.legal[k], _sc);
      var pv = this._prior(this.legal[k], _sc, t);
      this.priorOf[this.legal[k]] = pv;
      if (pv > -1e8) {
        var item = { mv: this.legal[k], p: pv };
        scored.push(item);
        if (t >= 5) tactical.push(item);      // 提子 / 逃气
      }
    }
    scored.sort(function (a, b) { return b.p - a.p; });

    // 有战术着点时独占候选，避免战略项把它冲淡
    if (tactical.length) {
      tactical.sort(function (a, b) { return b.p - a.p; });
      scored = tactical.slice(0, 6);
    }

    var K = opts.children || 16;
    this.legal = scored.slice(0, K).map(function (o) { return o.mv; });
    // 只有收官阶段（盘面填了过半）或实在无子可下时，才允许停一手
    var allowPass = scored.length === 0 || this.stoneCount >= this.n * this.n * 0.55;
    if (allowPass) this.legal.push(PASS);

    // 根节点
    var root = new Node(null, -1);
    root.untried = this.legal.slice();
    this.root = root;

    this.amafW = new Float64Array(this.n * this.n + 1);
    this.amafV = new Float64Array(this.n * this.n + 1);
    this.visits = 0;
    this.diffs = 0;
    this.diffSum = 0;
    this.diffSq = 0;
    this.scratch = makeScratch(this.n);
    this.amafGen = 0;
    this.started = false;
    this.elapsed = 0;
    this.allowResign = false;
    this._buf = new Int8Array(pos.board);
  }

  Analyzer.prototype._nodeIndex = function (mv) {
    return mv < 0 ? this.n * this.n : mv;
  };

  Analyzer.prototype._validMove = function (board, mv, color, ko) {
    if (board[mv] !== EMPTY || mv === ko) return false;
    this._work.set(board);
    var played = applyMove(this._work, this.n, mv, color, ko);
    if (!played.ok) return false;
    var next = 3 - color;
    return !this.history.has(boardHash(this._work, this.n, next) + '|' + next);
  };

  Analyzer.prototype._replies = function (board, color, last, ko, passes) {
    var sc = this._sc;
    var ctx = makePriorCtx(board, this.n, color, last, sc, this.komi);
    ctx.rootKo = ko;
    var ranked = genMoves(board, this.n, color, last, sc, ctx, this.replyWidth, ko);
    var replies = [];
    for (var i = 0; i < ranked.length && replies.length < this.replyWidth; i++) {
      var mv = ranked[i].mv;
      if (this._validMove(board, mv, color, ko)) replies.push(mv);
    }
    if (!replies.length || (passes && ctx.stoneCount >= this.n * this.n * 0.55)) replies.push(PASS);
    return replies;
  };

  /** 标记「只被我方包围的空区」= 自家地盘，别往里填 */
  Analyzer.prototype._ownArea = function (sc) {
    var n = this.n, b = this.rootBoard, NBR = sc.NBR;
    var map = new Int8Array(n * n);
    var vis = new Int8Array(n * n);
    var stack = new Int32Array(n * n);
    var region = new Int32Array(n * n);
    for (var i = 0; i < n * n; i++) {
      if (b[i] !== EMPTY || vis[i]) continue;
      var top = 0, cnt = 0, hasB = false, hasW = false, j;
      vis[i] = 1; stack[top++] = i; region[cnt++] = i;
      while (top > 0) {
        var s = stack[--top], sn = NBR[s];
        for (j = 0; j < sn.length; j++) {
          var q = sn[j];
          if (b[q] === EMPTY) {
            if (!vis[q]) { vis[q] = 1; stack[top++] = q; region[cnt++] = q; }
          } else if (b[q] === BLACK) hasB = true;
          else hasW = true;
        }
      }
      if (cnt >= 1 && hasB !== hasW) {
        var owner = hasB ? BLACK : WHITE;
        for (j = 0; j < cnt; j++) map[region[j]] = owner;
      }
    }
    return map;
  };

  /** 落子后自己这块只剩 1 气（且没提子）= 自紧一气，属于低级错误 */
  Analyzer.prototype._selfAtari = function (mv, sc) {
    if (!this._work) this._work = new Int8Array(this.n * this.n);
    this._work.set(this.rootBoard);
    var r = applyMove(this._work, this.n, mv, this.rootColor, this.rootKo == null ? -1 : this.rootKo);
    if (!r.ok) return true;
    if (r.captured > 0) return false;               // 提了子就不算
    var gl = groupLibsOf(this._work, this.n, mv);
    return gl.libs === 1;
  };

  Analyzer.prototype._reasonable = function (mv, sc) {
    if (mv < 0) return true;
    var b = this.rootBoard, n = this.n, x = mv % n, y = (mv / n) | 0, i;
    if (eyeCheck(b, sc, mv, this.rootColor)) return false;
    var cap = capturesAt(b, n, mv, this.rootColor, sc);
    if (cap > 0) return true;                       // 能提子，永远值得算
    if (x === 0 || y === 0 || x === n - 1 || y === n - 1) {
      var nb = sc.NBR[mv], near = false;
      for (i = 0; i < nb.length; i++) if (b[nb[i]] === 3 - this.rootColor) near = true;
      if (!near) return false;                      // 一线乱爬
    }
    if (this.ownArea[mv] === this.rootColor) return false;  // 填自家空
    if (this._selfAtari(mv, sc)) return false;              // 自紧一气
    return true;
  };

  /**
   * 单点启发式评分：提子 / 逃气 / 联络 / 逼近 / 位置价值
   * 用它给根节点候选排序，把模拟次数集中在有意义的点上
   */
  /** 纯战术分：提子 / 救自己被打吃的棋 / 紧对方的气（不含位置与形势） */
  Analyzer.prototype._tacticalScore = function (mv, sc) {
    var b = this.rootBoard, n = this.n, color = this.rootColor, opp = 3 - color;
    var cap = capturesAt(b, n, mv, color, sc);
    if (cap < 0) return -1e9;
    var s = 0;
    if (cap > 0) s += 6 + 3 * (cap - 1);
    var nb = sc.NBR[mv], ownAtari = 0, oppAtari = 0;
    for (var i = 0; i < nb.length; i++) {
      var q = nb[i];
      if (b[q] === color) { if (groupLibsIsOne(b, n, q, sc)) ownAtari = 1; }
      else if (b[q] === opp) { if (groupLibsIsOne(b, n, q, sc)) oppAtari = 1; }
    }
    if (ownAtari) s += 5.5;
    if (oppAtari) s += 2.5;
    return s;
  };

  Analyzer.prototype._prior = function (mv, sc, tact) {
    var b = this.rootBoard, n = this.n, color = this.rootColor, opp = 3 - color;
    var x = mv % n, y = (mv / n) | 0;
    var edge = Math.min(x, y, n - 1 - x, n - 1 - y);
    var s = 0, i, j;

    if (tact === undefined) tact = this._tacticalScore(mv, sc);
    if (tact <= -1e8) return -1e9;      // 自杀
    s += tact;

    var nb = sc.NBR[mv], fFriend = 0, fOpp = 0;
    for (i = 0; i < nb.length; i++) {
      var q = nb[i];
      if (b[q] === color) fFriend++;
      else if (b[q] === opp) fOpp++;
    }
    s += fFriend * 0.28;                 // 联络 / 推进
    s += fOpp * 0.42;                    // 贴身缠斗
    s += Math.min(edge, 3) * 0.18;       // 远离一线
    if (edge === 2 || edge === 3) s += 0.3;   // 三四线

    if (this.rootLast >= 0) {
      var lx = this.rootLast % n, ly = (this.rootLast / n) | 0;
      var d = Math.abs(x - lx) + Math.abs(y - ly);
      if (d === 1) s += 0.55;
      else if (d === 2) s += 0.28;
      else if (d === 3 || d === 4) s += 0.1;
    }

    // 空盘 / 开局：优先占角（只在布局阶段给，避免盖掉战术）
    if (fFriend === 0 && fOpp === 0 && this.stoneCount < n * 2) {
      var cx = Math.min(x, n - 1 - x), cy = Math.min(y, n - 1 - y);
      if (edge >= 2 && edge <= 3) {
        if (cx <= 4 && cy <= 4) s += 0.9;   // 角
        else if (cx <= 4 || cy <= 4) s += 0.3;
      }
    }

    // 战略项：这一手对形势的实际收益（围地 / 破空 / 救弱棋 / 不给自己挖坑）
    // 布局阶段形势判断还不可靠（它分不清角与边），先让位给棋理，成形后再逐步加权
    var wStatic = this.stoneCount < 40 ? this.stoneCount / 40 : 1;
    s += this._staticGain(mv) * 1.3 * wStatic;

    return s;
  };

  /** 这一手落下去，静态形势变好多少（我方视角，单位：目） */
  Analyzer.prototype._staticGain = function (mv) {
    if (mv < 0) return 0;
    if (!this._work) { this._work = new Int8Array(this.n * this.n); }
    this._work.set(this.rootBoard);
    var r = applyMove(this._work, this.n, mv, this.rootColor, this.rootKo == null ? -1 : this.rootKo);
    if (!r.ok) return -50;
    var v = evaluate(this._work, this.n, this.komi);
    return this.sign * (v - this.rootEval);
  };

  Analyzer.prototype.runFor = function (ms) {
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var deadline = t0 + ms;
    var guard = 0;
    do {
      this._simulate();
      guard++;
      if ((guard & 15) === 0) {
        var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (now >= deadline) break;
      }
    } while (true);
    var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    this.elapsed += t1 - t0;
  };

  Analyzer.prototype._simulate = function () {
    var n = this.n, b = this._buf;
    b.set(this.rootBoard);
    var node = this.root;
    var color = this.rootColor, ko = this.rootKo, last = this.rootLast;
    var passes = this.rootPasses;

    for (var depth = 0; depth < 2 && passes < 2; depth++) {
      var child;
      if (node.untried && node.untried.length) {
        var mv = depth === 0 ? this._pickUntried(node, color, last) : node.untried[0];
        node.untried.splice(node.untried.indexOf(mv), 1);
        child = new Node(node, mv);
        if (!node.children) node.children = [];
        node.children.push(child);
      } else if (node.children && node.children.length) {
        child = this._select(node, color);
      } else {
        break;
      }

      var played = applyMove(b, n, child.move, color, ko);
      if (!played.ok) break;
      ko = played.ko;
      last = child.move;
      passes = last < 0 ? passes + 1 : 0;
      color = 3 - color;
      node = child;

      // 高难度显式搜索对手应手，候选每个根着点只生成一次。
      if (depth === 0 && this.replyWidth && node.untried === null && passes < 2) {
        node.untried = this._replies(b, color, last, ko, passes);
      }
    }

    // 推演
    this.amafGen++;
    var res = playout(b, n, color, ko, this.komi, this.scratch, this.rnd, this.rootColor,
      this.amafGen, passes, this.replyWidth ? last : -1);
    var diff = res.diff;

    // 回传
    var cur = node;
    var rootWin = diff === 0 ? 0.5 : (this.rootColor === BLACK ? diff > 0 : diff < 0) ? 1 : 0;
    while (cur) {
      cur.v++;
      cur.w += rootWin;
      cur = cur.parent;
    }

    this.visits++;
    this.diffSum += diff;
    this.diffSq += diff * diff;

    // 根 AMAF
    for (var i = 0; i < res.touched; i++) {
      var mvA = AMAF_TOUCH[i];
      var idxA = this._nodeIndex(mvA);
      this.amafV[idxA]++;
      this.amafW[idxA] += rootWin;
    }
  };

  Analyzer.prototype._select = function (node, color) {
    var kids = node.children, best = null, bestScore = -1e9;
    var logN = Math.log(node.v + 1);
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      var q = k.v ? k.w / k.v : 0.5;
      if (color !== this.rootColor) q = 1 - q;
      var u = this.c * Math.sqrt(logN / (k.v + 1));
      var s = q + u;
      if (s > bestScore) { bestScore = s; best = k; }
    }
    return best || node;
  };

  Analyzer.prototype._pickUntried = function (node, color, last) {
    var list = node.untried;
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    var NBR = this.scratch.NBR;
    var best = null, bestScore = -1e9;
    var sample = Math.min(10, list.length);
    for (var t = 0; t < sample; t++) {
      var mv = list[(this.rnd() * list.length) | 0];
      var score = 0;
      if (mv < 0) score = -0.2;
      else {
        var nb = NBR[mv];
        for (var j = 0; j < nb.length; j++) {
          var q = nb[j];
          if (this.rootBoard[q] === 3 - color) score += 0.35;
          else if (this.rootBoard[q] === color) score += 0.12;
        }
        if (last >= 0) {
          var lx = mv % this.n, ly = (mv / this.n) | 0;
          var px = last % this.n, py = (last / this.n) | 0;
          var d = Math.abs(lx - px) + Math.abs(ly - py);
          if (d === 1) score += 0.5;
          else if (d === 2) score += 0.2;
        }
        // 靠边稍减
        var x = mv % this.n, y = (mv / this.n) | 0;
        var edge = Math.min(x, y, this.n - 1 - x, this.n - 1 - y);
        score += Math.min(edge, 3) * 0.05;
      }
      if (score > bestScore) { bestScore = score; best = mv; }
    }
    return best;
  };

  Analyzer.prototype.stats = function () {
    var root = this.root;
    var total = root.v || 1;
    var color = this.rootColor;
    var blackWin = 0, whiteWin = 0, v = 0, w = 0;
    if (root.children) {
      for (var i = 0; i < root.children.length; i++) {
        var k = root.children[i];
        var qi = k.v ? k.w / k.v : 0;
        var bias = 0;
        var idx = this._nodeIndex(k.move);
        var av = this.amafV[idx], aw = this.amafW[idx];
        var a = av / (av + k.v + 80);
        var q = (1 - a) * qi + a * (av ? aw / av : qi);
        if (k.v > 0 && q > blackWin) {
          blackWin = q; whiteWin = 1 - q; v = k.v; w = k.w;
        }
      }
    }
    // 根胜率 = 根走方胜率
    var rootWinrate = root.v ? root.w / root.v : 0.5;
    var blackWinrate = color === BLACK ? rootWinrate : 1 - rootWinrate;

    var candidates = [];
    if (root.children) {
      for (var i2 = 0; i2 < root.children.length; i2++) {
        var c2 = root.children[i2];
        if (!c2.v) continue;
        var idx2 = this._nodeIndex(c2.move);
        var av2 = this.amafV[idx2], aw2 = this.amafW[idx2];
        var a2 = av2 / (av2 + c2.v + 80);
        var q2 = (1 - a2) * (c2.w / c2.v) + a2 * (av2 ? aw2 / av2 : 0);
        var wr = color === BLACK ? q2 : 1 - q2;
        candidates.push({ move: c2.move, visits: c2.v, winrate: wr, q: q2 });
      }
      candidates.sort(function (x, y) { return y.visits - x.visits; });
    }

    var nps = this.elapsed > 0 ? Math.round(this.visits / (this.elapsed / 1000)) : 0;
    var meanDiff = this.visits ? this.diffSum / this.visits : 0;
    var variance = this.visits > 1 ? Math.max(0, this.diffSq / this.visits - meanDiff * meanDiff) : 0;

    // 目差直接来自形势判断，不再由胜率反推（反推会把信心不足的胜率放大成夸张的目数）
    var sCount = 0;
    for (var si2 = 0; si2 < this.rootBoard.length; si2++) if (this.rootBoard[si2]) sCount++;
    var sConf = Math.min(1, sCount / 60 + 1);
    var leadMapped = Math.round(evaluate(this.rootBoard, this.n, this.komi) * sConf * 2) / 2;

    return {
      visits: this.visits,
      elapsed: Math.round(this.elapsed),
      nps: nps,
      blackWinrate: blackWinrate,
      winrate: blackWinrate,
      sideWinrate: rootWinrate,
      scoreLead: leadMapped,        // 正 = 黑领先（目）
      whiteLead: -leadMapped,
      rawScoreLead: meanDiff,       // 推演平均目差（噪声大，仅供参考）
      stderr: Math.sqrt(variance / Math.max(1, this.visits)),
      bestMove: candidates.length ? candidates[0].move : (this.legal.length ? this.legal[0] : PASS),
      candidates: candidates.slice(0, 8)
    };
  };

  /* ------------------------------------------------------------------ */
  /* 静态形势判断：影响函数(Bouzy 式扩张) + 弱棋惩罚                      */
  /* ------------------------------------------------------------------ */
  var INF_A = new Float32Array(MAXP), INF_B = new Float32Array(MAXP);
  var GRP_VIS = new Int32Array(MAXP), GRP_GEN = 0;

  function influence(b, n, passes) {
    var NBR = neighbors(n), m = n * n, i, j, k;
    var a = INF_A, c = INF_B;
    for (i = 0; i < m; i++) a[i] = b[i] === BLACK ? 1 : (b[i] === WHITE ? -1 : 0);
    for (k = 0; k < passes; k++) {
      for (i = 0; i < m; i++) {
        var v = a[i];
        var nb = NBR[i], sp = 0, sn = 0, j2;
        for (j2 = 0; j2 < nb.length; j2++) {
          var w = a[nb[j2]];
          if (w > 0) sp += w; else if (w < 0) sn += w;
        }
        var off = 4 - nb.length;          // 缺几个方向（边/角）
        if (v > 0) {
          c[i] = v + sp * 0.6 + (off ? v * off * 0.15 : 0);
        } else if (v < 0) {
          c[i] = v + sn * 0.6 - (off ? (-v) * off * 0.15 : 0);
        } else {
          // 空地按邻居净影响扩散——这是原实现漏掉的一步
          var s2 = sp + sn;
          c[i] = s2 * 0.55;
        }
      }
      var t = a; a = c; c = t;
    }
    if (a !== INF_A) { INF_A.set(a); }
    return INF_A;
  }

  var LAST_AREA = 0;   // 上一次 evaluate 统计到的"已确定面积"，用于折算先手价值

  /** 以黑棋视角的目差（正 = 黑好） */
  function evaluate(b, n, komi) {
    var m = n * n, NBR = neighbors(n), i, j;
    var inf = influence(b, n, 3);
    var black = 0, white = 0;

    for (i = 0; i < m; i++) {
      if (b[i] === BLACK) { black++; continue; }
      if (b[i] === WHITE) { white++; continue; }
      // 只有影响足够强（接近被包围）才算实地；门槛低了，一颗子就能"占"七八目
      var v = inf[i];
      if (v >= 6) { var bv = v / 10; black += bv > 1 ? 1 : bv; }
      else if (v <= -6) { var wv = -v / 10; white += wv > 1 ? 1 : wv; }
    }

    // 弱棋惩罚：只剩 1~2 气的棋块随时会被吃，不能算作实地
    GRP_GEN++;
    for (i = 0; i < m; i++) {
      var col = b[i];
      if (!col || GRP_VIS[i] === GRP_GEN) continue;
      var top = 0, cnt = 1, libs = 0, libG = ++libGen;
      STACK[top++] = i; GRP_VIS[i] = GRP_GEN;
      while (top > 0) {
        var s = STACK[--top];
        var sn = NBR[s];
        for (j = 0; j < sn.length; j++) {
          var q = sn[j];
          if (b[q] === EMPTY) { if (LIBSEEN[q] !== libG) { LIBSEEN[q] = libG; libs++; } }
          else if (b[q] === col && GRP_VIS[q] !== GRP_GEN) {
            GRP_VIS[q] = GRP_GEN; STACK[top++] = q; cnt++;
          }
        }
      }
      var pen = 0;
      if (libs === 1) pen = (cnt + 1) * 1.6;
      else if (libs === 2) pen = cnt * 0.55;
      if (pen) { if (col === BLACK) black -= pen; else white -= pen; }
    }
    LAST_AREA = black + white;
    return black - white - komi;
  }

  /* ------------------------------------------------------------------ */
  /* 主搜索：候选生成 → 我方一手 → 对手最强应手 → 静态形势判断            */
  /* ------------------------------------------------------------------ */
  function makePriorCtx(board, n, color, last, sc, komi) {
    var ctx = Object.create(Analyzer.prototype);
    ctx.n = n;
    ctx.rootBoard = board;
    ctx.rootColor = color;
    ctx.rootLast = last < 0 ? -1 : last;
    var stones = 0;
    for (var i = 0; i < board.length; i++) if (board[i]) stones++;
    ctx.stoneCount = stones;
    ctx.ownArea = ctx._ownArea(sc);
    ctx.komi = komi == null ? 7.5 : komi;
    ctx.rootKo = -1;
    ctx._work = new Int8Array(n * n);
    ctx.rootEval = evaluate(board, n, ctx.komi);
    ctx.sign = color === BLACK ? 1 : -1;
    return ctx;
  }

  function genMoves(board, n, color, last, sc, ctx, limit, ko) {
    var out = [], i, m = n * n;
    for (i = 0; i < m; i++) {
      if (board[i] !== EMPTY) continue;
      if (i === ko) continue;
      if (capturesAt(board, n, i, color, sc) < 0) continue;   // 自杀
      if (ctx && !ctx._reasonable(i, sc)) continue;
      out.push({ mv: i, p: ctx ? ctx._prior(i, sc) : 0 });
    }
    out.sort(function (a, b) { return b.p - a.p; });
    var tact = [];
    for (i = 0; i < out.length; i++) if (out[i].p >= 5) tact.push(out[i]);
    var list = tact.length ? tact.slice(0, Math.max(limit, 6)) : out.slice(0, limit);
    return list;
  }

  /** 用"静态评价 + 两层"算一手：返回与 analyze 兼容的结构 */
  function staticAnalyze(pos, opts) {
    opts = opts || {};
    var n = pos.n, m = n * n, komi = pos.komi;
    var color = pos.toMove, opp = 3 - color;
    var sc = makeScratch(n);
    var root = new Int8Array(pos.board);
    var work = new Int8Array(m), reply = new Int8Array(m);
    var ko = pos.ko == null ? -1 : pos.ko;
    var last = pos.lastMove == null ? -1 : pos.lastMove;

    var base = evaluate(root, n, komi);
    var evals = 0;
    var ctx = makePriorCtx(root, n, color, last, sc, komi);
    var cands = genMoves(root, n, color, last, sc, ctx, opts.width || 18, ko);
    var sign = color === BLACK ? 1 : -1;

    // 对手可选应手（用于最坏情况评估）
    function worstAfter(board) {
      var ctxO = makePriorCtx(board, n, opp, -1, sc, komi);
      var reps = genMoves(board, n, opp, -1, sc, ctxO, 8, -1);
      var worst = null;
      for (var k = 0; k < reps.length; k++) {
        reply.set(board);
        var r = applyMove(reply, n, reps[k].mv, opp, -1);
        if (!r.ok) continue;
        var v = evaluate(reply, n, komi); evals++;
        if (worst === null || (opp === BLACK ? v > worst : v < worst)) worst = v;
      }
      return worst;
    }

    var results = [];
    for (var c = 0; c < cands.length; c++) {
      work.set(root);
      var mv = cands[c].mv;
      var r2 = applyMove(work, n, mv, color, ko);
      if (!r2.ok) continue;
      var v = evaluate(work, n, komi); evals++;
      var w = worstAfter(work);
      if (w !== null) v = opp === BLACK ? Math.max(v, w) : Math.min(v, w);
      // 换算成"我方视角的收益"
      results.push({ mv: mv, gain: sign * (v - base), lead: v, prior: cands[c].p });
    }

    // 停一手也作为一个候选：等于让对手先走
    var passVal = worstAfter(root);
    if (passVal === null) passVal = base;
    results.push({ mv: PASS, gain: sign * (passVal - base), lead: passVal, prior: -0.5 });

    results.sort(function (a, b) { return b.gain - a.gain; });

    var best = results[0];
    // 盘面信息不足时（开局）形势判断不可靠，向 50% 收敛，避免"空盘就报 30%"
    var stoneCount = 0;
    for (var si = 0; si < root.length; si++) if (root[si]) stoneCount++;
    // 贴目权重：让"黑倒贴 7.5 目"直接体现在开局胜率上
    // 1 = 完全体现（空盘黑 ≈ 30%）；0.5 左右会把开局拉回 42%；0 = 完全按潜力看（接近 50%）
    var komiWeight = opts.komiWeight == null ? 1 : opts.komiWeight;
    var confidence = Math.min(1, stoneCount / 60 + komiWeight);
    var lead = (best ? best.lead : base) * confidence;
    if (!best) best = { mv: PASS, gain: 0, lead: lead };

    // 没有任何像样的着点（空区都在自己地里 / 都是真眼）→ 停一手
    if (!cands.length) best = { mv: PASS, gain: 0, lead: lead };

    var wrC = 1 / (1 + Math.exp(-(lead) / 9));
    var blackWin = Math.min(0.985, Math.max(0.015, wrC));

    var candsOut = [];
    for (var q = 0; q < results.length && candsOut.length < 8; q++) {
      var rr = results[q];
      if (rr.mv === PASS && rr.gain < -1) continue;
      var l2 = rr.lead * confidence;
      candsOut.push({
        move: rr.mv,
        visits: Math.max(1, Math.round(30 + (rr.gain - results[results.length - 1].gain) * 12)),
        winrate: Math.min(0.99, Math.max(0.01, 1 / (1 + Math.exp(-l2 / 9))))
      });
    }

    return {
      visits: evals,
      elapsed: 0,
      nps: 0,
      engine: 'static',
      blackWinrate: blackWin,
      winrate: blackWin,
      sideWinrate: color === BLACK ? blackWin : 1 - blackWin,
      scoreLead: Math.round(lead * 2) / 2,
      whiteLead: -Math.round(lead * 2) / 2,
      rawScoreLead: lead,
      stderr: 0,
      bestMove: best ? best.mv : PASS,
      candidates: candsOut
    };
  }

  /* ------------------------------------------------------------------ */
  /* 混合决策：MCTS 负责战术（提子/对杀），静态形势判断负责战略（围地/废棋） */
  /* ------------------------------------------------------------------ */
  function groupLibsOf(b, n, at) {
    var NBR = neighbors(n), color = b[at];
    if (!color) return { size: 0, libs: 0 };
    var top = 0, size = 1, libs = 0, libG = ++libGen, mg = ++markGen;
    STACK[top++] = at; MARK[at] = mg;
    while (top > 0) {
      var s = STACK[--top], sn = NBR[s];
      for (var j = 0; j < sn.length; j++) {
        var q = sn[j];
        if (b[q] === EMPTY) { if (LIBSEEN[q] !== libG) { LIBSEEN[q] = libG; libs++; } }
        else if (b[q] === color && MARK[q] !== mg) { MARK[q] = mg; STACK[top++] = q; size++; }
      }
    }
    return { size: size, libs: libs };
  }

  function finalizeHybrid(pos, analyzer, opts) {
    var n = pos.n, m = n * n, komi = pos.komi, color = pos.toMove;
    var st = analyzer.stats();
    var base = new Int8Array(pos.board);
    var work = new Int8Array(m);
    var ko = pos.ko == null ? -1 : pos.ko;
    var stoneCount = 0;
    for (var s0 = 0; s0 < m; s0++) if (base[s0]) stoneCount++;
    // 贴目权重：让"黑倒贴 7.5 目"直接体现在开局胜率上
    // 1 = 完全体现（空盘黑 ≈ 30%）；0.5 左右会把开局拉回 42%；0 = 完全按潜力看（接近 50%）
    var komiWeight = opts.komiWeight == null ? 1 : opts.komiWeight;
    var confidence = Math.min(1, stoneCount / 60 + komiWeight);
    var wStatic = opts.staticWeight == null ? 0.5 : opts.staticWeight;

    var src = st.candidates.length ? st.candidates : [{ move: st.bestMove, visits: 1, winrate: st.blackWinrate }];
    var out = [], best = null, bestScore = -1, bestLead = 0;

    for (var i = 0; i < src.length && i < 10; i++) {
      var mv = src[i].move, lead, ok = true;
      if (mv < 0) {
        lead = evaluate(base, n, komi);
      } else {
        work.set(base);
        var r = applyMove(work, n, mv, color, ko);
        if (!r.ok) continue;
        // 自紧一气一律剔除（提子除外），最佳手也不豁免
        if (r.captured === 0) {
          var gl = groupLibsOf(work, n, mv);
          if (gl.libs === 1) ok = false;
        }
        lead = evaluate(work, n, komi);
      }
      if (!ok) continue;

      var sWr = 1 / (1 + Math.exp(-lead / 9));
      var combined = (1 - wStatic) * src[i].winrate + wStatic * sWr;
      var moverScore = color === BLACK ? combined : 1 - combined;
      out.push({ move: mv, visits: src[i].visits, moverScore: moverScore, lead: lead, mwr: src[i].winrate });
      if (moverScore > bestScore) { bestScore = moverScore; best = mv; bestLead = lead; }
    }

    if (!out.length) return st;

    out.sort(function (a, b) { return b.moverScore - a.moverScore; });

    // 选点：默认沿用 MCTS 的判断（战术更可靠），若它落在被剔除的废着上则退到静态最优
    var pick = opts.pick || 'mcts';
    if (pick === 'mcts') {
      var mctsBest = st.bestMove, found = null;
      for (var bi = 0; bi < out.length; bi++) if (out[bi].move === mctsBest) { found = out[bi]; break; }
      if (found) { best = found.move; bestLead = found.lead; }
      else { best = out[0].move; bestLead = out[0].lead; }
    }

    // 胜率与目差同源：都来自同一套形势判断，保证两个数字永远自洽
    // 展示用的是"当前局面"的形势（不是落子之后），这样开局才会如实体现贴目
    var baseLead = evaluate(base, n, komi);
    var baseArea = LAST_AREA;          // 必须紧跟 evaluate(base) 取，否则会被候选评估覆盖
    var leadShow = baseLead * confidence;
    // 面板口径：搜索 + 静态加权，但权重随盘面成熟度变化。
    // 搜索的目差来自随机推演，空盘时天然偏向先走的黑棋（每个推演多抢 2~3 目），
    // 所以开局只信静态（它如实算贴目），有子了再逐步交给搜索（它看得见杀棋）。
    var blend = opts.blend == null ? 0.7 : opts.blend;
    var searchLead = st.rawScoreLead == null ? baseLead : st.rawScoreLead;
    var stonesOnBoard = 0;
    for (var sIdx = 0; sIdx < base.length; sIdx++) if (base[sIdx]) stonesOnBoard++;
    var wSearch = blend * Math.min(1, stonesOnBoard / 30);
    var dispLead = (wSearch * searchLead + (1 - wSearch) * baseLead) * confidence;
    var blackWin = Math.min(0.99, Math.max(0.01, 1 / (1 + Math.exp(-dispLead / 9))));

    // 终局（双方停手）按实际数子定胜负，不再用形势判断估
    if (pos.passes >= 2) {
      var fin = scoreArea(base, n, komi);
      leadShow = fin.diff;
      blackWin = fin.diff > 0 ? 0.99 : (fin.diff < 0 ? 0.01 : 0.5);
    }
    // 候选列表用"相对最佳手损失多少目"来表达，比绝对胜率有区分度
    function moverWr(w) { return color === BLACK ? w : 1 - w; }
    var bestMw = 0;
    for (var q0 = 0; q0 < out.length; q0++) {
      var w0 = moverWr(out[q0].mwr);
      if (w0 > bestMw) bestMw = w0;
    }
    var cands = [];
    for (var k = 0; k < out.length && k < 8; k++) {
      var lc = out[k].lead * confidence;
      var wM = moverWr(out[k].mwr);
      var loss = (bestMw - wM) * 36;                 // 胜率差换算成目
      if (loss < 0) loss = 0;
      cands.push({
        move: out[k].move,
        visits: out[k].visits,
        loss: Math.round(loss * 10) / 10,
        winrate: Math.min(0.99, Math.max(0.01, 1 / (1 + Math.exp(-lc / 9))))
      });
    }
    cands.sort(function (a, b) { return b.visits - a.visits; });   // 按模拟量从大到小

    return {
      visits: st.visits,
      elapsed: st.elapsed,
      nps: st.nps,
      engine: 'hybrid',
      blackWinrate: blackWin,
      winrate: blackWin,
      sideWinrate: color === BLACK ? blackWin : 1 - blackWin,
      scoreLead: Math.round(dispLead * 2) / 2,
      whiteLead: -Math.round(dispLead * 2) / 2,
      searchLead: Math.round(searchLead * 2) / 2,
      staticLead: Math.round(baseLead * 2) / 2,
      rawScoreLead: baseLead,
      mctsWinrate: st.blackWinrate,      // 搜索自身的胜率（黑视角，推演已含贴目）
      mctsLead: st.rawScoreLead,         // 搜索推演的平均目差
      staticWinrate: blackWin,           // 静态形势判断给出的胜率
      stderr: st.stderr,
      bestMove: best,
      candidates: cands
    };
  }

  /* ------------------------------------------------------------------ */
  /* 对外 API                                                            */
  /* ------------------------------------------------------------------ */
  function createAnalysis(pos, opts) {
    opts = opts || {};
    var engine = opts.engine || 'mcts';
    var lv = levelOf(opts);
    var runOpts = withPick(opts, opts.pick || 'mcts');
    if (opts.children == null) runOpts.children = lv.children;
    if (opts.replyWidth == null) runOpts.replyWidth = lv.replyWidth;
    var blunder = opts.blunder != null ? opts.blunder : (opts.level ? lv.blunder : 0);

    if (engine === 'eval') {
      var done = null;
      return {
        step: function () {
          if (!done) { var t0 = Date.now(); done = staticAnalyze(pos, opts); done.elapsed = Date.now() - t0; }
          return done;
        },
        stats: function () { return done || this.step(0); },
        visits: function () { return done ? done.visits : 0; }
      };
    }

    var a = new Analyzer(pos, runOpts);
    var budget = opts.timeMs || lv.timeMs || 900;
    var start = Date.now();
    var finalized = null;

    return {
      step: function (ms) {
        if (finalized) return finalized;
        a.runFor(ms);
        if (Date.now() - start >= budget) {
          finalized = finalizeHybrid(pos, a, engine === 'hybrid' ? withPick(runOpts, 'blend') : runOpts);
          finalized.level = lv.name;
          finalized.blunder = blunder;
          finalized = applyBlunder(finalized, blunder, null, lv.pool);
          return finalized;
        }
        return liveStats(a.stats(), pos, opts);
      },
      stats: function () { return finalized || a.stats(); },
      visits: function () { return a.visits; },
      analyzer: a
    };
  }

  /** 思考过程中的即时形势（只做一次静态判断，用于面板实时刷新，保证和定稿口径一致） */
  function liveStats(st, pos, opts) {
    var n = pos.n, m = n * n, stones = 0;
    for (var i = 0; i < m; i++) if (pos.board[i]) stones++;
    var komiWeight = opts && opts.komiWeight != null ? opts.komiWeight : 1;
    var conf = Math.min(1, stones / 60 + komiWeight);
    var lead = evaluate(pos.board, n, pos.komi) * conf;
    var wr = Math.min(0.99, Math.max(0.01, 1 / (1 + Math.exp(-lead / 9))));
    var out = {};
    for (var k in st) if (Object.prototype.hasOwnProperty.call(st, k)) out[k] = st[k];
    out.blackWinrate = wr;
    out.winrate = wr;
    out.sideWinrate = pos.toMove === BLACK ? wr : 1 - wr;
    out.scoreLead = Math.round(lead * 2) / 2;
    out.whiteLead = -out.scoreLead;
    return out;
  }

  // 复盘和胜率曲线可直接静态估算，无需为每个局面创建搜索树。
  function estimate(pos) {
    return liveStats({ candidates: [], visits: 0 }, pos);
  }

  /* ------------------------------------------------------------------ */
  /* 难度分级                                                            */
  /* ------------------------------------------------------------------ */
  // blunder = 不走最佳手的概率（走第 2~5 候选），children = 根节点候选宽度
  var LEVELS = {
    beginner: { name: '入门', timeMs: 250, children: 6, blunder: 0.5, pool: 8 },
    novice: { name: '新手', timeMs: 600, children: 10, blunder: 0.26, pool: 6 },
    normal: { name: '进阶', timeMs: 1400, children: 16, blunder: 0.08, pool: 4 },
    strong: { name: '强手', timeMs: 3500, children: 22, blunder: 0.02, pool: 3 },
    master: { name: '大师', timeMs: 7500, children: 28, replyWidth: 6, blunder: 0, pool: 2 }
  };

  function levelOf(opts) {
    var lv = opts && opts.level && LEVELS[opts.level];
    return lv || LEVELS.normal;
  }

  /** 按失误率降级选点：以 p 的概率改走第 2~5 候选 */
  function applyBlunder(res, p, rnd, width) {
    if (!p || !res || !res.candidates) return res;
    rnd = rnd || Math.random;
    if (rnd() >= p) return res;
    var limit = width || 4, pool = [];
    for (var i = 1; i < res.candidates.length && i <= limit; i++) {
      if (res.candidates[i].move >= 0) pool.push(res.candidates[i].move);
    }
    if (!pool.length) return res;
    res.bestMove = pool[(rnd() * pool.length) | 0];
    res.blundered = true;
    return res;
  }

  function withPick(opts, pick) {
    var o = {};
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    o.pick = pick;
    return o;
  }

  function analyze(pos, opts) {
    opts = opts || {};
    var engine = opts.engine || 'mcts';
    var lv = levelOf(opts);
    var t0 = Date.now();
    // level 决定宽度；显式传的 children / timeMs / blunder 优先
    var runOpts = withPick(opts, opts.pick || 'mcts');
    if (opts.children == null) runOpts.children = lv.children;
    if (opts.replyWidth == null) runOpts.replyWidth = lv.replyWidth;
    // 只有显式指定 level（对局）才引入失误；提示/分析等场景默认零失误
    var blunder = opts.blunder != null ? opts.blunder : (opts.level ? lv.blunder : 0);

    if (engine === 'eval') {
      var res0 = staticAnalyze(pos, runOpts);
      res0.elapsed = Date.now() - t0;
      res0.nps = res0.elapsed > 0 ? Math.round(res0.visits / (res0.elapsed / 1000)) : 0;
      res0.level = lv.name;
      return applyBlunder(res0, blunder, null, lv.pool);
    }

    var a = new Analyzer(pos, runOpts);
    var visits = opts.visits || 0;
    var timeMs = opts.timeMs || (visits ? 0 : lv.timeMs);
    while (true) {
      a.runFor(15);
      if (visits && a.visits >= visits) break;
      if (timeMs && Date.now() - t0 >= timeMs) break;
    }
    var out = finalizeHybrid(pos, a, runOpts);
    out.elapsed = Date.now() - t0;
    out.nps = out.elapsed > 0 ? Math.round(out.visits / (out.elapsed / 1000)) : 0;
    out.level = lv.name;
    out.blunder = blunder;
    return applyBlunder(out, blunder, null, lv.pool);
  }

  /* ------------------------------------------------------------------ */
  /* 让子                                                                */
  /* ------------------------------------------------------------------ */
  /** 标准让子点（星位），返回 [x,y] 列表，按让子数给出 */
  function handicapPoints(n, count) {
    var e = n >= 13 ? 3 : 2;
    var mid = Math.round((n - 1) / 2);
    var TL = [e, e], TR = [n - 1 - e, e], BL = [e, n - 1 - e], BR = [n - 1 - e, n - 1 - e];
    var L = [e, mid], R = [n - 1 - e, mid], T = [mid, e], B = [mid, n - 1 - e], C = [mid, mid];
    var list;
    switch (count) {
      case 2: list = [TR, BL]; break;
      case 3: list = [TR, BL, TL]; break;
      case 4: list = [TR, BL, TL, BR]; break;
      case 5: list = [TR, BL, TL, BR, C]; break;
      case 6: list = [TR, BL, TL, BR, L, R]; break;
      case 7: list = [TR, BL, TL, BR, L, R, C]; break;
      case 8: list = [TR, BL, TL, BR, L, R, T, B]; break;
      case 9: list = [TR, BL, TL, BR, L, R, T, B, C]; break;
      default: list = [];
    }
    return list.slice(0, Math.max(0, Math.min(9, count)));
  }

  /**
   * 开让子局：黑方先在星位摆好让子，白先走。
   * @param {number} size 棋盘路数
   * @param {number} stones 让子数（2~9；0 或 1 等于分先）
   * @param {{komi?:number}} opts 不传时：让子局贴目 0，分先贴 7.5
   */
  function handicapPosition(size, stones, opts) {
    opts = opts || {};
    size = size || 19;
    stones = stones || 0;
    var isHandicap = stones >= 1;
    // 让一子 = 黑先且不贴目（等价于让出 7.5 目的贴目）；让 2 子起才真正摆子
    var komi = opts.komi != null ? opts.komi : (isHandicap ? 0 : 7.5);
    var p = newPosition(size, komi);
    p.handicap = isHandicap ? stones : 0;
    var pts = handicapPoints(size, stones);
    for (var i = 0; i < pts.length; i++) {
      p.board[pts[i][1] * size + pts[i][0]] = BLACK;
    }
    p.toMove = stones >= 2 ? WHITE : BLACK;   // 让 2 子以上白先；让一子仍黑先
    p.lastMove = -1;
    p.hash = boardHash(p.board, size, p.toMove);
    p.history = [p.hash + '|' + p.toMove];
    return p;
  }

  /** 从 ASCII 图导入局面（. 空 / X 黑 / O 白） */
  function fromAscii(str, komi) {
    var rows = str.trim().split('\n').map(function (r) { return r.trim(); }).filter(Boolean);
    var n = rows.length;
    var p = newPosition(n, komi);
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        var ch = rows[y][x];
        p.board[y * n + x] = ch === 'X' || ch === 'x' || ch === 'B' || ch === 'b' ? BLACK
          : (ch === 'O' || ch === 'o' || ch === 'W' || ch === 'w' ? WHITE : EMPTY);
      }
    }
    p.hash = boardHash(p.board, n, p.toMove);
    p.history = [p.hash + '|' + p.toMove];
    return p;
  }

  function toAscii(p) {
    var out = [];
    for (var y = 0; y < p.n; y++) {
      var row = '';
      for (var x = 0; x < p.n; x++) {
        var v = p.board[y * p.n + x];
        row += v === BLACK ? 'X' : v === WHITE ? 'O' : '.';
      }
      out.push(row);
    }
    return out.join('\n');
  }

  var GO = {
    EMPTY: EMPTY, BLACK: BLACK, WHITE: WHITE, PASS: PASS,
    newPosition: newPosition,
    clonePosition: clonePosition,
    play: play,
    score: score,
    scoreArea: scoreArea,
    estimate: estimate,
    analyze: analyze,
    createAnalysis: createAnalysis,
    LEVELS: LEVELS,
    handicapPosition: handicapPosition,
    handicapPoints: handicapPoints,
    fromAscii: fromAscii,
    toAscii: toAscii,
    neighbors: neighbors,
    isSelfEye: isSelfEye,
    capturesAt: capturesAt,
    makeScratch: makeScratch,
    boardHash: boardHash
  };

  root.GoEngine = GO;
  if (typeof module !== 'undefined' && module.exports) module.exports = GO;
})(typeof globalThis !== 'undefined' ? globalThis : this);
