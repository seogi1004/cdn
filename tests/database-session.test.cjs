// Dependency-free integration checks against the prototype's real state/query/persistence code.
// Run: node --test tests/database-session.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const test = require('node:test');
const sourcePath = path.join(__dirname, '..', 'database.html');
const html = fs.readFileSync(sourcePath, 'utf8');
const coreStart = html.indexOf('const DAY =');
const coreEnd = html.indexOf('/* ---------- 드릴다운 ---------- */', coreStart);
const sessionStart = html.indexOf('const SESSION_KEY =');
const sessionEnd = html.indexOf('/* ---------- 시작', sessionStart);
assert.ok(coreStart >= 0 && coreEnd > coreStart, 'the search-model section must exist');
assert.ok(sessionStart >= 0 && sessionEnd > sessionStart, 'the session-persistence section must exist');
const core = html.slice(coreStart, coreEnd);
const fragment = html.slice(sessionStart, sessionEnd);
const KEY = 'dbsearch-proto.session.v1';
const plain = value => JSON.parse(JSON.stringify(value));

function app(initial = {}, failStorage = false) {
  const storage = new Map(Object.entries(initial)), events = {}, timers = new Map();
  let timerId = 0, writes = 0;
  const context = vm.createContext({
    console,
    localStorage: {
      getItem(key) { if (failStorage) throw new Error('Blocked storage'); return storage.get(key) ?? null; },
      setItem(key, value) { if (failStorage) throw new Error('Quota exceeded'); storage.set(key, value); writes++; },
    },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    window: { addEventListener(type, fn) { events[type] = fn; } },
    document: { visibilityState: 'visible', addEventListener(type, fn) { events[type] = fn; } },
  });
  vm.runInContext(`
    function toast() {}
    function renderGroups() {}
    function renderBuilder() { queueSessionSave(); }
    function renderResults() { queueSessionSave(); }
    ${core}
    ${fragment}
    globalThis.api = { state, mkGroup, runQuery, isDirty, defOf, saveSession, restoreSession, queueSessionSave,
      readSessionDefinition, ready: () => { sessionReady = true; }, getUid: () => uid };
  `, context, { filename: sourcePath });
  return { ...context.api, storage, events, timers, context, writes: () => writes,
    snapshot: () => ({ [KEY]: storage.get(KEY) }) };
}

test('fresh startup has no restore and leaves the seven-day defaults intact', () => {
  const a = app();
  assert.equal(a.restoreSession(), false);
  assert.equal(a.state.base.days, 7);
  assert.equal(a.state.groups.length, 3);
  assert.equal(a.state.applied, null);
  assert.equal(a.writes(), 0);
});

test('dirty draft, applied conditions, hidden series, periods, and IDs round-trip independently', () => {
  const a = app();
  assert.equal(a.runQuery(true), true);
  const originalApplied = plain(a.state.applied);
  const hiddenKey = a.state.applied.series[0].key;
  a.state.applied.series[0].hidden = true;
  const sampleBefore = Array.from(a.state.history[0].data.series[hiddenKey].vals.slice(0, 5));
  a.state.base = { date: '2026-11-15', days: 30, opHours: true, weekendEx: true };
  a.state.groups[0].targets = ['i-was02'];
  a.state.groups[1].period = { mode: 'date', date: '2026-10-01', shift: -7 };
  a.state.groups[1].interval = 3600;
  a.state.groups.push(a.mkGroup({ targets: [], metric: 'cpu', agg: 'SUM' }));
  const draftBefore = plain({ base: a.state.base, groups: a.state.groups });
  a.state.history.push({ from: 20, to: 40, res: 1, api: 'sec', data: { sentinel: 'must not persist' } });
  a.state.sel = { from: 20, to: 40 };
  a.ready();
  assert.equal(a.saveSession(), true);
  const saved = JSON.parse(a.storage.get(KEY));
  assert.equal(saved.draft.base.interval, undefined);
  assert.equal(saved.applied.base.resolvedInterval, undefined);
  assert.equal(saved.applied.groups[0].interval, null);
  assert.equal(saved.history, undefined);
  assert.equal(saved.applied.series, undefined);
  assert.ok(!a.storage.get(KEY).includes('must not persist'));
  assert.ok(a.storage.get(KEY).length < 10000);

  const b = app(a.snapshot());
  assert.equal(b.restoreSession(), true);
  assert.deepEqual(plain({ base: b.state.base, groups: b.state.groups }), draftBefore);
  assert.equal(b.state.applied.base.date, originalApplied.base.date);
  assert.equal(b.state.applied.base.days, 7);
  assert.deepEqual(plain(b.state.applied.groups.map(g => g.id)), originalApplied.groups.map(g => g.id));
  assert.deepEqual(plain(b.state.applied.groups.map(g => g.period)), originalApplied.groups.map(g => g.period));
  assert.equal(b.state.applied.series.find(s => s.key === hiddenKey).hidden, true);
  assert.equal(b.state.applied.groups[0].intervalInherit, true);
  assert.equal(b.state.applied.groups[2].intervalInherit, false);
  assert.equal(b.state.applied.groups[2].interval, 300);
  assert.equal(b.state.history.length, 1);
  assert.equal(b.state.history[0].from, 0);
  assert.equal(b.state.history[0].to, 7 * 86400);
  assert.equal(b.state.sel, null);
  assert.deepEqual(Array.from(b.state.history[0].data.series[hiddenKey].vals.slice(0, 5)), sampleBefore);
  assert.equal(b.isDirty(), true);
  assert.equal(b.writes(), 0, 'restore must not overwrite saved state during intermediate renders');
  assert.ok(b.mkGroup().id > Math.max(...draftBefore.groups.map(g => g.id)));
});

test('a clean query stays clean and matching IDs remain usable after restore', () => {
  const a = app(); a.runQuery(true); a.ready(); a.saveSession();
  const b = app(a.snapshot());
  assert.equal(b.restoreSession(), true);
  assert.equal(b.isDirty(), false);
  for (const g of b.state.applied.groups) {
    assert.equal(b.state.groups.find(d => d.id === g.id).targets.length, g.targets.length);
  }
});

test('applied group numbers retain their displayed values after an earlier group was deleted', () => {
  const a = app(); a.runQuery(true);
  const removedId = a.state.applied.groups[0].id;
  a.state.applied.groups.shift(); a.state.groups.shift();
  a.state.applied.series = a.state.applied.series.filter(s => s.g.id !== removedId);
  a.state.applied.def = a.defOf();
  a.ready(); a.saveSession();
  const b = app(a.snapshot());
  assert.equal(b.restoreSession(), true);
  assert.deepEqual(plain(b.state.applied.groups.map(g => g.no)), [2, 3]);
  assert.equal(b.isDirty(), false);
});

test('deleted applied results and their original dirty-comparison baseline survive reload', () => {
  const a = app(); a.runQuery(true);
  const baseline = a.state.applied.def;
  a.state.base.days = 8;
  const removed = a.state.applied.series[0];
  a.state.applied.series = a.state.applied.series.filter(s => s !== removed);
  removed.g.targets = removed.g.targets.filter(t => t !== removed.tg.id);
  a.state.groups.find(g => g.id === removed.g.id).targets = [...removed.g.targets];
  a.ready(); a.saveSession();
  const b = app(a.snapshot());
  assert.equal(b.restoreSession(), true);
  assert.equal(b.state.applied.def, baseline);
  assert.equal(b.state.applied.series.some(s => s.key === removed.key), false);
  assert.equal(b.isDirty(), true);

  a.state.applied.groups = []; a.state.applied.series = []; a.state.groups = [];
  a.saveSession();
  const empty = app(a.snapshot());
  assert.equal(empty.restoreSession(), true);
  assert.equal(empty.state.applied.groups.length, 0);
  assert.equal(empty.state.groups.length, 0);
  assert.equal(empty.state.history.length, 1);
  assert.ok(empty.state.history[0].data);
  assert.equal(empty.state.applied.def, baseline);
  assert.equal(empty.isDirty(), true);
});

test('an empty draft is retained with or without a previous applied query', () => {
  const a = app(); a.runQuery(true); a.state.groups = []; a.ready(); a.saveSession();
  const b = app(a.snapshot());
  assert.equal(b.restoreSession(), true);
  assert.equal(b.state.groups.length, 0);
  assert.equal(b.state.applied.groups.length, 3);
  assert.equal(b.isDirty(), true);
  a.state.applied = null; a.saveSession();
  const c = app(a.snapshot());
  assert.equal(c.restoreSession(), true);
  assert.equal(c.state.groups.length, 0);
  assert.equal(c.state.applied, null);
  assert.equal(c.state.history.length, 0);
});

test('stored malformed definitions fall back without changing initialized state', () => {
  const a = app(); a.runQuery(true); a.ready(); a.saveSession();
  const valid = JSON.parse(a.storage.get(KEY));
  const corruptions = [
    () => '{',
    s => { s.version = 99; },
    s => { s.draft.base.date = '2026-02-31'; },
    s => { s.draft.base.days = 91; },
    s => { s.draft.groups[0].metric = 'unknown'; },
    s => { s.draft.groups[0].targets = ['missing-target']; },
    s => { s.draft.groups[0].agg = 'unknown'; },
    s => { s.draft.groups[0].period = { mode: 'date', date: null, shift: -1 }; },
    s => { s.draft.groups[0].period.shift = Number.MAX_SAFE_INTEGER; },
    s => { s.applied.groups[0].interval = 0; },
    s => { s.applied.groups[0].targets = []; },
  ];
  corruptions.forEach(corrupt => {
    const s = plain(valid); const replacement = corrupt(s);
    const b = app({ [KEY]: typeof replacement === 'string' ? replacement : JSON.stringify(s) });
    const before = plain(b.state);
    assert.equal(b.restoreSession(), false);
    assert.deepEqual(plain(b.state), before);
    assert.equal(b.writes(), 0);
  });
});

test('legacy numeric base intervals migrate to groups, auto stays null, and missing days defaults to seven', () => {
  const a = app();
  const raw = plain({ base: a.state.base, groups: a.state.groups });
  raw.base.interval = 600; delete raw.base.days;
  const d = a.readSessionDefinition(raw);
  assert.equal(d.base.days, 7);
  assert.equal(d.base.interval, undefined);
  assert.deepEqual(plain(d.groups.map(g => g.interval)), [600, 600, 300]);
  raw.base.interval = 'auto';
  assert.deepEqual(plain(a.readSessionDefinition(raw).groups.map(g => g.interval)), [null, null, 300]);
});

test('invalid or duplicate group IDs are repaired and uid advances beyond restored IDs', () => {
  const a = app(); a.runQuery(true); a.ready(); a.saveSession();
  const saved = JSON.parse(a.storage.get(KEY));
  saved.draft.groups[0].id = 500;
  saved.applied.groups[0].id = 500;
  saved.draft.groups[1].id = 500;
  saved.draft.groups[2].id = -5;
  const b = app({ [KEY]: JSON.stringify(saved) });
  assert.equal(b.restoreSession(), true);
  assert.equal(b.state.groups[0].id, b.state.applied.groups[0].id);
  const ids = b.state.groups.map(g => g.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => id > 0));
  assert.ok(b.mkGroup().id > Math.max(...ids));
});

test('all added hour intervals keep seven-day samples and survive session restoration', () => {
  const hours = [2, 3, 4, 6, 8, 12, 24];
  const a = app();
  a.state.groups = hours.map((hour, i) => a.mkGroup({
    interval: hour * 3600, targets: ['i-was01'], period: { mode: 'shift', shift: -i },
  }));
  a.runQuery(true); a.ready(); a.saveSession();
  const b = app(a.snapshot());
  assert.equal(b.restoreSession(), true);
  assert.equal(b.isDirty(), false);
  assert.equal(b.state.history[0].to, 7 * 86400);
  b.state.applied.series.forEach((series, i) => {
    const data = b.state.history[0].data.series[series.key];
    assert.equal(series.g.interval, hours[i] * 3600);
    assert.equal(series.g.intervalInherit, false);
    assert.equal(b.state.groups[i].interval, hours[i] * 3600);
    assert.equal(data.res, hours[i] * 3600);
    assert.equal(data.vals.length, 7 * 24 / hours[i]);
  });
});

test('page hide flushes the latest draft and blocked storage never prevents querying', () => {
  const a = app(); a.runQuery(true); a.ready();
  a.state.base.days = 12; a.queueSessionSave();
  assert.equal(a.storage.get(KEY), undefined);
  assert.equal(a.timers.size, 1);
  a.events.pagehide();
  assert.equal(JSON.parse(a.storage.get(KEY)).draft.base.days, 12);
  assert.equal(a.timers.size, 0);
  a.state.base.days = 13; a.queueSessionSave();
  a.context.document.visibilityState = 'hidden'; a.events.visibilitychange();
  assert.equal(JSON.parse(a.storage.get(KEY)).draft.base.days, 13);
  const blocked = app({}, true);
  assert.equal(blocked.restoreSession(), false);
  assert.equal(blocked.runQuery(true), true);
  blocked.ready();
  assert.equal(blocked.saveSession(), false);
});
