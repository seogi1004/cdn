const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

function loadReport() {
  const html = fs.readFileSync(path.join(__dirname, '../soul.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'http://localhost/soul.html',
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  // Browser rendering is checked separately with Playwright; do not fetch CDNs here.
  window.Chart = class {
    constructor(_canvas, config) { Object.assign(this, config); }
    resize() {}
    destroy() {}
  };
  for (const script of window.document.querySelectorAll('script:not([src])')) {
    new vm.Script(script.textContent).runInContext(dom.getInternalVMContext());
  }
  const data = vm.runInContext('RAW_CLINICAL_DATA', dom.getInternalVMContext());
  window.onload();
  return { dom, window, document: window.document, data };
}

test('the reviewed report retains all 984 original numeric fields', () => {
  const { dom, data } = loadReport();
  try {
    const fields = [];
    function collect(value, key) {
      if (typeof value === 'number') fields.push([key, value]);
      else if (value && typeof value === 'object') {
        Object.entries(value).forEach(([child, item]) => collect(item, `${key}.${child}`));
      }
    }
    for (const who of ['wife', 'husband']) {
      const person = data[who];
      collect({
        age: person.age,
        validity: person.validity,
        tci: { main: person.tci.main, subscales: person.tci.subscales },
        mmpi2: person.mmpi2,
      }, who);
    }
    fields.sort((a, b) => a[0].localeCompare(b[0], 'en'));
    assert.equal(fields.length, 984);
    // Baseline is the reviewed, pre-edit 2026-08-30 report. No duplicate personal dataset.
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex'),
      'f099c9706c3d2085ce63adc9478afa7026335558630498c61f5d6ae71d1690ad');
  } finally { dom.window.close(); }
});

test('tables preserve norms, K correction, missing Mf scores and TRIN direction', () => {
  const { dom, document } = loadReport();
  try {
    assert.equal(document.querySelectorAll('#data-tables tbody tr').length, 163);
    assert.equal(document.querySelectorAll('.strength-card').length, 6);
    assert.equal(document.querySelectorAll('.insight-card').length, 26);
    const lastCell = (section, code) => document.querySelector(
      `#${section} tr[data-scale="${code}"]`).lastElementChild.textContent;
    assert.equal(lastCell('sec-tci-main', 'NS'), '23 / 45 / 31 (중간)');
    assert.equal(lastCell('sec-tci-sub', 'HA3'), '6 (-0.8SD)');
    assert.equal(lastCell('sec-mmpi-clinical', 'TRIN'), '10 / 55 / 54 · 그렇다 방향');
    assert.equal(lastCell('sec-mmpi-clinical', 'Mf'), '24 / — / 46');
    assert.equal(lastCell('sec-mmpi-k', 'Ma'), '23 / 49 / 48');
    const exported = JSON.parse(document.querySelector('#aiJsonDataArea').value);
    assert.equal(exported.meta.institution, null);
    assert.equal(exported.husband.mmpi2.validity.TRIN.totalDirection, 'T');
    assert.equal(document.querySelector('#data-error').classList.contains('hidden'), true);
    assert.equal(document.querySelector('#chart-error').classList.contains('hidden'), true);
    for (const phrase of ['치료 동기 극저하', '임상적 결핍', '치명적 미성숙', '100% 진실성', '평생 불변']) {
      assert.equal(document.body.textContent.includes(phrase), false, phrase);
    }
  } finally { dom.window.close(); }
});

test('copy failure is reported accurately and tabs show only the selected panel', async () => {
  const { dom, window, document } = loadReport();
  try {
    window.document.execCommand = () => false;
    await window.copyAiJsonData();
    assert.match(document.querySelector('#copy-status').textContent, /직접 복사/);
    window.document.execCommand = () => true;
    await window.copyAiJsonData();
    assert.equal(document.querySelector('#copy-status').textContent, 'JSON을 복사했습니다.');
    for (const tab of ['wife', 'husband', 'couple', 'data']) {
      window.switchTab(tab);
      const visible = document.querySelectorAll('.tab-content:not(.hidden)');
      assert.equal(visible.length, 1);
      assert.equal(visible[0].id, `tab-${tab}`);
    }
  } finally { dom.window.close(); }
});

test('chart CDN failure leaves readable data and a visible status message', () => {
  const { dom, window, document } = loadReport();
  try {
    window.Chart = undefined;
    window.onload();
    window.switchTab('husband');
    assert.equal(document.querySelector('#chart-error').classList.contains('hidden'), false);
    assert.equal(document.querySelector('#data-error').classList.contains('hidden'), true);
    assert.equal(document.querySelectorAll('#data-tables tbody tr').length, 163);
    assert.equal(document.querySelector('.tab-content:not(.hidden)').id, 'tab-husband');
  } finally { dom.window.close(); }
});
