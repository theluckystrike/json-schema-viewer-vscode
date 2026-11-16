'use strict';
// The docs model: one summary per subschema of every file of the set, keyed "<file index>:<pointer>". The webview draws
// the property tree from it and follows $ref by key, so a schema that refers to itself is drawn one level at a time
// (on click) and never loops. Line numbers come from the parsed text.
const { walkSchemas, effectiveDraft, looksLikeSchema } = require('./schemaset');
const { joinPointer } = require('./parse');

const MAX_NODES = 200000;
const MAX_TEXT = 4000;

const short = (v, n = 160) => {
  let s;
  try { s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v); } catch (e) { s = String(v); }
  if (s === undefined) s = String(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const clip = (s, n = MAX_TEXT) => { const t = String(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** The type words of a schema: declared, or read from the keywords used. */
function typesOf(s) {
  if (s === true) return ['any'];
  if (s === false) return ['never'];
  if (!s || typeof s !== 'object') return [];
  if (Array.isArray(s.type)) return s.type.map(String);
  if (typeof s.type === 'string') return [s.type];
  if ('const' in s) return [jsonType(s.const)];
  if (Array.isArray(s.enum) && s.enum.length) return [...new Set(s.enum.map(jsonType))];
  if (s.properties || s.patternProperties || s.additionalProperties !== undefined || s.required) return ['object'];
  if (s.items !== undefined || s.prefixItems) return ['array'];
  return [];
}
function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/** The constraint chips of a schema: [[label, text]]. */
function constraintsOf(s, draft) {
  const c = [];
  if (!s || typeof s !== 'object') return c;
  const add = (l, v) => c.push([l, v]);
  if ('const' in s) add('const', short(s.const));
  if (Array.isArray(s.enum)) add('enum', s.enum.slice(0, 50).map((v) => short(v, 60)).join(', ') + (s.enum.length > 50 ? `, … (${s.enum.length} values)` : ''));
  if ('default' in s) add('default', short(s.default));
  if (typeof s.format === 'string') add('format', s.format);
  if (typeof s.pattern === 'string') add('pattern', s.pattern);
  const ex4 = draft === '04';
  if (typeof s.minimum === 'number') add(ex4 && s.exclusiveMinimum === true ? 'min (exclusive)' : 'min', String(s.minimum));
  if (typeof s.maximum === 'number') add(ex4 && s.exclusiveMaximum === true ? 'max (exclusive)' : 'max', String(s.maximum));
  if (typeof s.exclusiveMinimum === 'number') add('min (exclusive)', String(s.exclusiveMinimum));
  if (typeof s.exclusiveMaximum === 'number') add('max (exclusive)', String(s.exclusiveMaximum));
  if (typeof s.multipleOf === 'number') add('multiple of', String(s.multipleOf));
  if (typeof s.minLength === 'number') add('min length', String(s.minLength));
  if (typeof s.maxLength === 'number') add('max length', String(s.maxLength));
  if (typeof s.minItems === 'number') add('min items', String(s.minItems));
  if (typeof s.maxItems === 'number') add('max items', String(s.maxItems));
  if (s.uniqueItems === true) add('unique items', 'yes');
  if (typeof s.minContains === 'number') add('min contains', String(s.minContains));
  if (typeof s.maxContains === 'number') add('max contains', String(s.maxContains));
  if (typeof s.minProperties === 'number') add('min properties', String(s.minProperties));
  if (typeof s.maxProperties === 'number') add('max properties', String(s.maxProperties));
  if (s.additionalProperties === false) add('additional properties', 'not allowed');
  if (s.unevaluatedProperties === false) add('unevaluated properties', 'not allowed');
  if (s.additionalItems === false || s.items === false) add('extra items', 'not allowed');
  if (s.dependentRequired && typeof s.dependentRequired === 'object') for (const [k, v] of Object.entries(s.dependentRequired)) if (Array.isArray(v)) add('needs', `${k} → ${v.join(', ')}`);
  if (s.dependencies && typeof s.dependencies === 'object') for (const [k, v] of Object.entries(s.dependencies)) if (Array.isArray(v)) add('needs', `${k} → ${v.join(', ')}`);
  if (typeof s.contentMediaType === 'string') add('media type', s.contentMediaType);
  if (typeof s.contentEncoding === 'string') add('encoding', s.contentEncoding);
  if (s.readOnly === true) add('read only', 'yes');
  if (s.writeOnly === true) add('write only', 'yes');
  if (s.nullable === true) add('nullable', 'yes');
  if (Array.isArray(s.examples) && s.examples.length) add('examples', s.examples.slice(0, 5).map((v) => short(v, 80)).join(', '));
  else if ('example' in s) add('example', short(s.example, 80));
  return c;
}

/** Builds { nodes, root, defs, files, info } for the webview from a loaded SchemaSet. */
function buildModel(set) {
  const files = set.fileList();
  const idx = new Map(files.map((f, i) => [f.url, i]));
  const keyOf = (url, ptr) => `${idx.get(url)}:${ptr}`;
  const nodes = {};
  let count = 0, truncated = false;
  const root = set.rootFile();
  const rootDraft = effectiveDraft(root && root.value);
  const remote = new Set(), missing = [];
  for (const f of files) {
    if (f.value === undefined) continue;
    const draft = f === root ? rootDraft.draft : effectiveDraft(f.value).draft;
    const all = walkSchemas(f.value, '');
    for (const { ptr, schema } of all) {
      if (count >= MAX_NODES) { truncated = true; break; }
      count++;
      const k = keyOf(f.url, ptr);
      const loc = f.parsed ? f.parsed.locate(ptr) : null;
      const n = { f: idx.get(f.url), p: ptr, l: loc ? loc.line : 0 };
      if (schema === true || schema === false) { n.b = schema; n.t = typesOf(schema); nodes[k] = n; continue; }
      n.t = typesOf(schema);
      if (typeof schema.title === 'string') n.ti = clip(schema.title, 300);
      if (typeof schema.description === 'string') n.d = clip(schema.description);
      else if (typeof schema.markdownDescription === 'string') n.d = clip(schema.markdownDescription);
      if (typeof schema.$comment === 'string') n.cm = clip(schema.$comment, 1000);
      if (schema.deprecated === true) n.dep = 1;
      const c = constraintsOf(schema, draft);
      if (c.length) n.c = c;
      const sub = (k2, ...more) => keyOf(f.url, joinPointer(ptr, k2, ...more));
      if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
        const req = new Set(Array.isArray(schema.required) ? schema.required : []);
        n.props = Object.keys(schema.properties).map((name) => [name, sub('properties', name), (req.has(name) || (draft === '03' && schema.properties[name] && schema.properties[name].required === true)) ? 1 : 0]);
        // required names with no property schema still show (they must be present, any value)
        for (const r of req) if (!(r in schema.properties)) n.props.push([r, '', 1]);
      } else if (Array.isArray(schema.required) && schema.required.length) n.props = schema.required.map((r) => [String(r), '', 1]);
      if (schema.patternProperties && typeof schema.patternProperties === 'object') n.pp = Object.keys(schema.patternProperties).map((pat) => [pat, sub('patternProperties', pat)]);
      if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) n.ap = sub('additionalProperties');
      if (Array.isArray(schema.prefixItems)) n.pi = schema.prefixItems.map((_, i) => sub('prefixItems', String(i)));
      if (Array.isArray(schema.items)) n.pi = schema.items.map((_, i) => sub('items', String(i)));
      else if (schema.items !== undefined && schema.items !== null && typeof schema.items === 'object') n.it = sub('items');
      if (schema.additionalItems && typeof schema.additionalItems === 'object') n.ai = sub('additionalItems');
      if (schema.contains && typeof schema.contains === 'object') n.ct = sub('contains');
      if (schema.propertyNames && typeof schema.propertyNames === 'object') n.pn = sub('propertyNames');
      for (const [kw, short2] of [['allOf', 'all'], ['anyOf', 'any'], ['oneOf', 'one']]) if (Array.isArray(schema[kw])) n[short2] = schema[kw].map((_, i) => sub(kw, String(i)));
      for (const kw of ['not', 'if', 'then', 'else']) if (schema[kw] !== undefined && schema[kw] !== null && typeof schema[kw] === 'object') n[kw] = sub(kw);
      if (schema.dependentSchemas && typeof schema.dependentSchemas === 'object') n.ds = Object.keys(schema.dependentSchemas).map((name) => [name, sub('dependentSchemas', name)]);
      if (schema.dependencies && typeof schema.dependencies === 'object') {
        const ds = Object.keys(schema.dependencies).filter((name) => !Array.isArray(schema.dependencies[name])).map((name) => [name, sub('dependencies', name)]);
        if (ds.length) n.ds = (n.ds || []).concat(ds);
      }
      const defs = [];
      for (const kw of ['$defs', 'definitions']) if (schema[kw] && typeof schema[kw] === 'object' && !Array.isArray(schema[kw])) for (const name of Object.keys(schema[kw])) defs.push([name, sub(kw, name), kw]);
      if (defs.length) n.defs = defs;
      for (const r of set.refAt(f.url, ptr)) {
        const t = r.target || {};
        if (t.ptr !== undefined && idx.has(t.url)) n.ref = { k: keyOf(t.url, t.ptr), raw: r.ref };
        else if (t.remote) { n.ref = { remote: t.remote, raw: r.ref }; remote.add(t.remote); }
        else { n.ref = { missing: t.missing || 'not found', raw: r.ref }; missing.push({ f: n.f, l: n.l, text: t.missing || r.ref }); }
        if (r.kw !== '$ref') n.ref.kw = r.kw;
        break;
      }
      nodes[k] = n;
    }
  }
  const rv = root && root.value;
  return {
    nodes,
    root: root && root.value !== undefined ? keyOf(root.url, '') : null,
    files: files.map((f) => ({ name: f.name, url: f.url, error: f.error ? f.error.message : '', kind: f.kind })),
    info: {
      draft: rootDraft.draft, declared: rootDraft.declared, schemaUri: rv && typeof rv === 'object' && typeof rv.$schema === 'string' ? rv.$schema : '',
      id: rv && typeof rv === 'object' && typeof rv.$id === 'string' ? rv.$id : '', title: rv && typeof rv === 'object' && typeof rv.title === 'string' ? rv.title : '',
      looksLikeSchema: looksLikeSchema(rv), count, truncated, remote: [...remote], missing,
    },
  };
}

/** Counts for the status line: properties (named, all files) and definitions in the root file. */
function stats(model) {
  let props = 0, defs = 0;
  for (const n of Object.values(model.nodes)) { if (n.props) props += n.props.length; if (n.f === 0 && n.defs) defs += n.defs.length; }
  return { props, defs, files: model.files.length };
}

module.exports = { buildModel, typesOf, constraintsOf, jsonType, stats, short };
