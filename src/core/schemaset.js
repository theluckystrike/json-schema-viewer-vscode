'use strict';
// A JSON Schema and the local files its $ref point to. Files are read through io.read(url) (the extension reads the
// workspace file system; tests read the disk). A $ref is resolved against the nearest $id (draft-04: id) or the file's
// own address; $anchor, plain-name "#name" ids, $defs and definitions all work. Files on this computer are followed
// across folders; a web address (http, https, urn) is never downloaded: it resolves only when a loaded file declares
// that $id, otherwise it stays a remote $ref and the viewer shows its address.
const { parseText, splitPointer, joinPointer, getAt } = require('./parse');

const MAX_FILES = 200;
const META_RE = /^https?:\/\/json-schema\.org\/(draft-0[3-7]\/schema|draft\/20(19-09|20-12)\/schema)#?$/;

// Keywords whose value is one subschema, an array of subschemas, or a map of subschemas (all drafts).
const ONE = ['additionalProperties', 'additionalItems', 'items', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties', 'contentSchema'];
const LIST = ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'];
const MAP = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies'];

/** Every subschema position under a schema value: [{ ptr, schema }], the root first. */
function walkSchemas(value, base = '', out = [], depth = 0) {
  if (depth > 200) return out;
  if (value === true || value === false) { out.push({ ptr: base, schema: value }); return out; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  out.push({ ptr: base, schema: value });
  for (const [sub, v] of directChildren(value)) walkSchemas(v, base + sub, out, depth + 1);
  return out;
}

function stripHash(u) { const i = u.indexOf('#'); return i < 0 ? u : u.slice(0, i); }
function fragOf(u) { const i = u.indexOf('#'); return i < 0 ? '' : u.slice(i + 1); }
/** Resolves a reference against a base address (RFC 3986 through WHATWG URL; non-hierarchical bases handled). */
function resolveUrl(ref, base) {
  const r = String(ref || '');
  if (r.startsWith('#')) return stripHash(base || '') + r;
  try { return new URL(r, base || undefined).href; } catch (e) { /* not hierarchical */ }
  try { return new URL(r).href; } catch (e) { return r; }
}
function normUrl(u) { try { const x = new URL(u); return x.href; } catch (e) { return u; } }
const isLocalUrl = (u) => /^(file|vscode-[a-z-]+|untitled):/i.test(u);
const isMeta = (u) => META_RE.test(String(u || '').trim());

class SchemaSet {
  /** io: { read(url) -> Promise<string|null> } */
  constructor(io) {
    this.io = io;
    this.files = new Map(); // url -> { url, name, idx, text, value, error, kind, parsed }
    this.order = [];
    this.resources = new Map(); // absolute id (no fragment) -> { url, ptr }
    this.anchors = new Map(); // absolute id#name -> { url, ptr }
    this.refs = []; // { url, ptr, ref, base, target }
    this.root = null;
  }

  async load(rootUrl) {
    this.root = normUrl(rootUrl);
    const queue = [this.root];
    while (queue.length && this.files.size < MAX_FILES) {
      const url = queue.shift();
      if (this.files.has(url)) continue;
      const f = await this.readFile(url);
      if (f.error || url !== this.root && f.value === undefined) continue;
      for (const r of this.scan(f)) {
        const doc = stripHash(r.abs);
        if (!doc || this.files.has(doc) || this.resources.has(doc)) continue;
        if (isLocalUrl(doc)) queue.push(doc);
      }
    }
    // Refs whose relative address resolved against a web $id: fall back to the file next to the referring file.
    for (const r of this.refs) r.target = this.resolve(r.url, r.ptr, r.ref, r.base);
    for (let round = 0; round < 3; round++) {
      const more = [];
      for (const r of this.refs) {
        if (r.target.ptr !== undefined || !r.target.fallback || r.tried) continue;
        r.tried = true;
        const doc = stripHash(r.target.fallback);
        if (!this.files.has(doc) && isLocalUrl(doc) && this.files.size + more.length < MAX_FILES && !more.includes(doc)) more.push(doc);
      }
      if (!more.length) break;
      for (const u of more) { const f = await this.readFile(u, { fallback: true }); if (!f.error) this.scan(f); }
      for (const r of this.refs) r.target = this.resolve(r.url, r.ptr, r.ref, r.base);
    }
    return this;
  }

  async readFile(url0, { fallback } = {}) {
    let text = null, url = url0;
    try { text = await this.io.read(url); } catch (e) { text = null; }
    // "$ref": "meta/core" often names meta/core.json on disk
    if ((text === null || text === undefined) && !/\.(json|ya?ml)$/i.test(url.split('#')[0])) {
      for (const ext of ['.json', '.yaml', '.yml']) {
        let t = null;
        try { t = await this.io.read(url + ext); } catch (e) { t = null; }
        if (t !== null && t !== undefined) { text = t; url = url + ext; break; }
      }
    }
    if ((text === null || text === undefined) && fallback) return { url, error: { message: 'not found', missing: true } };
    const name = decodeURIComponent(url.split('/').pop() || url);
    const f = { url, name, idx: this.order.length, text, value: undefined, error: null, kind: 'json', parsed: null };
    if (text === null || text === undefined) f.error = { message: `${name} could not be read.`, line: 0, col: 0, missing: true };
    else {
      const p = parseText(text, name);
      f.kind = p.kind;
      if (p.error) f.error = p.error; else { f.value = p.value; f.parsed = p; }
    }
    this.files.set(url, f);
    if (url !== url0) this.files.set(url0, f);
    this.order.push(url);
    return f;
  }

  /** Records ids, anchors and $refs of a file; returns its refs with absolute addresses. */
  scan(f) {
    const found = [];
    if (f.value === undefined) return found;
    const draft4 = /draft-0[34]/.test(String((f.value && f.value.$schema) || ''));
    // walk with the base address of each position
    const visit = (value, ptr, base, depth) => {
      if (depth > 200 || !value || typeof value !== 'object' || Array.isArray(value)) return;
      let b = base;
      const idv = typeof value.$id === 'string' ? value.$id : (draft4 && typeof value.id === 'string' ? value.id : null);
      if (idv !== null) {
        if (idv.startsWith('#') && !idv.startsWith('#/')) this.anchors.set(stripHash(b) + idv, { url: f.url, ptr });
        else {
          b = resolveUrl(idv, b);
          const doc = stripHash(b);
          if (!this.resources.has(doc)) this.resources.set(doc, { url: f.url, ptr });
          if (fragOf(b) && !fragOf(b).startsWith('/')) this.anchors.set(b, { url: f.url, ptr });
        }
      }
      if (typeof value.$anchor === 'string') this.anchors.set(stripHash(b) + '#' + value.$anchor, { url: f.url, ptr });
      if (typeof value.$dynamicAnchor === 'string') this.anchors.set(stripHash(b) + '#' + value.$dynamicAnchor, { url: f.url, ptr });
      for (const kw of ['$ref', '$dynamicRef', '$recursiveRef']) {
        if (typeof value[kw] === 'string') {
          const abs = kw === '$recursiveRef' ? stripHash(b) : resolveUrl(value[kw], b);
          const r = { url: f.url, ptr, ref: value[kw], base: b, abs, kw, target: null };
          this.refs.push(r);
          found.push(r);
        }
      }
      for (const [sub, schema] of directChildren(value)) visit(schema, ptr + sub, b, depth + 1);
    };
    if (!this.resources.has(f.url)) this.resources.set(f.url, { url: f.url, ptr: '' });
    visit(f.value, '', f.url, 0);
    return found;
  }

  /** Target of a $ref: { url, ptr } (local), { remote: address } or { missing: reason }. */
  resolve(url, ptr, ref, base) {
    const abs = resolveUrl(ref, base);
    const doc = stripHash(abs);
    const frag = fragOf(abs);
    let res = this.resources.get(doc) || (this.files.has(doc) && !this.files.get(doc).error ? { url: this.files.get(doc).url, ptr: '' } : null);
    if (!res) {
      // A relative $ref inside a schema with a web $id: try the file next to the referring file.
      if (!/^[a-z][a-z0-9+.-]*:/i.test(ref) && !ref.startsWith('#') && stripHash(base) !== url) {
        const near = resolveUrl(ref, url);
        const nd = stripHash(near);
        if (this.files.has(nd) && !this.files.get(nd).error) return this.fragTarget({ url: this.files.get(nd).url, ptr: '' }, fragOf(near), nd, ref);
        // not on this computer either: it stays the web address of the $id it was resolved against
        return isLocalUrl(abs) ? { missing: `${ref}: no such file`, fallback: near } : (isLocalUrl(nd) ? { remote: abs, fallback: near } : { remote: abs });
      }
      if (isLocalUrl(doc)) {
        const f = this.files.get(doc);
        return { missing: f && f.error ? `${decodeURIComponent(doc.split('/').pop())}: ${f.error.message}` : `${ref}: no such file` };
      }
      return { remote: abs };
    }
    return this.fragTarget(res, frag, doc, ref);
  }

  fragTarget(res, frag, doc, ref) {
    if (!frag) return { url: res.url, ptr: res.ptr };
    if (frag.startsWith('/')) {
      let p;
      try { p = decodeURIComponent(frag); } catch (e) { p = frag; }
      const ptr = res.ptr + p;
      const f = this.files.get(res.url);
      if (!f || getAt(f.value, ptr) === undefined) return { missing: `${ref}: nothing at ${p}` };
      return { url: res.url, ptr };
    }
    const a = this.anchors.get(doc + '#' + frag);
    if (a) return a;
    return { missing: `${ref}: no anchor named "${frag}"` };
  }

  /** The schema value at a location. */
  at(url, ptr) { const f = this.files.get(url); return f ? getAt(f.value, ptr) : undefined; }
  rootFile() { return this.files.get(this.root); }
  refAt(url, ptr) { return this.refs.filter((r) => r.url === url && r.ptr === ptr); }
  fileList() { return this.order.map((u) => this.files.get(u)); }
}

/** The direct subschemas of a schema object: [[relative pointer, value]]. */
function directChildren(value) {
  const out = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const k of ONE) if (k in value && value[k] !== null && (typeof value[k] === 'object' || typeof value[k] === 'boolean') && !Array.isArray(value[k])) out.push([joinPointer('', k), value[k]]);
  for (const k of LIST) if (Array.isArray(value[k])) value[k].forEach((s, i) => out.push([joinPointer('', k, String(i)), s]));
  for (const k of MAP) {
    const m = value[k];
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    for (const name of Object.keys(m)) if (!(k === 'dependencies' && Array.isArray(m[name]))) out.push([joinPointer('', k, name), m[name]]);
  }
  return out;
}

/** Which draft a schema says it is: '04', '06', '07', '2019-09', '2020-12', or '' (then guessed). */
function draftOf(value) {
  const s = value && typeof value === 'object' ? String(value.$schema || '') : '';
  if (/draft-0[34]\b/.test(s)) return '04';
  if (/draft-06\b/.test(s)) return '06';
  if (/draft-07\b/.test(s)) return '07';
  if (/2019-09/.test(s)) return '2019-09';
  if (/2020-12/.test(s)) return '2020-12';
  return '';
}
/** The draft to use: declared, else a guess from the keywords in the schema. */
function effectiveDraft(value) {
  const d = draftOf(value);
  if (d) return { draft: d, declared: true };
  const txt = (() => { try { return JSON.stringify(value) || ''; } catch (e) { return ''; } })();
  if (/"(prefixItems|\$dynamicRef|\$dynamicAnchor)"\s*:/.test(txt)) return { draft: '2020-12', declared: false };
  if (/"(\$defs|dependentRequired|dependentSchemas|unevaluatedProperties|unevaluatedItems|\$anchor|\$recursiveRef)"\s*:/.test(txt)) return { draft: '2019-09', declared: false };
  if (/"id"\s*:\s*"[^"]*"/.test(txt) && !/"\$id"/.test(txt) && /"exclusiveM(in|ax)imum"\s*:\s*(true|false)/.test(txt)) return { draft: '04', declared: false };
  return { draft: '07', declared: false };
}

/** True when a value looks like a JSON Schema (meta-schema $schema, or schema keywords at the top). */
function looksLikeSchema(value) {
  if (value === true || value === false) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (isMeta(value.$schema)) return true;
  const kw = ['type', 'properties', '$defs', 'definitions', 'items', 'allOf', 'anyOf', 'oneOf', '$ref', 'enum', 'required', 'additionalProperties', 'patternProperties'];
  const n = kw.filter((k) => k in value).length;
  if (n === 0) return false;
  if (value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)) {
    const vals = Object.values(value.properties);
    return vals.length === 0 || vals.every((v) => typeof v === 'boolean' || (v && typeof v === 'object' && !Array.isArray(v)));
  }
  return n >= 2 || typeof value.type === 'string' || Array.isArray(value.type);
}

module.exports = { SchemaSet, walkSchemas, directChildren, resolveUrl, stripHash, fragOf, normUrl, isLocalUrl, isMeta, draftOf, effectiveDraft, looksLikeSchema, META_RE, ONE, LIST, MAP };
