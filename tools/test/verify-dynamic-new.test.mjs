// wds-verify with a browser: attribute-driven dialogs in another language, the new step kinds, data-wds-verify, the reload check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeApp, verify, miniApp, readApp, variant } from './helpers.mjs';

const GOOD_DE = variant(readApp('good'), "WDS.connect({ scope: 'wds-verify-demo-k7m2a9' })", "WDS.connect({ scope: 'wds-verify-demo-k7m2a9', locale: 'de' })");

test('the dialogs are driven by attributes, so an app in German passes (forced locale in the app, and the browser locale from wds-verify.json and from --locale)', { timeout: 180000 }, async () => {
  const forced = await verify(writeApp(GOOD_DE, { locale: 'de-DE' }));
  assert.equal(forced.code, 0, JSON.stringify(forced.failures));
  assert.equal(forced.find('vault').level, 'pass');
  assert.equal(forced.find('saved').level, 'pass');
  assert.equal(forced.find('locale').level, 'info');
  assert.match(forced.find('locale').detail, /de-DE/);
  // no locale option in the app: the browser language decides, from --locale
  const viaFlag = await verify(writeApp(readApp('good')), ['--locale', 'de-DE']);
  assert.equal(viaFlag.code, 0, JSON.stringify(viaFlag.failures));
  assert.match(viaFlag.find('locale').detail, /de-DE/);
  assert.equal(viaFlag.find('reload').level, 'pass');
  // default: no locale finding
  assert.equal((await verify(writeApp(readApp('good')))).find('locale'), undefined);
});

const CSV_BODY = '<label>Title <input id="t" type="text"></label><select id="p"><option value="">-</option><option value="p1">Project one</option></select>'
  + '<button id="csv" type="button">Get list</button><button id="gone" type="button">Entfernen</button><span id="shown"></span>';
const csvApp = (extra = '') => miniApp({
  body: CSV_BODY,
  script: [
    "  var saved = {};",
    "  function save() { saved = { t: $('t').value, p: $('p').value }; store.set('entry', saved); }",
    "  $('t').addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });",
    "  $('p').addEventListener('change', function () { if ($('t').value) save(); });",
    "  $('csv').addEventListener('click', function () {",
    "    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['title,project\\n' + $('t').value + ',' + $('p').value])); a.download = 'list.csv'; document.body.appendChild(a); a.click();",
    "  });" + extra,
    "  store.unlock().then(function () { return store.get('entry'); }).then(function (v) { if (v) { $('t').value = v.t; $('p').value = v.p; $('shown').textContent = v.t; } });"].join('\n'),
});

test('select, press and download steps: a user-requested download is information, not a leak; the report names the buttons it did not press', { timeout: 180000 }, async () => {
  const steps = [{ fill: ['#t', 'a title typed by the steps 424242'] }, { select: ['#p', 'p1'] }, { press: ['#t', 'Enter'] }, { download: '#csv' }];
  const r = await verify(writeApp(csvApp(), steps));
  assert.equal(r.code, 0, JSON.stringify(r.failures) + r.stderr);
  assert.equal(r.find('saved').level, 'pass');
  assert.equal(r.find('leak-download').level, 'pass');
  assert.match(r.find('downloads').detail, /list\.csv \(user-requested download, contains canaries: yes\)/);
  assert.match(r.find('steps').detail, /4 step\(s\) run \(1 fill, 0 click, 0 upload, 0 wait, 1 select, 1 press, 1 download\)/);
  assert.match(r.parsed.notTested.join('\n'), /"Entfernen"/);
  // a download that nobody asked for stays a leak
  const unasked = csvApp("\n  $('t').addEventListener('change', function () { $('csv').click(); });");
  const bad = await verify(writeApp(unasked, [{ fill: ['#t', 'a title typed by the steps 515151'] }, { press: ['#t', 'Enter'] }]));
  assert.equal(bad.code, 1);
  assert.ok(bad.titles('fail').includes('Canary found in download'), bad.titles('fail').join('|'));
  // a download step that downloads nothing fails with its number
  const none = await verify(writeApp(csvApp(), [{ fill: ['#t', 'a title typed by the steps 626262'] }, { press: ['#t', 'Enter'] }, { download: '#gone' }]));
  assert.ok(none.titles('fail').includes('wds-verify.json step 3'), none.titles('fail').join('|'));
});

test('data-wds-verify="save" marks the app\'s own save button, whatever its language', { timeout: 180000 }, async () => {
  const body = '<label>Titel <input id="t" type="text"></label><button id="go" type="button" data-wds-verify="save">Weiter</button><button id="ok2" type="button">Weiter ohne Hinweis</button>';
  const script = "  $('go').addEventListener('click', function () { store.set('entry', { t: $('t').value }); });\n"
    + "  store.unlock().then(function () { return store.get('entry'); }).then(function (v) { if (v) $('t').value = v.t; });";
  const r = await verify(writeApp(miniApp({ body, script })));
  assert.equal(r.code, 0, JSON.stringify(r.failures));
  assert.equal(r.find('saved').level, 'pass');
  assert.match(r.find('fields').detail, /"Weiter"/);
  assert.doesNotMatch(r.find('fields').detail, /ohne Hinweis/);
  // without the attribute the same page is not recognised
  const plain = await verify(writeApp(miniApp({ body: body.replace(' data-wds-verify="save"', ''), script })));
  assert.equal(plain.code, 1);
  assert.ok(plain.titles('fail').includes('Data was saved'));
  assert.match(plain.find('saved').detail, /data-wds-verify="save"/);
});

const TAB_BODY = '<button id="tab-notes" type="button">Notes</button><div id="panel" hidden><label>Note <textarea id="note"></textarea></label><button id="keep" type="button">Keep</button><span id="out"></span></div>';
const tabApp = (reads = true) => miniApp({
  body: TAB_BODY,
  script: "  $('tab-notes').addEventListener('click', function () { $('panel').hidden = false; });\n  $('keep').addEventListener('click', function () { store.set('note', $('note').value); });\n"
    + (reads ? "  store.unlock().then(function () { return store.get('note'); }).then(function (v) { if (v) { $('note').value = v; $('out').textContent = v; } });" : "  store.unlock();"),
});

test('reload check: data in a tab that is closed after the reload needs afterReload steps; an app that never reads back fails', { timeout: 240000 }, async () => {
  const steps = [{ click: '#tab-notes' }, { fill: ['#note', 'a note in the second tab 777001'] }, { click: '#keep' }];
  // no afterReload: records were written and nothing is visible: FAIL, with the advice
  const closed = await verify(writeApp(tabApp(), steps));
  assert.equal(closed.code, 1);
  assert.ok(closed.titles('fail').includes('Data after reload'), closed.titles('fail').join('|'));
  assert.match(closed.find('reload').detail, /afterReload/);
  // with afterReload steps the tab is opened again: pass
  const opened = await verify(writeApp(tabApp(), { steps, afterReload: [{ click: '#tab-notes' }] }));
  assert.equal(opened.code, 0, JSON.stringify(opened.failures));
  assert.equal(opened.find('reload').level, 'pass');
  // the app does not read anything back: FAIL without afterReload steps; with them only a warning (the tool cannot know which view to open)
  const never = await verify(writeApp(tabApp(false), steps));
  assert.equal(never.code, 1);
  assert.ok(never.titles('fail').includes('Data after reload'));
  const neverOpened = await verify(writeApp(tabApp(false), { steps, afterReload: [{ click: '#tab-notes' }] }));
  assert.equal(neverOpened.code, 0, JSON.stringify(neverOpened.failures));
  assert.ok(neverOpened.titles('warn').includes('Data after reload'));
});

test('reload check: warning when some typed values come back and others do not', { timeout: 180000 }, async () => {
  const body = '<label>A <input id="a" type="text"></label><label>B <input id="b" type="text"></label><button id="save" type="button">Save</button>';
  // the field typed by the tool comes back, the one filled by a step (a second group) does not
  const app = miniApp({ body, script: "  $('save').addEventListener('click', function () { store.set('ab', { a: $('a').value, b: $('b').value }); });\n"
    + "  store.unlock().then(function () { return store.get('ab'); }).then(function (v) { if (v) $('a').value = v.a; });" });
  const r = await verify(writeApp(app, [{ fill: ['#b', 'filled by a step 99887766'] }, { click: '#save' }]));
  assert.equal(r.code, 0, JSON.stringify(r.failures));
  assert.ok(r.titles('warn').includes('Data after reload'), JSON.stringify(r.warnings.map((w) => w.title)));
  assert.match(r.find('reload').detail, /afterReload steps/);
  assert.equal((await verify(writeApp(app, [{ fill: ['#b', 'filled by a step 99887766'] }, { click: '#save' }]), ['--strict'])).code, 1);
});

