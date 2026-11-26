(function (root) {
  'use strict';

  const BLACK = 1, WHITE = 2, PASS = -1;
  const SIZES = [9, 13, 19];
  const LETTERS = 'abcdefghijklmnopqrs';

  function readMainLine(text) {
    if (typeof text !== 'string') throw new Error('SGF 棋谱必须是文本。');
    const nodes = [];
    let at = 0;

    function peek() {
      while (at < text.length && /\s/.test(text[at])) at++;
      return text[at] || '';
    }

    function need(ch) {
      if (peek() !== ch) throw new Error('SGF 格式错误，字符 ' + (at + 1) + ' 附近应为 ' + ch + '。');
      at++;
    }

    function readValue() {
      need('[');
      let value = '';
      while (at < text.length) {
        let ch = text[at++];
        if (ch === ']') return value;
        if (ch === '\\') {
          ch = text[at++];
          if (ch === undefined) break;
          if (ch === '\r' || ch === '\n') {
            if ((ch === '\r' && text[at] === '\n') || (ch === '\n' && text[at] === '\r')) at++;
            continue;
          }
        }
        value += ch;
      }
      throw new Error('SGF 属性值缺少右方括号。');
    }

    function readNode() {
      need(';');
      const node = Object.create(null);
      while (/[A-Za-z]/.test(peek())) {
        const start = at;
        while (at < text.length && /[A-Za-z]/.test(text[at])) at++;
        const token = text.slice(start, at);
        // FF[3] 允许属性名称夹带小写字母。关键字取其中的大写部分。
        const id = token.replace(/[a-z]/g, '');
        if (!id) throw new Error('SGF 属性名应包含大写字母。');
        if (node[id]) throw new Error('SGF 同一节点重复定义了 ' + id + '。');
        const values = [readValue()];
        while (peek() === '[') values.push(readValue());
        node[id] = values;
      }
      return node;
    }

    function readTree(keep, depth) {
      if (depth > 128) throw new Error('SGF 变化分支嵌套过深。');
      need('(');
      do {
        const node = readNode();
        if (keep) nodes.push(node);
      } while (peek() === ';');

      let follow = keep;
      while (peek() === '(') {
        readTree(follow, depth + 1);
        follow = false;
      }
      need(')');
    }

    readTree(true, 0);
    if (peek() === '(') throw new Error('SGF 含多局棋谱，请每次导入一局。');
    if (peek()) throw new Error('SGF 棋谱结束后包含额外内容。');
    return nodes;
  }

  function single(node, id) {
    if (!node[id]) return null;
    if (node[id].length !== 1) throw new Error('SGF 属性 ' + id + ' 应只有一个值。');
    return node[id][0].trim();
  }

  function point(value, size, allowPass) {
    const coordinate = value.trim();
    if (allowPass && (coordinate === '' || coordinate === 'tt')) return PASS;
    const x = LETTERS.indexOf(coordinate[0]), y = LETTERS.indexOf(coordinate[1]);
    if (coordinate.length !== 2 || x < 0 || y < 0 || x >= size || y >= size) {
      throw new Error('SGF 坐标超出棋盘或格式有误：' + coordinate + '。');
    }
    return y * size + x;
  }

  function setupPoints(values, size) {
    const points = [];
    for (const value of values) {
      const ends = value.split(':');
      const start = point(ends[0], size, false);
      if (ends.length === 1) {
        points.push(start);
        continue;
      }
      if (ends.length !== 2) throw new Error('SGF 摆子范围格式有误：' + value + '。');
      const end = point(ends[1], size, false);
      const x1 = start % size, x2 = end % size;
      const y1 = Math.floor(start / size), y2 = Math.floor(end / size);
      if (x1 > x2 || y1 > y2) throw new Error('SGF 摆子范围应从左上到右下：' + value + '。');
      for (let y = y1; y <= y2; y++) {
        for (let x = x1; x <= x2; x++) points.push(y * size + x);
      }
    }
    return points;
  }

  function parse(text) {
    const nodes = readMainLine(text);
    const rootNode = nodes[0];
    const game = single(rootNode, 'GM');
    if (game !== null && game !== '1') throw new Error('只支持围棋 SGF（GM[1]）。');

    const shape = (single(rootNode, 'SZ') ?? '19').split(':').map(side => side.trim());
    const size = Number(shape[0]);
    if (!SIZES.includes(size) || !shape.every(side => side === String(size)) || shape.length > 2) {
      throw new Error('只支持 9、13 或 19 路正方形棋盘。');
    }

    const board = new Map(), moves = [];
    let toMove = null, handicap = 0, komi = 0, result = null;
    for (const node of nodes) {
      const komiText = single(node, 'KM');
      if (komiText !== null) {
        komi = Number(komiText);
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(komiText) || !Number.isFinite(komi)) {
          throw new Error('SGF 贴目值无效。');
        }
      }
      const handicapText = single(node, 'HA');
      if (handicapText !== null) {
        handicap = Number(handicapText);
        if (!/^\d+$/.test(handicapText) || !Number.isSafeInteger(handicap) || handicap > size * size) {
          throw new Error('SGF 让子数无效。');
        }
      }
      if (node.RE) result = single(node, 'RE') || null;

      const turn = single(node, 'PL');
      const hasSetup = node.AB || node.AW || node.AE || turn !== null;
      const black = single(node, 'B'), white = single(node, 'W');
      if (black !== null && white !== null) throw new Error('SGF 同一节点只能记一手棋。');
      if (hasSetup && (moves.length || black !== null || white !== null)) {
        throw new Error('暂只支持在第一手落子前摆子或指定行棋方。');
      }

      if (turn !== null) {
        if (turn !== 'B' && turn !== 'W') throw new Error('SGF 的 PL 应为 B 或 W。');
        toMove = turn === 'B' ? BLACK : WHITE;
      }
      const marked = new Set();
      for (const [id, color] of [['AB', BLACK], ['AW', WHITE], ['AE', 0]]) {
        if (!node[id]) continue;
        for (const move of setupPoints(node[id], size)) {
          if (marked.has(move)) throw new Error('SGF 同一节点在同一个位置重复摆子。');
          marked.add(move);
          if (color) board.set(move, color);
          else board.delete(move);
        }
      }
      if (black !== null) moves.push({ color: BLACK, move: point(black, size, true) });
      if (white !== null) moves.push({ color: WHITE, move: point(white, size, true) });
    }

    const setup = Array.from(board, ([move, color]) => ({ color, move })).sort((a, b) => a.move - b.move);
    if (toMove === null) toMove = moves.length ? moves[0].color : handicap >= 2 ? WHITE : BLACK;
    return { size, komi, handicap, setup, toMove, moves, result };
  }

  function colorCode(color) {
    if (color === BLACK) return 'B';
    if (color === WHITE) return 'W';
    throw new Error('棋谱行棋方应为黑棋或白棋。');
  }

  function coordinate(move, size, allowPass) {
    if (move === PASS && allowPass) return '';
    if (!Number.isInteger(move) || move < 0 || move >= size * size) throw new Error('棋谱落点超出棋盘。');
    return LETTERS[move % size] + LETTERS[Math.floor(move / size)];
  }

  function decimal(number) {
    const [value, exponent] = String(number).split('e');
    if (exponent === undefined) return value;
    const unsigned = value.replace('-', ''), sign = value[0] === '-' ? '-' : '';
    const [whole, fraction = ''] = unsigned.split('.');
    const digits = whole + fraction, split = whole.length + Number(exponent);
    if (split <= 0) return sign + '0.' + '0'.repeat(-split) + digits;
    if (split >= digits.length) return sign + digits + '0'.repeat(split - digits.length);
    return sign + digits.slice(0, split) + '.' + digits.slice(split);
  }

  function stringify({ size, komi, handicap = 0, setup = [], toMove, moves = [], result = null }) {
    if (!SIZES.includes(size)) throw new Error('只支持 9、13 或 19 路正方形棋盘。');
    if (!Number.isFinite(komi)) throw new Error('棋谱贴目值无效。');
    if (!Number.isInteger(handicap) || handicap < 0 || handicap > size * size) throw new Error('棋谱让子数无效。');

    const byColor = { B: [], W: [] }, occupied = new Set();
    for (const { color, move } of setup) {
      const position = coordinate(move, size, false);
      if (occupied.has(move)) throw new Error('棋谱在同一个位置重复摆子。');
      occupied.add(move);
      byColor[colorCode(color)].push(position);
    }

    let rootText = 'GM[1]FF[4]CA[UTF-8]RU[Chinese]SZ[' + size + ']KM[' + decimal(komi) + ']';
    if (handicap > 0) rootText += 'HA[' + handicap + ']';
    rootText += 'PL[' + colorCode(toMove) + ']';
    for (const color of ['B', 'W']) {
      if (byColor[color].length) rootText += 'A' + color + '[' + byColor[color].join('][') + ']';
    }
    if (result !== null && result !== '') {
      if (typeof result !== 'string') throw new Error('棋谱结果必须是文本。');
      rootText += 'RE[' + result.replace(/\s+/g, ' ').trim().replace(/[\\\]]/g, '\\$&') + ']';
    }
    const line = moves.map(({ color, move }) => ';' + colorCode(color) + '[' + coordinate(move, size, true) + ']').join('');
    return '(;' + rootText + line + ')\n';
  }

  const api = { parse, stringify };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GoRecord = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
