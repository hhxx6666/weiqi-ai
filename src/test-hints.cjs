const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const GoEngine = require('./go-engine.js');
const GoEnding = require('./go-ending.js');
const GoRecord = require('./go-record.js');

const htmlPath = process.argv[2] || path.join(__dirname, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const pageScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
assert.ok(pageScript, 'Could not find the page script');

function buildPage({ remote = true, ready = true } = {}) {
  const els = new Map();
  const analyses = [];
  const requests = [];
  let selectedEvaluation;
  const timers = new Map();
  let drawnHints = 0;
  let now = 0;
  let lastTimer = 0;

  const noop = () => {};
  const context = new Proxy({
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    fillRect: () => { drawnHints = 0; },
    fillText: (_value, x, y) => { if (x > 20 && y > 20) drawnHints++; },
  }, { get: (target, key) => target[key] ?? noop });

  function element(id) {
    if (els.has(id)) return els.get(id);
    const listeners = new Map();
    const node = {
      clientWidth: 640,
      children: [],
      dataset: {},
      style: {},
      disabled: false,
      value: '',
      checked: false,
      classList: { add: noop, remove: noop, toggle: noop },
      setAttribute: noop,
      getContext: () => context,
      addEventListener: (type, fn) => listeners.set(type, fn),
      change: (event = {}) => listeners.get('change').call(node, event),
      click: (event = {}) => {
        assert.ok(listeners.has('click'), `Missing click handler for ${id}`);
        return listeners.get('click').call(node, event);
      },
      set textContent(value) { this.text = value; },
      set innerHTML(value) { this.text = value; },
      get textContent() { return this.text ?? ''; },
      get innerHTML() { return this.text ?? ''; },
    };
    els.set(id, node);
    return node;
  }

  const engine = {
    ...GoEngine,
    createAnalysis: (pos, opts) => {
      analyses.push(opts);
      const move = 3 * pos.n + 3;
      return { step: () => ({
        candidates: [{ move }], bestMove: move, visits: 40, elapsed: 100, blackWinrate: 0.3,
      }) };
    },
  };
  const window = {
    GoEngine: engine,
    GoEnding,
    GoRecord,
    GoWinratePanel: { mount: () => ({
      setKomi: noop, setSize: noop, reset: noop, progress: noop, apply: noop, setMode: noop,
      setTimeline: (evaluations, move) => { selectedEvaluation = evaluations[move]; },
    }) },
    addEventListener: noop,
  };
  const document = { getElementById: element, querySelector: element };
  vm.runInNewContext(pageScript, {
    window,
    document,
    URLSearchParams,
    AbortController,
    location: { search: remote ? '?katago=http://127.0.0.1:8100' : '' },
    performance: { now: () => now },
    setTimeout: (fn, delay = 0) => {
      const id = ++lastTimer;
      timers.set(id, { fn, time: now + Math.max(1, delay) });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: (url, options) => new Promise((resolve, reject) => {
      // Deliberately allow the mock transport to settle after an abort, like a
      // response already in flight through another asynchronous callback.
      requests.push({ url, options, resolve, reject });
    }),
  }, { filename: htmlPath });

  function advance(ms) {
    const target = now + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].time - b[1].time)[0];
      if (!next || next[1].time > target) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.time;
      timer.fn();
    }
    now = target;
  }

  if (ready) advance(650);
  return {
    element, analyses, requests, advance, evaluation: () => selectedEvaluation,
    screen: () => ({
      text: [...els].filter(([, node]) => node.textContent).map(([id, node]) => [id, node.textContent]),
      drawnHints,
    }),
  };
}

async function check(action, response) {
  const page = buildPage();
  const hint = page.element('btnHint');
  hint.click();
  assert.equal(page.requests.length, 1, 'KataGo hint should issue one request');
  const [old] = page.requests;
  assert.equal(old.url, 'http://127.0.0.1:8100/analyze');
  assert.equal(JSON.parse(old.options.body).maxTime, 15);
  assert.equal(JSON.parse(old.options.body).maxVisits, 15000);

  if (action === 'new game') page.element('btnNew').click();
  else hint.click();
  const expected = page.screen();
  const analysisCount = page.analyses.length;
  if (response === 'success') {
    old.resolve({ ok: true, json: async () => ({ move: 60, winrate: 0.52, scoreLead: 2, candidates: [{ move: 60 }] }) });
  } else {
    old.reject(new Error('KataGo request failed late'));
  }
  await new Promise(setImmediate);

  assert.equal(page.analyses.length, analysisCount, 'Old request restarted local analysis');
  assert.deepEqual(page.screen(), expected, 'Old request changed current UI');
  assert.notEqual(page.evaluation().source, 'katago', 'Old request changed the current evaluation source');
  assert.equal(old.options.signal?.aborted, true, 'Old remote request was not aborted');
  hint.click();
  assert.equal(page.requests.length, 2, 'Old request interfered with the next hint');
}

async function checkCurrentHint(response) {
  const page = buildPage({ ready: false });
  page.element('btnHint').click();
  const [request] = page.requests;
  if (response === 'success') {
    request.resolve({ ok: true, json: async () => ({ move: 60, winrate: 0.52, scoreLead: 2, candidates: [{ move: 60 }] }) });
    await new Promise(setImmediate);
    assert.equal(page.analyses.length, 1, 'Successful request unexpectedly ran a local hint');
    assert.equal(page.screen().drawnHints, 1, 'Current hint did not mark a move on the board');
    assert.match(page.element('hintStatus').textContent, /KataGo 建议 D16/);
    page.advance(650);
    assert.equal(page.evaluation().source, 'katago');
    assert.equal(page.evaluation().blackWinrate, 0.52);
    assert.match(page.element('status').innerHTML, /轮到/, 'Opening analysis status should not get stuck');
    assert.match(page.element('hintStatus').textContent, /KataGo 建议 D16/, 'Hint result should stay visible');
  } else {
    request.reject(new Error('Current remote request failed'));
    await new Promise(setImmediate);
    assert.equal(page.analyses.length, 2, 'Current request error should start a local hint');
    assert.equal(page.analyses.at(-1).level, 'master', 'Fallback should use the strongest local setting');
    assert.match(page.element('hintStatus').textContent, /KataGo 不可用。.*本地引擎深度分析中/);
  }
}

function checkLocalHint() {
  const page = buildPage({ remote: false });
  const hint = page.element('btnHint');
  hint.click();
  assert.equal(page.analyses.at(-1).level, 'master');
  assert.equal(page.analyses.at(-1).timeMs, 12000);
  assert.equal(page.analyses.at(-1).children, 36);
  assert.equal(page.analyses.at(-1).replyWidth, 8);
  assert.match(page.element('hintStatus').textContent, /本地引擎深度分析中/);
  assert.equal(hint.textContent, '取消提示');
  page.advance(12100);
  assert.equal(page.evaluation().source, 'local');
  assert.match(page.element('hintStatus').textContent, /本地引擎建议 D16/);
  assert.equal(page.screen().drawnHints, 1, 'Local hint should number a point on the board');
  assert.equal(hint.textContent, '关闭提示');
  hint.click();
  assert.equal(page.screen().drawnHints, 0);
  assert.equal(hint.textContent, '提示');
}

async function checkTeachingLesson() {
  const page = buildPage();
  const teaching = page.element('btnTeach');
  teaching.click();
  const [request] = page.requests;
  const move = 3 * 19 + 8;
  request.resolve({ ok: true, json: async () => ({ move, winrate: 0.52, candidates: [{ move }] }) });
  await new Promise(setImmediate);
  assert.match(page.element('hintLesson').textContent, /这手落在边上/);
  teaching.click();
  assert.equal(page.element('hintLesson').textContent, '');
  assert.equal(page.screen().drawnHints, 0);
}

(async () => {
  for (const action of ['cancel', 'new game']) {
    for (const response of ['success', 'failure']) {
      try {
        await check(action, response);
        console.log(`PASS: ${action} followed by delayed ${response}`);
      } catch (error) {
        console.error(`FAIL: ${action} followed by delayed ${response}: ${error.message}`);
        process.exitCode = 1;
      }
    }
  }
  for (const response of ['success', 'failure']) {
    try {
      await checkCurrentHint(response);
      console.log(`PASS: current hint reports ${response}`);
    } catch (error) {
      console.error(`FAIL: current hint reports ${response}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  try {
    checkLocalHint();
    console.log('PASS: local hint completes and marks a move until closed');
  } catch (error) {
    console.error(`FAIL: local hint completion: ${error.message}`);
    process.exitCode = 1;
  }
  try {
    await checkTeachingLesson();
    console.log('PASS: teaching starts automatically and explains an opening move on the side');
  } catch (error) {
    console.error(`FAIL: teaching lesson: ${error.message}`);
    process.exitCode = 1;
  }
})();
