const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = process.env.DATABASE_TICK_SOURCE
  ? path.resolve(process.env.DATABASE_TICK_SOURCE)
  : path.join(__dirname, '..', 'database.html');

function loadChartModel() {
  const html = fs.readFileSync(sourcePath, 'utf8');
  const modelStart = html.indexOf('const DAY =');
  const modelEnd = html.indexOf('/* ---------- 조건 영역 렌더 ---------- */', modelStart);
  const ticksStart = html.indexOf('const XSTEPS =');
  const ticksEnd = html.indexOf('function chartHeight(', ticksStart);
  const chartStart = html.indexOf('function drawCharts()');
  const chartEnd = html.indexOf('function fmtTick(', chartStart);
  assert.ok(modelStart >= 0 && modelEnd > modelStart && ticksStart >= 0 && ticksEnd > ticksStart);
  const chartSource = html.slice(chartStart, chartEnd);
  const stepExpression = chartSource.match(/const xs = ([^\n]+);/);
  const tickLoop = chartSource.match(/for \(let o = [^\n]+\) \{\n\s+const x = X\(o\);/);
  assert.ok(stepExpression && tickLoop, 'the real chart tick selector and aligned tick loop must exist');
  const loopHeader = tickLoop[0].split('\n')[0];

  // Execute the real model, tick helpers, selector expression, and loop bounds.
  // Only DOM rendering is stubbed; the loop collects offsets instead of SVG markup.
  class FixedDate extends Date { static now() { return Date.parse('2026-11-12T03:00:00Z'); } }
  const context = vm.createContext({
    Date: FixedDate,
    renderBuilder() {}, renderResults() {}, renderGroups() {},
    toast(message) { throw new Error(message); },
  });
  vm.runInContext(
    html.slice(modelStart, modelEnd) + '\n' + html.slice(ticksStart, ticksEnd) + `
      function ticksFor(e, ok, maxTicks) {
        const span = e.to - e.from;
        const xs = ${stepExpression[1]};
        const offsets = [];
        ${loopHeader} offsets.push(o); }
        return { step: xs, offsets };
      }
      globalThis.model = { DAY, state, mkGroup, runQuery, cur, compute, ticksFor };
    `,
    context,
    { filename: sourcePath },
  );
  return context.model;
}

function queryGroups(model, groups, days = 1) {
  model.state.base = { date: '2026-11-12', days, opHours: false, weekendEx: false };
  model.state.groups = groups.map(group => model.mkGroup(group));
  model.runQuery(true);
  return model.cur();
}

function ticks(model, entry, maxTicks) {
  return model.ticksFor(entry, model.state.applied.series, maxTicks);
}

test('three-hour and eight-hour groups use three-hour multiples at both wide and narrow widths', () => {
  const model = loadChartModel();
  const entry = queryGroups(model, [
    { targets: ['i-was01'], interval: 3 * 3600 },
    { targets: ['i-was02'], interval: 8 * 3600 },
  ]);
  assert.equal(ticks(model, entry, 13).step, 3 * 3600, 'a wide axis must not choose two-hour ticks');
  const narrow = ticks(model, entry, 7);
  assert.equal(narrow.step, 6 * 3600, 'four-hour ticks do not align with the minimum three-hour interval');
  assert.ok(narrow.offsets.length <= 7);
});

test('hidden successful groups still determine ticks while unsupported groups do not', () => {
  const model = loadChartModel();
  const entry = queryGroups(model, [
    { targets: ['i-was01'], interval: 3 * 3600 },
    { targets: ['i-was02'], interval: 8 * 3600 },
    { kind: 'business', targets: ['b-order'], metric: 'cpu', interval: 60 },
  ]);
  assert.equal(model.state.applied.series[2].status, 'fail');
  const before = ticks(model, entry, 13);
  model.state.applied.series[0].hidden = true;
  const after = ticks(model, entry, 13);
  assert.equal(before.step, 3 * 3600);
  assert.equal(after.step, before.step);
  assert.deepEqual(Array.from(after.offsets), Array.from(before.offsets));
});

test('ten-minute and fifteen-minute groups use ten-minute ticks rather than the table grid', () => {
  const model = loadChartModel();
  queryGroups(model, [
    { targets: ['i-was01'], interval: 600 },
    { targets: ['i-was02'], interval: 900, period: { mode: 'shift', shift: -7 } },
  ], 7);
  const entry = { from: 300, to: 2100, res: 60, api: 'min' };
  entry.data = model.compute(entry);
  const result = ticks(model, entry, 7);
  assert.equal(result.step, 600);
  assert.deepEqual(Array.from(result.offsets), [600, 1200, 1800], 'tick alignment must retain the shared zero-offset phase');
});

test('the default seven-day search has readable daily ticks', () => {
  const model = loadChartModel();
  model.runQuery(true);
  const result = ticks(model, model.cur(), 8);
  assert.equal(result.step, model.DAY);
  assert.equal(result.offsets.length, 8);
  assert.equal(result.offsets[0], 0);
  assert.equal(result.offsets.at(-1), 7 * model.DAY);
});

test('a ninety-day axis respects its label capacity beyond the fixed tick candidates', () => {
  const model = loadChartModel();
  const entry = queryGroups(model, [
    { targets: ['i-was01'], interval: 3 * 3600 },
    { targets: ['i-was02'], interval: 8 * 3600 },
  ], 90);
  for (const maxTicks of [2, 7, 10]) {
    const result = ticks(model, entry, maxTicks);
    assert.ok(result.offsets.length <= maxTicks, `${maxTicks}-label axis produced ${result.offsets.length} ticks`);
    assert.equal(result.step % (3 * 3600), 0);
    assert.ok(result.step >= 3 * 3600);
  }
});

test('second-level drills use their effective one- or five-second intervals with minute fallback', () => {
  const model = loadChartModel();
  queryGroups(model, [
    { targets: ['i-was01'], interval: 3 * 3600 },
    { targets: ['i-batch01'], interval: 8 * 3600 },
  ]);
  for (const resolution of [1, 5]) {
    const entry = { from: 7, to: 27, res: resolution, api: 'sec' };
    entry.data = model.compute(entry);
    const result = ticks(model, entry, 30);
    assert.equal(result.step, resolution);
    for (const offset of result.offsets) assert.equal(offset % resolution, 0);
  }
});

test('a drill with only a minute-fallback series retains minute ticks', () => {
  const model = loadChartModel();
  queryGroups(model, [{ targets: ['i-batch01'], interval: 8 * 3600 }]);
  const entry = { from: 0, to: 600, res: 5, api: 'sec' };
  entry.data = model.compute(entry);
  assert.equal(ticks(model, entry, 20).step, 60);
});
