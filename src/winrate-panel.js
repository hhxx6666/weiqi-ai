/*!
 * winrate-panel.js — 围棋实时胜率面板（可直接嵌入现有页面）
 * ---------------------------------------------------------------
 * 依赖: go-engine.js（必须先加载，暴露 window.GoEngine）
 * 用法:
 *   const panel = GoWinratePanel.mount(el, { size: 19, komi: 7.5, thinkMs: 900 });
 *   panel.update({ board: Int8Array(361), toPlay: 1, lastMove: 60 });
 *   panel.destroy();
 *
 * 面板只做「分析 + 展示」，不改变棋局状态，不与服务端交互。
 */
(function (root) {
  'use strict';

  var STYLE_ID = 'gw-panel-style';

  var CSS = `
  .gw-panel{--gw-accent:#2456b8;--gw-ink:#242424;--gw-muted:#666;--gw-line:#e3e3e3;
    display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--gw-ink);}
  .gw-card{background:#fff;border:1px solid var(--gw-line);border-radius:14px;padding:13px 14px;}
  .gw-card h3{margin:0 0 10px;font-size:11.5px;font-weight:600;color:var(--gw-muted);
    letter-spacing:.6px;text-transform:uppercase;}
  .gw-head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:7px;}
  .gw-side{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--gw-muted);}
  .gw-dot{width:11px;height:11px;border-radius:50%;display:inline-block;}
  .gw-dot.b{background:#1a1a1a;}
  .gw-dot.w{background:#fff;border:1px solid #c8c8c8;}
  .gw-num{font-size:25px;font-weight:700;line-height:1;letter-spacing:-.5px;}
  .gw-bar{height:11px;border-radius:999px;overflow:hidden;display:flex;background:#ececec;
    border:1px solid var(--gw-line);}
  .gw-bar i{display:block;height:100%;transition:width .4s cubic-bezier(.35,0,.35,1);}
  .gw-bar .b{background:linear-gradient(90deg,#3a3a3a,#111);}
  .gw-bar .w{background:linear-gradient(90deg,#fdfdfd,#e2e2e2);}
  .gw-meta{display:flex;justify-content:space-between;margin-top:8px;font-size:12px;color:var(--gw-muted);}
  .gw-meta b{color:var(--gw-ink);font-weight:600;}
  .gw-curve{width:100%;height:78px;display:block;margin-top:6px;}
  .gw-curve[role="slider"]:not([aria-disabled="true"]){cursor:pointer;}
  .gw-curve[role="slider"]:focus-visible{outline:2px solid var(--gw-accent);outline-offset:2px;}
  .gw-cands{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;}
  .gw-cands li{display:grid;grid-template-columns:18px 44px 1fr 42px;gap:7px;align-items:center;
    font-size:12px;color:var(--gw-muted);padding:4px 6px;border-radius:7px;background:#fafafa;}
  .gw-cands li:first-child{background:#eef3fd;color:var(--gw-ink);}
  .gw-cands .rk{color:#aaa;font-variant-numeric:tabular-nums;}
  .gw-cands .mv{font-weight:600;color:var(--gw-ink);font-variant-numeric:tabular-nums;}
  .gw-cands .bar{height:5px;border-radius:999px;background:#e6e6e6;overflow:hidden;}
  .gw-cands .bar i{display:block;height:100%;background:var(--gw-accent);opacity:.75;}
  .gw-cands .v{text-align:right;font-variant-numeric:tabular-nums;font-size:11.5px;}
  .gw-think{display:flex;align-items:center;gap:7px;margin-top:10px;font-size:12px;color:var(--gw-muted);}
  .gw-spin{width:10px;height:10px;border-radius:50%;border:2px solid #d5ddea;border-top-color:var(--gw-accent);
    animation:gw-sp .7s linear infinite;}
  @keyframes gw-sp{to{transform:rotate(360deg)}}
  .gw-empty{color:#aaa;font-size:12px;}
  `;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  var LET = 'ABCDEFGHJKLMNOPQRST';
  function coord(idx, n) {
    if (idx < 0) return '停一手';
    return LET[idx % n] + (n - Math.floor(idx / n));
  }

  function signature(board, toPlay) {
    var h = toPlay * 1000003;
    for (var i = 0; i < board.length; i++) h = (h * 31 + board[i]) | 0;
    return h;
  }

  /** 兼容多种盘面写法：Int8Array / 二维数组 / 字符串行 */
  function normalizeBoard(input, n) {
    if (!input) return new Int8Array(n * n);
    if (input instanceof Int8Array && input.length === n * n) return input;
    if (typeof input === 'string') {
      var rows = input.trim().split('\n').map(function (r) { return r.trim(); }).filter(Boolean);
      var out = new Int8Array(n * n);
      for (var y = 0; y < Math.min(n, rows.length); y++) {
        for (var x = 0; x < Math.min(n, rows[y].length); x++) {
          var ch = rows[y][x];
          out[y * n + x] = (ch === 'X' || ch === 'x' || ch === 'B' || ch === 'b') ? 1
            : (ch === 'O' || ch === 'o' || ch === 'W' || ch === 'w') ? 2 : 0;
        }
      }
      return out;
    }
    if (Array.isArray(input)) {
      var flat = new Int8Array(n * n);
      if (Array.isArray(input[0])) {
        for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) flat[r * n + c] = input[r][c] || 0;
      } else {
        for (var k = 0; k < n * n; k++) flat[k] = input[k] || 0;
      }
      return flat;
    }
    return new Int8Array(n * n);
  }

  function mount(host, opts) {
    if (!root.GoEngine) throw new Error('winrate-panel: 请先加载 go-engine.js');
    var G = root.GoEngine;
    opts = opts || {};
    var n = opts.size || 19;
    var komi = opts.komi == null ? 7.5 : opts.komi;
    var thinkMs = opts.thinkMs || 900;
    var showCandidates = opts.candidates !== false;
    var external = !!opts.external;   // true: 由外部驱动分析，面板只负责显示
    var onReplay = typeof opts.onReplay === 'function' ? opts.onReplay : null;

    injectStyle();

    var wrap = document.createElement('div');
    wrap.className = 'gw-panel';
    wrap.innerHTML =
      '<section class="gw-card">' +
        '<h3>实时胜率</h3>' +
        '<div class="gw-head">' +
          '<div class="gw-side"><span class="gw-dot b"></span>黑</div>' +
          '<div class="gw-num" data-wr>50.0%</div>' +
        '</div>' +
        '<div class="gw-bar"><i class="b" data-barb style="width:50%"></i><i class="w" data-barw style="width:50%"></i></div>' +
        '<div class="gw-meta"><span>目差 <b data-lead>—</b></span>' +
          '<span data-komi>贴目 7.5</span>' +
          '<span>第 <b data-moves>0</b> 手</span></div>' +
        '<canvas class="gw-curve" data-curve></canvas>' +
      '</section>' +
      (showCandidates ?
      '<section class="gw-card" data-cand-card>' +
        '<h3>AI 分析 · 模拟占比</h3>' +
        '<ul class="gw-cands" data-cands><li class="gw-empty" style="display:block">等待落子</li></ul>' +
        '<div class="gw-think"><span class="gw-spin" data-spin style="display:none"></span><span data-think>等待落子</span></div>' +
      '</section>' : '');

    host.appendChild(wrap);

    var elWr = wrap.querySelector('[data-wr]');
    var elBarB = wrap.querySelector('[data-barb]');
    var elBarW = wrap.querySelector('[data-barw]');
    var elLead = wrap.querySelector('[data-lead]');
    var elMoves = wrap.querySelector('[data-moves]');
    var elCurve = wrap.querySelector('[data-curve]');
    var elCands = wrap.querySelector('[data-cands]');
    var elKomi = wrap.querySelector('[data-komi]');
    if (elKomi) elKomi.textContent = '贴目 ' + komi;
    var elThink = wrap.querySelector('[data-think]');
    var elSpin = wrap.querySelector('[data-spin]');

    var curveCtx = elCurve.getContext('2d');
    var history = [];        // 胜率走势
    var timeline = onReplay ? [] : null;
    var activeMove = 0;
    var chartPadding = 5;
    var token = 0;          // 分析代次，切局面时作废旧任务
    var lastSig = null;
    var destroyed = false;

    function drawCurve() {
      var dpr = root.devicePixelRatio || 1;
      var w = elCurve.clientWidth || 260, h = 78;
      elCurve.width = w * dpr; elCurve.height = h * dpr;
      curveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      curveCtx.clearRect(0, 0, w, h);

      curveCtx.strokeStyle = '#eee'; curveCtx.lineWidth = 1;
      curveCtx.beginPath(); curveCtx.moveTo(0, h / 2); curveCtx.lineTo(w, h / 2); curveCtx.stroke();

      if (timeline !== null && timeline.length > 1) {
        drawTimeline(w, h);
        return;
      }

      if (history.length < 2) {
        curveCtx.fillStyle = '#bbb';
        curveCtx.font = '11px sans-serif';
        curveCtx.textAlign = 'center';
        curveCtx.fillText('落子后显示胜率走势', w / 2, h / 2 - 8);
        return;
      }
      var cnt = history.length;
      function px(i) { return (i / (cnt - 1)) * w; }
      function py(v) { return h - v * h; }

      curveCtx.beginPath();
      curveCtx.moveTo(px(0), py(history[0]));
      for (var i = 1; i < cnt; i++) curveCtx.lineTo(px(i), py(history[i]));
      curveCtx.lineTo(px(cnt - 1), h); curveCtx.lineTo(px(0), h); curveCtx.closePath();
      var g = curveCtx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(36,86,184,.20)');
      g.addColorStop(1, 'rgba(36,86,184,0)');
      curveCtx.fillStyle = g; curveCtx.fill();

      curveCtx.beginPath();
      curveCtx.moveTo(px(0), py(history[0]));
      for (var j = 1; j < cnt; j++) curveCtx.lineTo(px(j), py(history[j]));
      curveCtx.strokeStyle = '#2456b8'; curveCtx.lineWidth = 1.8; curveCtx.stroke();

      curveCtx.beginPath();
      curveCtx.arc(px(cnt - 1), py(history[cnt - 1]), 3, 0, 7);
      curveCtx.fillStyle = '#2456b8'; curveCtx.fill();
    }

    function drawTimeline(w, h) {
      var maxMove = timeline.length - 1;
      var plotWidth = Math.max(0, w - chartPadding * 2);
      function x(move) { return chartPadding + plotWidth * move / maxMove; }
      function y(value) { return h - chartPadding - (h - chartPadding * 2) * value; }

      var xActive = x(activeMove);
      curveCtx.strokeStyle = '#7694cc';
      curveCtx.lineWidth = 1;
      curveCtx.beginPath();
      curveCtx.moveTo(xActive, 0);
      curveCtx.lineTo(xActive, h);
      curveCtx.stroke();

      curveCtx.strokeStyle = '#2456b8';
      curveCtx.lineWidth = 1.8;
      curveCtx.beginPath();
      var hasPrevious = false;
      for (var move = 0; move <= maxMove; move++) {
        var value = timeline[move];
        if (value === null) {
          hasPrevious = false;
        } else {
          if (hasPrevious) curveCtx.lineTo(x(move), y(value));
          else curveCtx.moveTo(x(move), y(value));
          hasPrevious = true;
        }
      }
      curveCtx.stroke();

      curveCtx.fillStyle = '#2456b8';
      for (var point = 0; point <= maxMove; point++) {
        if (timeline[point] === null) continue;
        var isIsolated = (point === 0 || timeline[point - 1] === null) &&
          (point === maxMove || timeline[point + 1] === null);
        if (point !== activeMove && !isIsolated) continue;
        curveCtx.beginPath();
        curveCtx.arc(x(point), y(timeline[point]), point === activeMove ? 3 : 2, 0, Math.PI * 2);
        curveCtx.fill();
      }
    }

    function setTimeline(values, move) {
      if (destroyed) return;
      timeline = Array.from(values, function (value) {
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
      });
      var maxMove = Math.max(0, timeline.length - 1);
      activeMove = Number.isInteger(move) ? Math.min(maxMove, Math.max(0, move)) : maxMove;
      if (onReplay) {
        elCurve.tabIndex = maxMove ? 0 : -1;
        elCurve.setAttribute('aria-disabled', String(maxMove === 0));
        elCurve.setAttribute('aria-valuemax', maxMove);
        elCurve.setAttribute('aria-valuenow', activeMove);
        elCurve.setAttribute('aria-valuetext', '第 ' + activeMove + ' 手');
      }
      drawCurve();
    }

    if (onReplay) {
      elCurve.setAttribute('role', 'slider');
      elCurve.setAttribute('aria-label', '胜率走势回看');
      elCurve.setAttribute('aria-valuemin', '0');
      elCurve.title = '点击走势回看棋局';
      elCurve.addEventListener('click', function (event) {
        if (destroyed || timeline.length < 2) return;
        var bounds = elCurve.getBoundingClientRect();
        var fraction = (event.clientX - bounds.left - chartPadding) / Math.max(1, bounds.width - chartPadding * 2);
        onReplay(Math.round(Math.max(0, Math.min(1, fraction)) * (timeline.length - 1)));
      });
      elCurve.addEventListener('keydown', function (event) {
        if (destroyed || timeline.length < 2) return;
        var max = timeline.length - 1;
        var move;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') move = Math.max(0, activeMove - 1);
        else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') move = Math.min(max, activeMove + 1);
        else if (event.key === 'Home') move = 0;
        else if (event.key === 'End') move = max;
        else return;
        event.preventDefault();
        onReplay(move);
      });
      setTimeline([], 0);
    }

    function render(stats, moveNo) {
      var wr = stats.blackWinrate;
      elWr.textContent = (wr * 100).toFixed(1) + '%';
      elBarB.style.width = (wr * 100) + '%';
      elBarW.style.width = ((1 - wr) * 100) + '%';

      var lead = stats.scoreLead;
      if (Math.abs(lead) < 0.5) elLead.textContent = '和棋';
      else if (lead > 0) elLead.textContent = '黑 +' + lead.toFixed(1);
      else elLead.textContent = '白 +' + Math.abs(lead).toFixed(1);

      if (moveNo != null) elMoves.textContent = moveNo;

      if (!showCandidates) return;
      var cs = stats.candidates.slice(0, 5);
      if (!cs.length) {
        elCands.innerHTML = '<li class="gw-empty" style="display:block">暂无候选</li>';
        return;
      }
      // 各点胜率在开局几乎相同（取整后分不出来），改用"搜索占比"表达 AI 的倾向
      var totalV = 0, i2;
      for (i2 = 0; i2 < cs.length; i2++) totalV += (cs[i2].visits || 0);
      var html = '';
      for (var k = 0; k < cs.length; k++) {
        var pct = totalV ? Math.round((cs[k].visits || 0) / totalV * 100) : 0;
        var q = Math.max(6, pct);
        html += '<li><span class="rk">' + (k + 1) + '</span>' +
          '<span class="mv">' + coord(cs[k].move, n) + '</span>' +
          '<span class="bar"><i style="width:' + q + '%"></i></span>' +
          '<span class="v">' + pct + '%</span></li>';
      }
      elCands.innerHTML = html;
    }

    function setBusy(busy, text) {
      if (!showCandidates) return;
      elSpin.style.display = busy ? 'block' : 'none';
      if (text) elThink.textContent = text;
    }

    /**
     * @param {{board:Int8Array|Array|string, toPlay:1|2, lastMove?:number, moveNo?:number, record?:boolean}} state
     */
    function update(state) {
      if (destroyed || !state) return;
      var board = normalizeBoard(state.board, n);
      var toPlay = state.toPlay === 2 ? 2 : 1;
      var sig = signature(board, toPlay);
      if (sig === lastSig) return;
      lastSig = sig;

      if (external) return;   // 外部模式：等 apply() 喂结果

      var pos = G.newPosition(n, komi);
      pos.board.set(board);
      pos.toMove = toPlay;
      pos.lastMove = state.lastMove == null ? -1 : state.lastMove;
      pos.hash = G.boardHash(pos.board, n, toPlay);
      pos.history = [pos.hash + '|' + toPlay];

      var my = ++token;
      var an = G.createAnalysis(G.clonePosition(pos), { timeMs: thinkMs });
      var t0 = (root.performance && performance.now) ? performance.now() : Date.now();
      var moveNo = state.moveNo;

      setBusy(true, '分析中…');

      function step() {
        if (destroyed || my !== token) return;
        var stats = an.step(11);
        render(stats, moveNo);
        var el = ((root.performance && performance.now) ? performance.now() : Date.now()) - t0;

        setBusy(true, '分析中 · ' + Math.round(stats.visits) + ' 次模拟');

        if (el >= thinkMs) {
          if (timeline === null) {
            history.push(stats.blackWinrate);
            if (history.length > 400) history.shift();
            drawCurve();
          }
          setBusy(false, '第 ' + Math.round(stats.visits) + ' 次模拟 · ' +
            Math.round(stats.nps) + '/秒');
          return;
        }
        root.setTimeout(step, 0);
      }
      root.setTimeout(step, 0);
    }

    /** 对局中可以关掉候选点，避免直接把下一手提示给对方 */
    function setCandidates(on) {
      var card = wrap.querySelector('[data-cand-card]');
      if (card) card.style.display = on ? '' : 'none';
    }

    /**
     * 显示模式：
     *  'ai'      人机对局 / 复盘 —— 胜率 + 候选点全显示
     *  'pvp'     真人联机 —— 只显示胜率，不提示下一手
     *  'off'     完全隐藏
     */
    function setMode(mode) {
      var cand = wrap.querySelector('[data-cand-card]');
      if (mode === 'off') { wrap.style.display = 'none'; return; }
      wrap.style.display = '';
      if (cand) cand.style.display = mode === 'ai' ? '' : 'none';
    }

    function setKomi(k) {
      komi = k;
      if (elKomi) elKomi.textContent = '贴目 ' + k;
    }

    function setSize(size) {
      n = size;
      lastSig = null;
      token++;
    }

    function reset() {
      token++;
      history = [];
      lastSig = null;
      elWr.textContent = '50.0%';
      elBarB.style.width = '50%';
      elBarW.style.width = '50%';
      elLead.textContent = '—';
      elMoves.textContent = '0';
      if (showCandidates) {
        elCands.innerHTML = '<li class="gw-empty" style="display:block">等待落子</li>';
        setBusy(false, '等待落子');
      }
      if (timeline === null) drawCurve();
      else setTimeline([], 0);
    }

    function destroy() {
      destroyed = true;
      token++;
      root.removeEventListener('resize', onResize);   // 防止反复挂载/卸载后泄漏
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }

    /** 外部模式：把已经算好的分析结果推给面板显示 */
    function apply(stats, moveNo, record) {
      if (destroyed || !stats) return;
      render(stats, moveNo);
      if (record && timeline === null) {
        history.push(stats.blackWinrate);
        if (history.length > 400) history.shift();
        drawCurve();
      }
      setBusy(false, '第 ' + Math.round(stats.visits) + ' 次模拟 · ' + Math.round(stats.nps) + '/秒');
    }

    /** 外部模式：只在思考过程中刷新数字，不记曲线 */
    function progress(stats, moveNo) {
      if (destroyed || !stats) return;
      render(stats, moveNo);
      setBusy(true, '分析中 · ' + Math.round(stats.visits) + ' 次模拟');
    }

    var onResize = function () { if (!destroyed) drawCurve(); };
    root.addEventListener('resize', onResize);

    setTimeout(drawCurve, 0);

    return {
      update: update, reset: reset, destroy: destroy,
      apply: apply, progress: progress, setKomi: setKomi, setSize: setSize, setTimeline: setTimeline,
      setCandidates: setCandidates, setMode: setMode, element: wrap
    };
  }

  root.GoWinratePanel = {
    mount: mount,
    normalizeBoard: normalizeBoard,
    coord: coord
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.GoWinratePanel;
})(typeof globalThis !== 'undefined' ? globalThis : this);
