/*!
 * katago-server.js — 把 KataGo 包成一个 HTTP 接口，供前端 / 服务端调用
 * ---------------------------------------------------------------
 * 启动：
 *   KATAGO_BIN=/opt/katago/katago \
 *   KATAGO_MODEL=/opt/katago/kata1-b18c384nbt.bin.gz \
 *   KATAGO_CFG=/opt/katago/analysis.cfg \
 *   PORT=8100 node katago-server.js
 *
 * 调用：
 *   POST /analyze
 *   { "boardSize": 19, "board": "19 行 X/O/. 文本 或 361 长度数组", "toMove": 1, "komi": 7.5, "maxVisits": 400 }
 *   → { "move": 72, "winrate": 0.53, "scoreLead": 3.2, "candidates": [...] }
 *
 *   GET /health → { ok: true, engine: 'katago' }
 *
 * 说明：这是"职业段位"档的后端。前端拿到结果后与本地引擎的 analyze() 返回结构一致，
 * 面板/AI 落子逻辑可以直接复用，不需要改 UI。
 */
'use strict';

const http = require('http');
const { KataGoBridge } = require('./katago-bridge.js');

const PORT = parseInt(process.env.PORT || '8100', 10);
const N = parseInt(process.env.BOARD || '19', 10);

const bridge = new KataGoBridge({
  bin: process.env.KATAGO_BIN || 'katago',
  model: process.env.KATAGO_MODEL,
  config: process.env.KATAGO_CFG,
  boardSize: N,
  args: process.env.KATAGO_ARGS ? process.env.KATAGO_ARGS.split(' ') : null,
  timeoutMs: parseInt(process.env.KATAGO_TIMEOUT || '30000', 10),
});

/** 接受 "X/O/." 文本或 0/1/2 数组，统一成 Int8Array */
function parseBoard(input, n) {
  if (Array.isArray(input)) {
    if (input.length === n * n && input.every((stone) => stone === 0 || stone === 1 || stone === 2)) {
      return Int8Array.from(input);
    }
    throw new Error('board 数组须包含 ' + n * n + ' 个 0、1 或 2');
  }
  if (typeof input === 'string') {
    const rows = input.trim().split(/\r?\n/).map((row) => row.trim());
    if (rows.length !== n || rows.some((row) => row.length !== n || !/^[.XOBW]+$/i.test(row))) {
      throw new Error('board 文本须为 ' + n + ' 行、每行 ' + n + ' 个棋盘字符');
    }
    const out = new Int8Array(n * n);
    for (let y = 0; y < n; y++) {
      const row = rows[y].toUpperCase();
      for (let x = 0; x < n; x++) {
        const ch = row[x];
        out[y * n + x] = ch === 'X' || ch === 'B' ? 1 : ch === 'O' || ch === 'W' ? 2 : 0;
      }
    }
    return out;
  }
  throw new Error('board 格式不支持');
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',          // 允许本地网页从不同端口调用
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'OPTIONS') return send(204, {});

  if (req.method === 'GET' && req.url === '/health') {
    return send(200, { ok: true, engine: 'katago' });
  }

  if (req.method !== 'POST' || req.url !== '/analyze') {
    return send(404, { ok: false, error: 'not found' });
  }

  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 1e6) { req.destroy(); }
  });
  req.on('end', async () => {
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch (e) {
      return send(400, { ok: false, error: 'JSON 解析失败' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(400, { ok: false, error: '请求须为 JSON 对象' });
    }
    const boardSize = payload.boardSize === undefined ? N : payload.boardSize;
    if (![9, 13, 19].includes(boardSize)) {
      return send(400, { ok: false, error: 'boardSize 须为 9、13 或 19' });
    }
    let board;
    try {
      board = parseBoard(payload.board, boardSize);
    } catch (e) {
      return send(400, { ok: false, error: e.message });
    }
    try {
      const result = await bridge.analyze({
        board,
        toMove: payload.toMove === 2 ? 2 : 1,
        komi: payload.komi == null ? 7.5 : payload.komi,
        maxVisits: Math.max(1, Math.min(20000, payload.maxVisits || 400)),
        maxTime: payload.maxTime ? Math.max(1, Math.min(120, payload.maxTime)) : 0,
        n: boardSize,
      });
      send(200, result);
    } catch (e) {
      send(500, { ok: false, error: e.message });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[katago-server] listening on http://127.0.0.1:' + server.address().port);
});
