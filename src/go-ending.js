(function (root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./go-engine.js'));
  } else {
    root.GoEnding = factory(root.GoEngine);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (engine) {
  'use strict';

  function region(board, adjacent, index, seen) {
    var points = [index];
    var color = board[index];
    seen[index] = 1;
    for (var i = 0; i < points.length; i++) {
      var neighbors = adjacent[points[i]];
      for (var j = 0; j < neighbors.length; j++) {
        var next = neighbors[j];
        if (!seen[next] && board[next] === color) {
          seen[next] = 1;
          points.push(next);
        }
      }
    }
    return points;
  }

  function group(board, n, index) {
    if (!Number.isInteger(index) || index < 0 || index >= board.length || !board[index]) return [];
    return region(board, engine.neighbors(n), index, new Uint8Array(board.length));
  }

  function score(position, deadIndices) {
    var board = new Uint8Array(position.board);
    for (var index of deadIndices || []) {
      if (Number.isInteger(index) && index >= 0 && index < board.length) board[index] = engine.EMPTY;
    }

    var adjacent = engine.neighbors(position.n);
    // 已移除死子。所有存活棋子和单方围住的空点都归其所属方。
    var ownership = new Uint8Array(board);
    var seen = new Uint8Array(board.length);
    for (var i = 0; i < board.length; i++) {
      if (board[i] || seen[i]) continue;
      var emptyPoints = region(board, adjacent, i, seen);
      var borderedBy = 0;
      for (var point of emptyPoints) {
        for (var neighbor of adjacent[point]) borderedBy |= board[neighbor];
      }
      if (borderedBy === engine.BLACK || borderedBy === engine.WHITE) {
        for (var owned of emptyPoints) ownership[owned] = borderedBy;
      }
    }

    var totals = engine.scoreArea(board, position.n, position.komi);
    totals.ownership = ownership;
    return totals;
  }

  return { group: group, score: score };
});
