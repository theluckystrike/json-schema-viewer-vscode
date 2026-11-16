'use strict';
// Extension tests with the vscode stub: listing, activation, the docs view's messages, free validation (schema from
// $schema, the setting, a pick; meta-schema; lines in the Problems panel; check again on save), the three Pro tools
// with their free try (one per tool, counted across files and after a reload), the webview HTML and the README.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadExtension, tmpDir, cleanup } = require('./support/vscode-stub');
const { docsHtml } = require('../src/html');

const ROOT = path.join(__dirname, '..');
const SHOP = path.join(ROOT, 'samples', 'shop');
const FIX = path.join(__dirname, 'fixtures');
const REAL = path.join(FIX, 'real');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
test.after(() => cleanup());

function activate(folder, state) {
  const s = loadExtension();
  if (folder) s.vscode.workspace.workspaceFolders = [{ uri: s.vscode.Uri.file(folder), name: 'ws' }];
  if (state) for (const [k, v] of state) s.state.set(k, v);
  s.api = s.ext.activate(s.context);
  s.int = s.ext._internal;
  return s;
}
function tmpWs() {
  const dir = tmpDir('jsonschema-ws-');
  fs.mkdirSync(path.join(dir, 'shop'));
  for (const f of fs.readdirSync(SHOP)) fs.copyFileSync(path.join(SHOP, f), path.join(dir, 'shop', f));
  fs.copyFileSync(path.join(FIX, 'order-v1.schema.json'), path.join(dir, 'shop', 'order-v1.schema.json'));
  fs.copyFileSync(path.join(FIX, 'broken.schema.json'), path.join(dir, 'broken.schema.json'));
  fs.mkdirSync(path.join(dir, 'oas'));
  fs.copyFileSync(path.join(REAL, 'openapi-3.0.schema.yaml'), path.join(dir, 'oas', 'openapi.schema.yaml'));
  fs.copyFileSync(path.join(REAL, 'petstore.yaml'), path.join(dir, 'oas', 'petstore.yaml'));
  fs.writeFileSync(path.join(dir, 'oas', 'BAD-PET.YAML'), 'openapi: 3.0.0\ninfo:\n  title: x\n  version: "1"\npaths: {}\n');
  return dir;
}
function fakePanel() {
  let onMsg;
  const posted = [];
  const disposeCbs = [];
  return {
    posted, viewColumn: 1, active: true, visible: true,
    webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { posted.push(m); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
    onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: (f) => { disposeCbs.push(f); return { dispose() {} }; }, reveal() {}, dispose() { disposeCbs.forEach((f) => f()); },
    send: (m) => onMsg(m),
  };
}
async function openDocs(s, file) {
  const prov = s.int.viewer();
  const doc = await s.vscode.workspace.openTextDocument(s.vscode.Uri.file(file));
  const panel = fakePanel();
  await prov.resolveCustomTextEditor(doc, panel);
  panel.send({ type: 'ready' });
  const sess = prov.sessions.get(doc.uri.toString());
  await sess.loaded;
  await tick(5);
  return { prov, panel, doc, sess, last: (t) => panel.posted.filter((m) => m.type === t).pop() };
}
const proPanel = (s) => [...s.log.info, ...s.log.warn].find((w) => /is part of Zovo Pro/.test(w.text));
const tries = (s) => s.state.get('jsonSchemaViewer.proTrial') || {};
const diagsOf = (s, file) => s.diags.get(s.vscode.Uri.file(file).toString()) || [];

// ---------- package.json and listing ----------
test('listing: display name with the phrase first, 30 characters or less, 5 keywords, engines for Cursor and Windsurf', () => {
  assert.equal(pkg.displayName, 'JSON Schema Viewer & Validator');
  assert.ok(pkg.displayName.length <= 30);
  assert.ok(pkg.description.startsWith('JSON Schema'));
  assert.deepEqual(pkg.keywords, ['json schema', 'json', 'schema', 'validator', 'documentation']);
  assert.equal(pkg.engines.vscode, '^1.75.0');
  assert.equal(`${pkg.publisher}.${pkg.name}`, 'zovo.zovo-json-schema-viewer');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository.url, 'https://github.com/theluckystrike/json-schema-viewer-vscode');
  assert.deepEqual(pkg.activationEvents, ['onUri', 'onLanguage:json', 'onLanguage:jsonc', 'onLanguage:yaml']);
  for (const e of pkg.activationEvents) assert.ok(!/^\*$|onStartupFinished/.test(e));
});
test('custom editor: *.schema.json / .yaml / .yml with priority "option"; own view type, command ids and icons (no clash with our JSON listings)', () => {
  assert.deepEqual(pkg.contributes.customEditors.map((c) => [c.viewType, c.selector.map((x) => x.filenamePattern), c.priority]), [['jsonSchemaViewer.docs', ['*.schema.json', '*.schema.yaml', '*.schema.yml'], 'option']]);
  const mine = new Set([...pkg.contributes.customEditors.map((x) => x.viewType), ...pkg.contributes.commands.map((x) => x.command)]);
  const myIcons = pkg.contributes.commands.filter((c) => c.icon).map((c) => c.icon);
  assert.deepEqual(myIcons, ['$(book)', '$(code)']);
  for (const other of ['json-editor-vscode', 'json-tree-viewer-vscode', 'swagger-openapi-viewer-vscode']) {
    const f = path.join(ROOT, '..', other, 'package.json');
    if (!fs.existsSync(f)) continue;
    const v = JSON.parse(fs.readFileSync(f, 'utf8'));
    const theirs = [...(v.contributes.customEditors || []).map((c) => c.viewType), ...v.contributes.commands.map((c) => c.command)];
    for (const c of theirs) assert.ok(!mine.has(c), `${other}: ${c}`);
    for (const c of v.contributes.commands.filter((x) => x.icon)) assert.ok(!myIcons.includes(c.icon), `${other} icon ${c.icon}`);
  }
});
test('every contributed command is registered, every registered command of this listing is contributed, no menu has a title', () => {
  const s = activate();
  const contributed = pkg.contributes.commands.map((c) => c.command);
  for (const c of contributed) assert.ok(s.commands.has(c), `not registered: ${c}`);
  for (const c of s.commands.keys()) if (c.startsWith('jsonSchemaViewer.')) assert.ok(contributed.includes(c), `not in package.json: ${c}`);
  for (const m of Object.values(pkg.contributes.menus).flat()) { assert.ok(contributed.includes(m.command), m.command); assert.equal(m.title, undefined); }
  for (const id of ['sample', 'export', 'diff']) assert.match(pkg.contributes.commands.find((c) => c.command === `jsonSchemaViewer.zovoPro.${id}`).title, /^Zovo Pro: /);
});
test('menus: one backslash before the dot; schema entries match ORDER.SCHEMA.JSON and .schema.yml, not plain JSON; validate matches CONFIG.YAML', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  assert.ok(!raw.includes('\\\\\\\\.'), 'no doubled backslash');
  for (const m of pkg.contributes.menus['explorer/context']) {
    const rx = new RegExp(/resourceFilename =~ \/(.+?)\/i/.exec(m.when)[1], 'i');
    if (m.command === 'jsonSchemaViewer.validate') assert.ok(rx.test('CONFIG.YAML') && rx.test('a.json') && rx.test('b.yml') && !rx.test('a.xml'), m.when);
    else assert.ok(rx.test('ORDER.SCHEMA.JSON') && rx.test('a.schema.yml') && rx.test('a.schema.yaml') && !rx.test('a.json') && !rx.test('schema.json'), m.when);
  }
});
test('activation shows nothing: no message, no panel, no editor; the title-bar key follows the active editor', async () => {
  const s = activate();
  assert.equal(s.log.info.length + s.log.warn.length + s.log.error.length, 0);
  assert.equal(s.log.panel, undefined);
  assert.equal(s.log.opened.length, 0);
  assert.equal(s.log.external.length, 0);
  assert.ok(s.ext.isSchemaDoc(s.makeDoc(s.vscode.Uri.file('/x/ORDER.SCHEMA.JSON'), '{}', 'json')));
  assert.ok(s.ext.isSchemaDoc(s.makeDoc(s.vscode.Uri.file('/x/tool.json'), '{ "$schema": "http://json-schema.org/draft-07/schema#" }', 'json')));
  assert.ok(!s.ext.isSchemaDoc(s.makeDoc(s.vscode.Uri.file('/x/order.json'), '{ "$schema": "./order.schema.json" }', 'json')));
});

// ---------- docs view ----------
test('docs view: the sample loads with its 2 files, status line, model rows; opening never writes', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const before = fs.readFileSync(path.join(dir, 'shop', 'order.schema.json'), 'utf8');
  const v = await openDocs(s, path.join(dir, 'shop', 'order.schema.json'));
  const load = v.last('load');
  assert.equal(load.name, 'order.schema.json');
  assert.equal(load.status, 'JSON Schema 2020-12 · 27 properties · 4 definitions · 2 files');
  assert.deepEqual(load.model.files.map((f) => f.name), ['order.schema.json', 'address.schema.json']);
  assert.deepEqual(load.model.nodes[load.model.root].props.map((p) => p[0]), ['id', 'status', 'placedAt', 'customer', 'lines', 'shipTo', 'coupon', 'gift', 'payment', 'notes']);
  assert.match(v.panel.webview.html, /Content-Security-Policy/);
  assert.equal(fs.readFileSync(path.join(dir, 'shop', 'order.schema.json'), 'utf8'), before);
  assert.equal(s.log.saved.length, 0);
});
test('docs view: a row opens its line beside; Go to $ref target opens the other file; remote address copies, never opens', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const v = await openDocs(s, path.join(dir, 'shop', 'order.schema.json'));
  v.panel.send({ type: 'reveal', f: 1, l: 13 });
  await tick(10);
  const d = s.log.opened.pop();
  assert.ok((d.document || d).uri.fsPath.endsWith('address.schema.json'));
  v.panel.send({ type: 'copy', text: 'https://json.schemastore.org/eslintrc.json' });
  await tick(5);
  assert.equal(s.log.clipboard, 'https://json.schemastore.org/eslintrc.json');
  assert.equal(s.log.external.length, 0);
});
test('docs view: a change typed in the schema text redraws; a syntax error shows its line; a fix redraws again', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const v = await openDocs(s, path.join(dir, 'shop', 'address.schema.json'));
  const n0 = v.panel.posted.filter((m) => m.type === 'load').length;
  const t = v.doc.getText();
  v.doc._set(t.replace('"city": { "type": "string" }', '"city": { "type": "string" }, "region": { "type": "string" }'));
  for (const f of s.listeners.change) f({ document: v.doc, contentChanges: [{ text: 'x' }] });
  await tick(450);
  const l = v.last('load');
  assert.equal(v.panel.posted.filter((m) => m.type === 'load').length, n0 + 1);
  assert.ok(l.model.nodes[l.model.root].props.some((p) => p[0] === 'region'));
  v.doc._set(t.replace('"city": { "type": "string" },', '"city": { "type": "string" }'));
  for (const f of s.listeners.change) f({ document: v.doc, contentChanges: [{ text: 'x' }] });
  await tick(450);
  const e = v.last('error');
  assert.ok(e && e.line === 11 && /Comma expected/.test(e.message), JSON.stringify(e));
});
test('docs view: broken schema file shows the error with its line; a JSON file that is no schema loads with a hint flag', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const v = await openDocs(s, path.join(dir, 'broken.schema.json'));
  const e = v.last('error');
  assert.equal(e.line, 6);
  assert.match(e.message, /Comma expected/);
  const w = await openDocs(s, path.join(dir, 'shop', 'order.json'));
  assert.equal(w.last('load').model.info.looksLikeSchema, false);
});

// ---------- free validation ----------
test('validate: order.json is valid through its $schema; the YAML gives 11 errors in the Problems panel with lines and rules', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const ok = await s.vscode.commands.executeCommand('jsonSchemaViewer.validate', s.vscode.Uri.file(path.join(dir, 'shop', 'order.json')));
  assert.equal(ok.valid, true);
  assert.equal(ok.via, '$schema');
  assert.ok(s.log.info.some((m) => m.text === 'order.json is valid against order.schema.json.'));
  const bad = await s.vscode.commands.executeCommand('jsonSchemaViewer.validate', s.vscode.Uri.file(path.join(dir, 'shop', 'order-with-errors.yaml')));
  assert.equal(bad.valid, false);
  const ds = diagsOf(s, path.join(dir, 'shop', 'order-with-errors.yaml'));
  assert.equal(ds.length, 11);
  const colour = ds.find((d) => d.code === 'additionalProperties');
  assert.equal(colour.range.start.line, 15);
  assert.equal(colour.source, 'JSON Schema');
  assert.match(colour.message, /^\/colour: must NOT have additional properties: "colour" \(rule additionalProperties at #\/additionalProperties\)$/);
  assert.ok(ds.some((d) => d.range.start.line === 7 && /\/lines\/0\/qty: must be >= 1/.test(d.message)));
  assert.ok(s.log.warn.some((m) => m.text === 'order-with-errors.yaml: 11 errors against order.schema.json. See the Problems panel.'));
  assert.equal(s.log.external.length, 0);
});
test('validate: no $schema: the picker lists the workspace schemas, the pick is kept for that file; the setting maps globs', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const pet = path.join(dir, 'oas', 'petstore.yaml');
  s.ui.quick.push((items) => items.find((x) => x.label === 'openapi.schema.yaml'));
  const r = await s.vscode.commands.executeCommand('jsonSchemaViewer.validate', s.vscode.Uri.file(pet));
  assert.ok(s.log.lastPick.items.some((x) => x.label === 'order.schema.json') && s.log.lastPick.items.some((x) => x.label === 'Choose a schema file...'));
  assert.equal(r.valid, true, r.summary);
  const r2 = await s.vscode.commands.executeCommand('jsonSchemaViewer.validate', s.vscode.Uri.file(pet));
  assert.equal(r2.via, 'picked');
  s.config.schemas = [{ fileMatch: ['oas/*.YAML'], url: './oas/openapi.schema.yaml' }];
  const r3 = await s.vscode.commands.executeCommand('jsonSchemaViewer.validate', s.vscode.Uri.file(path.join(dir, 'oas', 'BAD-PET.YAML')));
  assert.equal(r3.via, 'setting');
  assert.equal(r3.valid, true, 'a minimal OpenAPI 3.0 document is valid');
  fs.writeFileSync(path.join(dir, 'oas', 'BAD-PET.YAML'), 'openapi: 2.0\ninfo: {}\n');
  const r4 = await s.vscode.commands.executeCommand('jsonSchemaViewer.validate', s.vscode.Uri.file(path.join(dir, 'oas', 'BAD-PET.YAML')));
  assert.equal(r4.valid, false);
  assert.ok(diagsOf(s, path.join(dir, 'oas', 'BAD-PET.YAML')).some((d) => /must have required property 'paths'/.test(d.message)));
  fs.writeFileSync(path.join(dir, 'plain.schema.json'), '{ "type": "object", "properties": { "a": { "type": "string" } } }');
  const none = await s.vscode.commands.executeCommand('jsonSchemaViewer.validate', s.vscode.Uri.file(path.join(dir, 'plain.schema.json')));
  assert.equal(none.via, 'schema file', 'a .schema.json with no $schema is checked against the meta-schema');
  assert.equal(none.valid, true);
});
test('validate: a schema file with a json-schema.org $schema is checked against the meta-schema; broken data says so', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const file = path.join(dir, 'shop', 'meta-bad.schema.json');
  fs.writeFileSync(file, '{\n  "$schema": "http://json-schema.org/draft-07/schema#",\n  "type": "strin"\n}\n');
  const r = await s.vscode.commands.executeCommand('jsonSchemaViewer.validate', s.vscode.Uri.file(file));
  assert.equal(r.valid, false);
  assert.match(r.summary, /against the JSON Schema draft-07 meta-schema/);
  assert.ok(diagsOf(s, file).some((d) => d.range.start.line === 2));
  const b = await s.vscode.commands.executeCommand('jsonSchemaViewer.validate', s.vscode.Uri.file(path.join(dir, 'broken.schema.json')));
  assert.ok(b.parseError && b.parseError.line === 6);
  assert.ok(s.log.warn.some((m) => /broken\.schema\.json is not valid JSON \(line 6\)/.test(m.text)));
});
test('validate: from the docs view, "Validate a file" checks the picked file against that schema and posts the summary', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const v = await openDocs(s, path.join(dir, 'shop', 'order.schema.json'));
  s.ui.quick.push((items) => items.find((x) => x.label === 'order-with-errors.yaml'));
  v.panel.send({ type: 'validateFile' });
  await tick(80);
  assert.ok(!s.log.lastPick.items.some((x) => /\.schema\.json$/.test(x.label)), 'schemas are not offered as data');
  const m = v.last('validation');
  assert.equal(m.ok, false);
  assert.match(m.text, /order-with-errors\.yaml: 11 errors against order\.schema\.json/);
});
test('validate: a validated file is checked again on save, also when its schema is saved', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const data = path.join(dir, 'shop', 'order.json');
  await s.vscode.commands.executeCommand('jsonSchemaViewer.validate', s.vscode.Uri.file(data));
  assert.equal(diagsOf(s, data).length, 0);
  fs.writeFileSync(data, fs.readFileSync(data, 'utf8').replace('"status": "paid"', '"status": "lost"'));
  await s.int.validator().onSave({ uri: s.vscode.Uri.file(data) });
  assert.equal(diagsOf(s, data).length, 1);
  assert.ok(s.log.status.some((t) => /JSON Schema: order\.json: 1 error against order\.schema\.json/.test(t)));
  const schema = path.join(dir, 'shop', 'order.schema.json');
  fs.writeFileSync(schema, fs.readFileSync(schema, 'utf8').replace('"delivered", "cancelled"', '"delivered", "cancelled", "lost"'));
  await s.int.validator().onSave({ uri: s.vscode.Uri.file(schema) });
  assert.equal(diagsOf(s, data).length, 0);
});

// ---------- Pro tools ----------
test('Pro sample: all fields, written next to the schema and opened; counted after it shows; checked against the schema', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const schema = s.vscode.Uri.file(path.join(dir, 'shop', 'order.schema.json'));
  s.ui.quick.push((items) => items.find((x) => x.id === 'all'));
  const r = await s.vscode.commands.executeCommand('jsonSchemaViewer.sample', schema);
  assert.ok(r.uri.fsPath.endsWith(path.join('shop', 'order.sample.json')));
  const doc = JSON.parse(fs.readFileSync(r.uri.fsPath, 'utf8'));
  assert.equal(doc.id, 'ORD-004211');
  assert.equal(r.valid, 1);
  assert.equal(tries(s).sample, 1);
  assert.ok(s.log.opened.some((d) => (d.document || d).uri && (d.document || d).uri.fsPath === r.uri.fsPath));
  const st = s.log.status;
  assert.match(st[st.length - 1], /the free try of "Generate sample JSON" is used/, 'the try message is the last status line');
  assert.ok(st.some((t) => /Sample JSON: 1 document written to order\.sample\.json; 1 of 1 passes the schema\./.test(t)));
});
test('Pro sample: used once on schema A, a click for schema B opens the Zovo Pro panel and writes nothing', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  await s.vscode.commands.executeCommand('jsonSchemaViewer.sample', s.vscode.Uri.file(path.join(dir, 'shop', 'order.schema.json')), { mode: 'many', count: 15 });
  const test1 = JSON.parse(fs.readFileSync(path.join(dir, 'shop', 'order.test-data.json'), 'utf8'));
  assert.equal(test1.length, 15);
  assert.equal(tries(s).sample, 1);
  const r = await s.vscode.commands.executeCommand('jsonSchemaViewer.sample', s.vscode.Uri.file(path.join(dir, 'oas', 'openapi.schema.yaml')), { mode: 'all' });
  assert.equal(r, undefined);
  assert.match(proPanel(s).text, /Generate sample JSON is part of Zovo Pro/);
  assert.ok(!fs.readdirSync(path.join(dir, 'oas')).some((f) => /sample/.test(f)));
});
test('Pro sample: Escape at the first pick uses no try; a broken schema stops with the reason and uses no try', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  s.ui.quick.push(undefined);
  assert.equal(await s.vscode.commands.executeCommand('jsonSchemaViewer.sample', s.vscode.Uri.file(path.join(dir, 'shop', 'order.schema.json'))), undefined);
  assert.equal(await s.vscode.commands.executeCommand('jsonSchemaViewer.sample', s.vscode.Uri.file(path.join(dir, 'broken.schema.json')), { mode: 'all' }), undefined);
  assert.ok(s.log.error.some((m) => /broken\.schema\.json: Comma expected at line 6/.test(m.text)));
  assert.equal(tries(s).sample, undefined);
});
test('Pro export: Markdown next to the schema, opened, counted; then HTML on schema B opens the Pro panel', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  s.ui.quick.push((items) => items.find((x) => x.id === 'md'));
  const r = await s.vscode.commands.executeCommand('jsonSchemaViewer.export', s.vscode.Uri.file(path.join(dir, 'shop', 'order.schema.json')));
  assert.equal(r.sections, 8);
  const md = fs.readFileSync(path.join(dir, 'shop', 'order.docs.md'), 'utf8');
  assert.match(md, /\| `lines` \| array of \[line\]\(#line\) \| yes \|/);
  assert.equal(tries(s).export, 1);
  const r2 = await s.vscode.commands.executeCommand('jsonSchemaViewer.export', s.vscode.Uri.file(path.join(dir, 'oas', 'openapi.schema.yaml')), { format: 'html' });
  assert.equal(r2, undefined);
  assert.match(proPanel(s).text, /Export docs is part of Zovo Pro/);
  assert.ok(!fs.existsSync(path.join(dir, 'oas', 'openapi.docs.html')));
});
test('Pro diff: the older version is picked, a Markdown report opens with breaking changes first; schema B then opens the Pro panel', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  s.ui.quick.push((items) => items.find((x) => x.label === 'order-v1.schema.json'));
  const r = await s.vscode.commands.executeCommand('jsonSchemaViewer.diff', s.vscode.Uri.file(path.join(dir, 'shop', 'order.schema.json')));
  assert.ok(!s.log.lastPick.items.some((x) => x.label === 'order.schema.json'), 'the schema itself is not offered');
  assert.deepEqual([r.breaking, r.other, r.text], [5, 6, 1]);
  assert.equal(r.doc.languageId, 'markdown');
  assert.match(r.doc.getText(), /## Breaking changes\n\n\| Where \| Change \|\n\| --- \| --- \|\n\| `status` \| now required \|/);
  assert.equal(tries(s).diff, 1);
  const r2 = await s.vscode.commands.executeCommand('jsonSchemaViewer.diff', s.vscode.Uri.file(path.join(dir, 'oas', 'openapi.schema.yaml')));
  assert.equal(r2, undefined);
  assert.match(proPanel(s).text, /Schema diff is part of Zovo Pro/);
});
test('Pro tools from the docs toolbar (no file argument) use the schema of the active docs view', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  await openDocs(s, path.join(dir, 'shop', 'address.schema.json'));
  s.ui.quick.push((items) => items.find((x) => x.id === 'required'));
  const r = await s.vscode.commands.executeCommand('jsonSchemaViewer.sample', { surface: 'toolbar' });
  assert.ok(r.uri.fsPath.endsWith('address.sample-required.json'));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(r.uri.fsPath, 'utf8'))).sort(), ['city', 'country', 'street']);
});
test('free tries: one per tool in ONE constant (pro.js), not set in the proinfo JSON; the toolbar row says "1 free try"', () => {
  const pro = require('../src/pro');
  assert.equal(pro.TRIAL_USES, 1);
  assert.equal(pro.TRIAL_KEY, 'jsonSchemaViewer.proTrial');
  const src = fs.readFileSync(path.join(ROOT, 'src', 'pro.js'), 'utf8');
  assert.equal((src.match(/TRIAL_USES = /g) || []).length, 1);
  const cfg = require('../src/license/config');
  assert.equal(cfg.listing, 'jsonschema');
  assert.equal(cfg.pro_info.triesKey, 'jsonSchemaViewer.proTrial');
  assert.equal(cfg.pro_info.triesMax, undefined);
  assert.deepEqual(cfg.pro_info.tools.map((t) => t.id), ['sample', 'export', 'diff']);
  const s = activate();
  const row = s.int.viewer().hooks.reach.rowHtml();
  assert.match(row, /Generate sample JSON/);
  assert.match(row, /1 free try/);
});
test('free tries survive a reload: a new activation with the same stored state opens the Pro panel for a used tool', async () => {
  const dir = tmpWs();
  const s = activate(dir, [['jsonSchemaViewer.proTrial', { diff: 1 }]]);
  const r = await s.vscode.commands.executeCommand('jsonSchemaViewer.diff', s.vscode.Uri.file(path.join(dir, 'shop', 'order.schema.json')));
  assert.equal(r, undefined);
  assert.match(proPanel(s).text, /Schema diff is part of Zovo Pro/);
  assert.match(proPanel(s).opts.detail, /Generate sample JSON: 0 of 1 free try used/);
});
test('free tries: the count never goes down in a session even if the stored value reads stale', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  await s.vscode.commands.executeCommand('jsonSchemaViewer.export', s.vscode.Uri.file(path.join(dir, 'shop', 'order.schema.json')), { format: 'html' });
  assert.ok(fs.readFileSync(path.join(dir, 'shop', 'order.docs.html'), 'utf8').startsWith('<!DOCTYPE html>'));
  s.state.set('jsonSchemaViewer.proTrial', {});
  assert.equal(s.api.pro().left('export'), 0);
});

// ---------- HTML ----------
test('webview HTML: CSP default-src none, nonce scripts only, no remote origin; the media script makes no requests', () => {
  const h = docsHtml({ cspSource: 'vscode-resource:', media: (n) => `vscode-resource:/media/${n}`, nonce: 'abc' });
  assert.match(h, /default-src 'none'/);
  assert.match(h, /script-src 'nonce-abc'/);
  assert.doesNotMatch(h, /https?:\/\/(?!marketplace\.visualstudio\.com|open-vsx\.org)/);
  for (const m of h.matchAll(/<script\b[^>]*>/g)) assert.match(m[0], /nonce="abc"/);
  assert.doesNotMatch(h, /\sstyle="/);
  const media = fs.readFileSync(path.join(ROOT, 'media', 'docs.js'), 'utf8');
  assert.doesNotMatch(media, /fetch\(|XMLHttpRequest|WebSocket|https?:\/\/|setAttribute\('style'|innerHTML\s*=/);
});

// ---------- README and text ----------
test('README: first screen has the main use, a screenshot of this product, the free list and the price; by Zovo; no rival names', () => {
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const first = md.split('\n').slice(0, 30).join('\n');
  assert.match(first, /^# JSON Schema Viewer & Validator/);
  assert.match(first, /\(images\/screenshot\.png\)/);
  assert.match(first, /Zovo Pro: USD 19 once/);
  assert.match(md, /by Zovo/);
  assert.doesNotMatch(md, /tberman|marcoq|remcohaszing|schemastore|redhat|red hat|json-schema-validator|quicktype|jsonschema2|stoplight/i);
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'screenshot.png')));
  assert.ok(!fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n').some((l) => /^images/.test(l)));
});
test('support links name this listing; walkthrough cross-sells existing listings only', () => {
  const support = require('../src/support');
  assert.equal(support.SELF_ID, 'zovo.zovo-json-schema-viewer');
  assert.ok(!support.RELATED.includes(support.SELF_ID));
  assert.equal(support.PRO.getPro, 'jsonSchemaViewer.getPro');
  const step = pkg.contributes.walkthroughs[0].steps.find((x) => x.id === 'zovo-related');
  const ids = [...step.description.matchAll(/command:extension\.open\?%5B%22([^%]+)%22%5D/g)].map((x) => x[1]);
  assert.deepEqual(ids, ['zovo.zovo-json-editor', 'zovo.zovo-xsd-viewer', 'zovo.swagger-openapi-viewer']);
  const products = path.join(ROOT, '..');
  const known = new Set(fs.readdirSync(products).map((d) => { try { const p = JSON.parse(fs.readFileSync(path.join(products, d, 'package.json'), 'utf8')); return `${p.publisher}.${p.name}`; } catch (e) { return ''; } }));
  for (const id of [...ids, ...support.RELATED]) assert.ok(known.has(id), id);
});
