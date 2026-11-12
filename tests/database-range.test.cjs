const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'database.html');

function loadSearchModel() {
  const html = fs.readFileSync(sourcePath, 'utf8');
  const start = html.indexOf('const DAY =');
  const end = html.indexOf('/* ---------- 조건 영역 렌더 ---------- */', start);
  assert.ok(start >= 0 && end > start, 'the search-model section must exist');

  // Execute the real date, query, aggregation, and table-lookup functions.
  // Only rendering is stubbed; the extracted section has no boot code.
  const context = vm.createContext({
    renderBuilder() {},
    renderResults() {},
    renderGroups() {},
    toast(message) { throw new Error(message); },
  });
  vm.runInContext(
    html.slice(start, end) + '\nglobalThis.model = { DAY, state, mkGroup, runQuery, cur, valAt, isDirty, clockOf };',
    context,
    { filename: sourcePath },
  );
  return context.model;
}

function epoch(date) {
  return Date.parse(`${date}T00:00:00Z`) / 1000;
}

function assertChartSamplesMatchTable(model, entry) {
  const rows = new Set(entry.data.rows);
  for (const series of model.state.applied.series) {
    const data = entry.data.series[series.key];
    for (let i = 0; i < data.vals.length; i++) {
      const offset = data.from + i * data.res;
      assert.ok(
        rows.has(offset),
        `table is missing chart sample offset ${offset}s for group ${series.g.no}`,
      );
      assert.equal(
        model.valAt(data, offset),
        data.vals[i],
        `table value must match the chart at offset ${offset}s for group ${series.g.no}`,
      );
    }
  }
}

const ranges = [
  { days: 1, interval: 300, points: 288, ends: ['2026-11-13', '2026-11-06', '2026-10-02', '2026-11-13'] },
  { days: 7, interval: 900, points: 672, ends: ['2026-11-19', '2026-11-12', '2026-10-08', '2026-11-19'] },
  { days: 90, interval: 10800, points: 720, ends: ['2027-02-10', '2027-02-03', '2026-12-30', '2027-02-10'] },
];

for (const fixture of ranges) {
  test(`${fixture.days}-day searches share duration and chart/table values across dates and metrics`, () => {
    const model = loadSearchModel();
    assert.equal(model.state.base.days, 7, 'the initial search range must remain seven days');
    model.state.base = {
      date: '2026-11-12', days: fixture.days, opHours: false, weekendEx: false,
    };
    model.state.groups = [
      model.mkGroup({ targets: ['i-was01'], metric: 'tps' }),
      model.mkGroup({ period: { mode: 'shift', shift: -7 }, targets: ['i-was02'], metric: 'resp' }),
      model.mkGroup({ period: { mode: 'date', date: '2026-10-01' }, targets: ['i-was03'], metric: 'cpu' }),
      model.mkGroup({ targets: ['i-mem01'], metric: 'active' }),
    ];
    model.runQuery(true);

    const entry = model.cur();
    assert.equal(entry.from, 0);
    assert.equal(entry.to, fixture.days * model.DAY);
    assert.equal(entry.res, fixture.interval);
    assert.equal(entry.data.rows.length, fixture.points);

    const starts = ['2026-11-12', '2026-11-05', '2026-10-01', '2026-11-12'];
    model.state.applied.series.forEach((series, index) => {
      const data = entry.data.series[series.key];
      assert.equal(series.g.start, epoch(starts[index]));
      assert.equal(series.g.start + entry.to, epoch(fixture.ends[index]));
      assert.equal(data.from, 0);
      assert.equal(data.res, fixture.interval);
      assert.equal(data.vals.length, fixture.points);
      assert.equal(data.from + data.vals.length * data.res, entry.to);
    });
    assertChartSamplesMatchTable(model, entry);
  });
}

test('seven-day auto summaries mixed with ten-minute summaries retain every chart sample in the table', () => {
  const model = loadSearchModel();
  model.state.base = {
    date: '2026-11-12', days: 7, opHours: false, weekendEx: false,
  };
  model.state.groups = [
    model.mkGroup({ targets: ['i-was01'], metric: 'tps' }),
    model.mkGroup({ targets: ['i-was02'], metric: 'resp', interval: 600 }),
  ];
  model.runQuery(true);

  const entry = model.cur();
  const [inherited, explicit] = model.state.applied.series;
  assert.equal(entry.to, 7 * model.DAY);
  assert.equal(entry.data.series[inherited.key].res, 900, 'auto summaries must retain their chosen interval');
  assert.equal(entry.data.series[explicit.key].res, 600, 'the explicit group interval must be preserved');
  assertChartSamplesMatchTable(model, entry);
});

test('draft range and group edits leave applied data and time labels unchanged until the next search', () => {
  const model = loadSearchModel();
  model.state.base = {
    date: '2026-11-12', days: 7, opHours: false, weekendEx: false,
  };
  model.state.groups = [
    model.mkGroup({ targets: ['i-was01'], metric: 'tps' }),
    model.mkGroup({ period: { mode: 'shift', shift: -7 }, targets: ['i-was02'], metric: 'resp' }),
    model.mkGroup({ period: { mode: 'date', date: '2026-10-01' }, targets: ['i-was03'], metric: 'cpu' }),
  ];
  model.runQuery(true);
  const applied = model.state.applied;
  const entry = model.cur();
  const starts = ['2026-11-12', '2026-11-05', '2026-10-01'];
  assert.equal(model.isDirty(), false);

  model.state.base.date = '2026-12-01';
  model.state.base.days = 90;
  model.state.groups[0].metric = 'active';
  model.state.groups[1].period.shift = -14;

  assert.equal(model.isDirty(), true);
  assert.equal(model.state.applied, applied);
  assert.equal(model.cur(), entry);
  assert.equal(applied.base.date, '2026-11-12');
  assert.equal(applied.base.days, 7);
  assert.equal(entry.to, 7 * model.DAY);
  assert.equal(applied.series[0].m.id, 'tps');
  applied.groups.forEach((group, index) => assert.equal(group.start, epoch(starts[index])));
  assert.equal(model.clockOf(model.DAY, false), '11/13 00:00');
  assertChartSamplesMatchTable(model, entry);

  model.runQuery(true);

  assert.equal(model.isDirty(), false);
  assert.notEqual(model.state.applied, applied);
  assert.equal(model.state.applied.base.date, '2026-12-01');
  assert.equal(model.cur().to, 90 * model.DAY);
  assert.equal(model.state.applied.series[0].m.id, 'active');
  assert.equal(model.state.applied.groups[1].start, epoch('2026-11-17'));
  assert.equal(model.state.applied.groups[2].start, epoch('2026-10-01'));
  assert.equal(model.clockOf(model.DAY, false), '12/2 00:00');
  assertChartSamplesMatchTable(model, model.cur());
});
