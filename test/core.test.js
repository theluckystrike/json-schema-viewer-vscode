'use strict';
// Core tests without VS Code: parsing with line positions (JSON and YAML), the schema set ($ref, $id, anchors, files,
// remote addresses), the docs model, validation with ajv (all drafts, meta-schemas, error lines), sample generation,
// docs export and schema diff. Real third-party schemas from test/fixtures/real (see SOURCES.txt).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { parseText, getAt } = require('../src/core/parse');
const { SchemaSet, effectiveDraft, looksLikeSchema, isMeta } = require('../src/core/schemaset');
const { buildModel, stats } = require('../src/core/model');
const V = require('../src/core/validate');
const S = require('../src/core/sample');
const D = require('../src/core/docs');
const Df = require('../src/core/diff');

const ROOT = path.join(__dirname, '..');
const SHOP = path.join(ROOT, 'samples', 'shop');
const FIX = path.join(__dirname, 'fixtures');
const REAL = path.join(FIX, 'real');
const io = { read: async (u) => { try { return fs.readFileSync(fileURLToPath(u), 'utf8'); } catch (e) { return null; } } };
const load = (file) => new SchemaSet(io).load(pathToFileURL(file).href);
const parseFile = (file) => parseText(fs.readFileSync(file, 'utf8'), path.basename(file));

// ---------- parse ----------
test('parse: JSON with comments and trailing commas; pointer to line and column; keys of members', () => {
  const p = parseText('{\n  // note\n  "a": {\n    "b": [1, { "c": 2 }],\n  },\n}', 'x.json');
  assert.equal(p.error, undefined);
  assert.equal(p.kind, 'json');
  assert.equal(getAt(p.value, '/a/b/1/c'), 2);
  assert.deepEqual(p.locate('/a/b/1/c'), { line: 4, col: 16 });
  assert.deepEqual(p.locateKey('/a/b'), { line: 4, col: 5 });
  assert.equal(p.locate('/nope'), null);
});
test('parse: YAML with line positions, aliases; errors give line and column', () => {
  const p = parseText('a: &x\n  b:\n    - 1\n    - c: 2\nd: *x\n', 'x.yaml');
  assert.equal(p.kind, 'yaml');
  assert.deepEqual(JSON.parse(JSON.stringify(p.value)), { a: { b: [1, { c: 2 }] }, d: { b: [1, { c: 2 }] } });
  assert.deepEqual(p.locate('/a/b/1/c'), { line: 4, col: 7 });
  const bad = parseFile(path.join(FIX, 'broken.yaml'));
  assert.ok(bad.error && bad.error.line >= 1 && bad.error.message.length > 3, JSON.stringify(bad.error));
  const badJ = parseFile(path.join(FIX, 'broken.schema.json'));
  assert.equal(badJ.error.line, 6);
  assert.match(badJ.error.message, /Comma expected at line 6/);
  assert.match(parseText('  \n', 'e.json').error.message, /empty/);
});

// ---------- schema set ----------
test('schema set: local $ref across files through a web $id, $defs, all targets found', async () => {
  const set = await load(path.join(SHOP, 'order.schema.json'));
  assert.equal(set.order.length, 2);
  assert.ok(set.order[1].endsWith('/address.schema.json'));
  assert.equal(set.refs.length, 6);
  for (const r of set.refs) assert.ok(r.target && r.target.ptr !== undefined, r.ref);
  assert.equal(set.refs.find((r) => r.ref === '#/$defs/line').target.ptr, '/$defs/line');
  assert.deepEqual(effectiveDraft(set.rootFile().value), { draft: '2020-12', declared: true });
});
test('schema set: remote $ref are never read, missing local files and bad pointers are reported', async () => {
  const seen = [];
  const spy = { read: async (u) => { seen.push(u); return io.read(u); } };
  const set = await new SchemaSet(spy).load(pathToFileURL(path.join(REAL, 'package.schema.json')).href);
  assert.ok(seen.every((u) => u.startsWith('file:')), 'only local files are read');
  const m = buildModel(set);
  assert.ok(m.info.remote.includes('https://json.schemastore.org/eslintrc.json'), m.info.remote.join(' '));
  assert.equal(m.info.missing.length, 0);
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'jsv-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.schema.json'), JSON.stringify({ properties: { x: { $ref: 'nothere.json' }, y: { $ref: '#/$defs/nope' }, z: { $ref: '#anchor' } } }));
    const s2 = await load(path.join(dir, 'a.schema.json'));
    const m2 = buildModel(s2);
    assert.equal(m2.info.missing.length, 3);
    assert.match(m2.info.missing.map((x) => x.text).join('|'), /nothere\.json.*no such file|nothing at \/\$defs\/nope|no anchor named "anchor"/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('schema set: the 2020-12 meta-schema loads its 7 vocabulary files ("meta/core" finds meta/core.json), $dynamicRef resolves', async () => {
  const set = await load(path.join(REAL, 'meta-2020-12', 'schema.json'));
  assert.equal(set.fileList().length, 8);
  const m = buildModel(set);
  assert.equal(m.info.missing.length, 0);
  assert.equal(m.info.remote.length, 0);
  assert.ok(set.refs.some((r) => r.kw === '$dynamicRef' && r.target.ptr !== undefined));
});
test('schema set: looksLikeSchema and meta addresses', () => {
  assert.ok(isMeta('http://json-schema.org/draft-07/schema#') && isMeta('https://json-schema.org/draft/2020-12/schema') && !isMeta('https://example.com/schema'));
  assert.ok(looksLikeSchema({ type: 'object', properties: { a: { type: 'string' } } }));
  assert.ok(!looksLikeSchema({ name: 'x', version: '1.0.0' }));
  assert.ok(!looksLikeSchema({ properties: { a: 1 } }));
  assert.equal(effectiveDraft({ prefixItems: [] }).draft, '2020-12');
  assert.equal(effectiveDraft({ $defs: {} }).draft, '2019-09');
  assert.equal(effectiveDraft({ $schema: 'http://json-schema.org/draft-04/schema#' }).draft, '04');
});

// ---------- docs model ----------
test('model: properties with required marks, types, rules, $ref keys, line numbers, definitions', async () => {
  const set = await load(path.join(SHOP, 'order.schema.json'));
  const m = buildModel(set);
  const root = m.nodes[m.root];
  assert.deepEqual(root.props.map((p) => [p[0], p[2]]).slice(0, 5), [['id', 1], ['status', 1], ['placedAt', 0], ['customer', 1], ['lines', 1]]);
  const id = m.nodes['0:/properties/id'];
  assert.deepEqual(id.t, ['string']);
  assert.ok(id.c.some(([l, v]) => l === 'pattern' && v === '^ORD-[0-9]{6}$'));
  assert.equal(id.l, 9);
  assert.deepEqual(m.nodes['0:/properties/status'].t, ['string']);
  assert.ok(m.nodes['0:/properties/status'].c.some(([l]) => l === 'enum'));
  assert.equal(m.nodes['0:/properties/shipTo'].ref.k, '1:');
  assert.deepEqual(root.defs.map((d) => d[0]), ['customer', 'line', 'card', 'invoice']);
  assert.equal(m.nodes['0:/properties/notes'].dep, 1);
  assert.deepEqual(stats(m), { props: 27, defs: 4, files: 2 });
});
test('model: real schemas build fast (SchemaStore tsconfig 471 KB, GitHub workflow, OpenAPI 3.0 in YAML)', async () => {
  for (const [f, minProps] of [['tsconfig.schema.json', 150], ['github-workflow.schema.json', 200], ['openapi-3.0.schema.yaml', 200]]) {
    const t = Date.now();
    const set = await load(path.join(REAL, f));
    const m = buildModel(set);
    assert.ok(stats(m).props >= minProps, `${f}: ${stats(m).props}`);
    assert.ok(Date.now() - t < 3000, `${f} took ${Date.now() - t} ms`);
    assert.equal(m.info.missing.length, 0, f);
  }
});

// ---------- validation ----------
async function compile(file) { const set = await load(file); const c = V.compileSet(set); assert.ok(!c.error, c.error); return { set, c }; }
test('validate: the sample data is valid; the YAML with errors gives 11 errors, each with path, line and rule', async () => {
  const { c } = await compile(path.join(SHOP, 'order.schema.json'));
  assert.equal(c.draft, '2020-12');
  assert.deepEqual(V.validateData(c, parseFile(path.join(SHOP, 'order.json')), { dropSchemaKey: true }), { valid: true, errors: [], more: 0 });
  const r = V.validateData(c, parseFile(path.join(SHOP, 'order-with-errors.yaml')), { dropSchemaKey: true });
  assert.equal(r.valid, false);
  assert.equal(r.errors.length, 11);
  const by = (p, k) => r.errors.find((e) => e.path === p && e.keyword === k);
  assert.deepEqual([by('/colour', 'additionalProperties').line, by('/id', 'pattern').line, by('/status', 'enum').line, by('/lines/0/qty', 'minimum').line, by('/lines/1/price', 'exclusiveMinimum').line], [16, 2, 3, 8, 12]);
  assert.match(by('/status', 'enum').message, /allowed values: "cart"/);
  assert.equal(by('/customer', 'required').schemaPath, '#/required');
  // the "$schema" key of the data only names the schema: without dropping it, additionalProperties false rejects it
  const kept = V.validateData(c, parseFile(path.join(SHOP, 'order.json')));
  assert.ok(kept.errors.some((e) => e.path === '/$schema'));
});
test('validate: drafts 04, 07 and 2020-12 with real files (OpenAPI petstore and USPTO YAML, a GitHub workflow, tsconfig, package.json)', async () => {
  const cases = [
    ['openapi-3.0.schema.yaml', '04', ['petstore.yaml', 'uspto.yaml']],
    ['github-workflow.schema.json', '07', ['node.js.yml']],
    ['tsconfig.schema.json', '07', ['vscode-src-tsconfig.json']],
    ['package.schema.json', '07', ['git-extension-package.json']],
  ];
  for (const [schema, draft, data] of cases) {
    const { c } = await compile(path.join(REAL, schema));
    assert.equal(c.draft, draft, schema);
    for (const d of data) { const r = V.validateData(c, parseFile(path.join(REAL, d))); assert.ok(r.valid, `${d}: ${JSON.stringify(r.errors.slice(0, 2))}`); }
  }
  const { c } = await compile(path.join(REAL, 'package.schema.json'));
  assert.ok(c.notChecked.includes('https://json.schemastore.org/eslintrc.json'), 'remote refs are not checked and listed');
  const bad = V.validateData(c, parseText('{ "name": "X Y", "version": 1 }', 'package.json'));
  assert.ok(bad.errors.some((e) => e.path === '/version' && e.keyword === 'type' && e.line === 1));
});
test('validate: a schema against its meta-schema (no download), draft-04 to 2020-12; bad keywords are found with lines', () => {
  for (const f of [path.join(SHOP, 'order.schema.json'), path.join(REAL, 'openapi-3.0.schema.yaml'), path.join(REAL, 'github-workflow.schema.json')]) {
    const r = V.validateAgainstMeta(parseFile(f));
    assert.ok(r.valid && !r.skipped, `${f}: ${JSON.stringify(r.errors.slice(0, 2))}`);
  }
  const r = V.validateAgainstMeta(parseText('{\n  "$schema": "http://json-schema.org/draft-07/schema#",\n  "type": "strin",\n  "properties": { "a": { "minimum": "x" } }\n}', 'b.schema.json'));
  assert.equal(r.draft, '07');
  assert.ok(r.errors.some((e) => e.path === '/type' && e.line === 3));
  assert.ok(r.errors.some((e) => e.path === '/properties/a/minimum' && e.line === 4));
});
test('validate: draft-04 exclusiveMinimum true and draft-06 work; a pattern JavaScript "u" mode refuses still compiles', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'jsv-'));
  try {
    fs.writeFileSync(path.join(dir, 'd4.json'), JSON.stringify({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'number', minimum: 3, exclusiveMinimum: true }));
    let { c } = await compile(path.join(dir, 'd4.json'));
    assert.equal(c.validate(3), false); assert.equal(c.validate(3.5), true);
    fs.writeFileSync(path.join(dir, 'd6.json'), JSON.stringify({ $schema: 'http://json-schema.org/draft-06/schema#', type: 'string', const: 'x' }));
    ({ c } = await compile(path.join(dir, 'd6.json')));
    assert.equal(c.draft, '06'); assert.equal(c.validate('x'), true); assert.equal(c.validate('y'), false);
    fs.writeFileSync(path.join(dir, 'p.json'), JSON.stringify({ type: 'string', pattern: '^[\\w-\\.]+$' }));
    ({ c } = await compile(path.join(dir, 'p.json')));
    assert.equal(c.validate('a-b.c'), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- sample JSON ----------
test('sample: all fields and required only are valid for the sample and for 5 real schemas; test data passes', async () => {
  const files = [path.join(SHOP, 'order.schema.json'), ...['openapi-3.0.schema.yaml', 'github-workflow.schema.json', 'package.schema.json', 'tsconfig.schema.json'].map((f) => path.join(REAL, f)), path.join(REAL, 'meta-2020-12', 'schema.json')];
  for (const f of files) {
    const { set, c } = await compile(f);
    for (const mode of ['all', 'required']) {
      const r = S.generateChecked(set, { mode, count: 1, draft: c.draft, check: c.validate });
      assert.equal(r.valid, 1, `${path.basename(f)} ${mode}`);
    }
    const many = S.generateChecked(set, { mode: 'all', count: 12, draft: c.draft, check: c.validate });
    assert.equal(many.valid, 12, path.basename(f));
    assert.equal(many.docs.length, 12);
  }
});
test('sample: values follow the rules (pattern, enum, format, limits, multipleOf, const); test data varies', async () => {
  const { set, c } = await compile(path.join(SHOP, 'order.schema.json'));
  const d = S.generateChecked(set, { mode: 'all', count: 1, draft: c.draft, check: c.validate }).docs[0];
  assert.equal(d.id, 'ORD-004211', 'examples are used');
  assert.equal(d.status, 'cart', 'default is used');
  assert.match(d.customer.email, /^[a-z]+\d+@example\.com$/);
  assert.match(d.lines[0].sku, /^[A-Z]{3}-[0-9]{4}$/);
  assert.ok(Number.isInteger(d.lines[0].qty) && d.lines[0].qty >= 1 && d.lines[0].qty <= 999);
  assert.ok(!('notes' in d), 'deprecated optional fields are left out');
  const req = S.generateChecked(set, { mode: 'required', count: 1, draft: c.draft, check: c.validate }).docs[0];
  assert.deepEqual(Object.keys(req).sort(), ['customer', 'id', 'lines', 'status']);
  const many = S.generateChecked(set, { mode: 'all', count: 20, draft: c.draft, check: c.validate });
  assert.ok(new Set(many.docs.map((x) => x.id)).size > 10, 'ids differ');
  assert.ok(new Set(many.docs.map((x) => x.status)).size > 2, 'enum values differ');
  for (const p of ['^ORD-[0-9]{6}$', '^(\\([0-9]{3}\\))?[0-9]{3}-[0-9]{4}$', '^[a-z][a-z0-9_]*(?:\\.[a-z0-9_]+)*$', '^#[0-9a-fA-F]{6}$', '^[1-5](?:\\d{2}|XX)$']) {
    const s = S.regexExample(p, S.rng(9));
    assert.ok(s !== null && new RegExp(p, 'u').test(s), `${p} -> ${s}`);
  }
});

// ---------- export docs ----------
test('export: Markdown has a section per object with a property table and links for $ref; HTML is one page with no script', async () => {
  const set = await load(path.join(SHOP, 'order.schema.json'));
  const m = D.createDocModel(set);
  assert.deepEqual(m.sections.map((s) => s.name), ['Order', 'customer', 'line', 'Address', 'Order.gift', 'card', 'invoice', 'line.options']);
  const md = D.toMarkdown(m);
  assert.match(md, /^# Order\n/);
  assert.match(md, /\| `lines` \| array of \[line\]\(#line\) \| yes \| One line per product\. `min items: 1` `max items: 100` \|/);
  assert.match(md, /\| `payment` \| one of: \[card\]\(#card\), \[invoice\]\(#invoice\) \|/);
  assert.match(md, /## Address\n\nA postal address\.\n\nType: object · From `address\.schema\.json`/);
  assert.match(md, /\*\*Deprecated\.\*\* Old free-text field/);
  const html = D.toHtml(m);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.ok(!/<script/i.test(html) && !/https?:\/\/(?!example\.com)/.test(html.replace(/https:\/\/example\.com\/shop\/order\.schema\.json/g, '')));
  assert.match(html, /<a href="#line">line<\/a>/);
  assert.ok(D.mdCell('a|b\nc') === 'a\\|b c');
  assert.equal(D.esc('<b>&"'), '&lt;b&gt;&amp;&quot;');
});
test('export: real schemas give many sections and every link has a target', async () => {
  for (const f of ['openapi-3.0.schema.yaml', 'github-workflow.schema.json', 'tsconfig.schema.json']) {
    const set = await load(path.join(REAL, f));
    const m = D.createDocModel(set);
    assert.ok(m.sections.length > 15, `${f} ${m.sections.length}`);
    const md = D.toMarkdown(m);
    const ids = new Set([...md.matchAll(/<a id="([^"]+)"><\/a>/g)].map((x) => x[1]));
    for (const [, id] of md.matchAll(/\]\(#([^)]+)\)/g)) assert.ok(ids.has(id), `${f}: link #${id}`);
  }
});

// ---------- schema diff ----------
test('diff: older version against the sample: 5 breaking, 6 other, 1 text change', async () => {
  const a = await load(path.join(FIX, 'order-v1.schema.json'));
  const b = await load(path.join(SHOP, 'order.schema.json'));
  const d = Df.diffSets(a, b);
  assert.deepEqual(d.breaking.map((c) => `${c.where}: ${c.what}`), [
    'status: now required',
    'status: enum values removed: "returned"',
    'lines[].sku: pattern ^[A-Z]{3}-[0-9]{4}$ added',
    'lines[].qty: maximum lowered from 9999 to 999',
    'giftWrap: property removed (data that has it is now rejected)',
  ]);
  assert.equal(d.other.length, 6);
  assert.ok(d.other.some((c) => c.where === 'coupon' && /type widened: string to string or null/.test(c.what)));
  assert.deepEqual(d.text.map((c) => `${c.where}: ${c.what}`), ['id: description changed']);
  const md = Df.diffMarkdown(d, 'order-v1.schema.json', 'order.schema.json');
  assert.match(md, /^# Schema diff: order-v1\.schema\.json to order\.schema\.json\n\n5 breaking changes, 6 other changes, 1 text change\./);
  // reversed: what was breaking is now safe, and the other way round
  const r = Df.diffSets(b, a);
  assert.ok(r.breaking.some((c) => c.where === 'lines[].qty') === false && r.other.some((c) => c.where === 'lines[].qty' && /raised/.test(c.what)));
  assert.ok(r.breaking.some((c) => c.where === 'payment' && /property removed/.test(c.what)));
});
test('diff: a schema against itself has no changes (real files); narrowed types and limits are breaking', async () => {
  for (const f of ['openapi-3.0.schema.yaml', 'package.schema.json']) {
    const s = await load(path.join(REAL, f));
    const d = Df.diffSets(s, s);
    assert.deepEqual([d.breaking.length, d.other.length, d.text.length], [0, 0, 0], f);
  }
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'jsv-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ type: 'object', properties: { n: { type: ['number', 'string'], minimum: 0 }, s: { type: 'string', maxLength: 50 } }, additionalProperties: true }));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ type: 'object', properties: { n: { type: 'integer', minimum: 1 }, s: { type: 'string', maxLength: 20 }, t: { type: 'string' } }, required: ['t'], additionalProperties: false }));
    const d = Df.diffSets(await load(path.join(dir, 'a.json')), await load(path.join(dir, 'b.json')));
    const txt = d.breaking.map((c) => `${c.where}: ${c.what}`).join('\n');
    assert.match(txt, /n: type narrowed: number or string to integer/);
    assert.match(txt, /n: minimum raised from 0 to 1/);
    assert.match(txt, /s: max length lowered from 50 to 20/);
    assert.match(txt, /t: new required property/);
    assert.match(txt, /other keys no longer allowed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
