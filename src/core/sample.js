'use strict';
// Zovo Pro "Generate sample JSON": a document that fits the schema (all fields, or required fields only) and sets of
// test data (many documents, different values each). Values keep const, enum, default and examples, formats (email,
// date, date-time, uri, uuid, ipv4, ...), patterns (a small generator for ECMAScript regular expressions, checked
// against the pattern), lengths, number limits and multipleOf. $ref are followed, also across files; a schema that
// refers to itself stops after a few levels. The tool checks the result with ajv and reports how many documents pass.

/** A small seeded random generator (mulberry32), so the same seed gives the same data. */
function rng(seed) {
  let a = (seed >>> 0) || 1;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: (arr) => arr[Math.floor(next() * arr.length)] };
}

// ---------- regular expression examples ----------
function parseRe(src) {
  let i = 0;
  const peek = () => src[i];
  const eat = () => src[i++];
  function alt() { const alts = [seq()]; while (peek() === '|') { eat(); alts.push(seq()); } return { t: 'alt', alts }; }
  function seq() { const items = []; while (i < src.length && peek() !== '|' && peek() !== ')') items.push(quant(atom())); return { t: 'seq', items }; }
  function quant(a) {
    const c = peek();
    let q = null;
    if (c === '?') { eat(); q = { min: 0, max: 1 }; }
    else if (c === '*') { eat(); q = { min: 0, max: -1 }; }
    else if (c === '+') { eat(); q = { min: 1, max: -1 }; }
    else if (c === '{') { const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i)); if (m) { i += m[0].length; q = { min: +m[1], max: m[2] ? (m[3] === '' ? -1 : +m[3]) : +m[1] }; } }
    if (!q) return a;
    if (peek() === '?' || peek() === '+') eat();
    return { t: 'rep', a, ...q };
  }
  function esc(inClass) {
    const c = eat();
    const sets = { d: '0123456789', w: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_', s: ' ' };
    if (sets[c]) return { t: 'set', chars: sets[c] };
    if (c === 'D' || c === 'W') return { t: 'set', chars: c === 'D' ? 'abc' : '-.' };
    if (c === 'S') return { t: 'set', chars: 'abc' };
    if (c === 'b' || c === 'B') return inClass ? { t: 'lit', ch: '\b' } : { t: 'seq', items: [] };
    if (c === 'n') return { t: 'lit', ch: '\n' };
    if (c === 't') return { t: 'lit', ch: '\t' };
    if (c === 'r') return { t: 'lit', ch: '\r' };
    if (c === 'u' && /^[0-9a-fA-F]{4}/.test(src.slice(i))) { const h = src.slice(i, i + 4); i += 4; return { t: 'lit', ch: String.fromCharCode(parseInt(h, 16)) }; }
    if (c === 'x' && /^[0-9a-fA-F]{2}/.test(src.slice(i))) { const h = src.slice(i, i + 2); i += 2; return { t: 'lit', ch: String.fromCharCode(parseInt(h, 16)) }; }
    if (c === 'p' || c === 'P') { const m = /^\{[^}]*\}/.exec(src.slice(i)); if (m) i += m[0].length; return { t: 'set', chars: 'abc' }; }
    return { t: 'lit', ch: c === undefined ? '' : c };
  }
  function cls() {
    let neg = false;
    if (peek() === '^') { eat(); neg = true; }
    const chars = [];
    let first = true;
    while (i < src.length && (peek() !== ']' || first)) {
      first = false;
      let a = eat();
      if (a === '\\') { const e = esc(true); if (e.t === 'set') { chars.push(...e.chars); continue; } a = e.ch; }
      if (peek() === '-' && src[i + 1] && src[i + 1] !== ']') {
        eat();
        let b = eat();
        if (b === '\\') { const e = esc(true); b = e.t === 'lit' ? e.ch : 'z'; }
        const lo = a.charCodeAt(0), hi = b.charCodeAt(0);
        for (let x = lo; x <= hi && x - lo < 200; x++) chars.push(String.fromCharCode(x));
      } else chars.push(a);
    }
    if (peek() === ']') eat();
    if (neg) {
      const pool = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.';
      return { t: 'set', chars: [...pool].filter((ch) => !chars.includes(ch)).join('') || 'x' };
    }
    return { t: 'set', chars: chars.join('') || 'x' };
  }
  function atom() {
    const c = eat();
    if (c === '(') {
      if (peek() === '?') {
        eat();
        const k = eat();
        if (k === '<' && peek() !== '=' && peek() !== '!') { while (i < src.length && peek() !== '>') eat(); eat(); }
        else if (k === '=' || k === '!' || (k === '<' && (eat(), true))) { alt(); if (peek() === ')') eat(); return { t: 'seq', items: [] }; }
      }
      const b = alt(); if (peek() === ')') eat(); return b;
    }
    if (c === '[') return cls();
    if (c === '.') return { t: 'set', chars: 'abcxyz' };
    if (c === '^') return { t: 'start' };
    if (c === '$') return { t: 'end' };
    if (c === '\\') return esc(false);
    return { t: 'lit', ch: c };
  }
  const tree = alt();
  return tree;
}
function genRe(node, r, out) {
  switch (node.t) {
    case 'alt': genRe(r.pick(node.alts), r, out); break;
    case 'seq': for (const it of node.items) genRe(it, r, out); break;
    case 'rep': { const max = node.max < 0 ? node.min + 3 : Math.min(node.max, node.min + 3); const n = r.int(node.min, Math.max(node.min, max)); for (let k = 0; k < n; k++) genRe(node.a, r, out); break; }
    case 'set': out.push(node.chars[Math.floor(r.next() * node.chars.length)] || ''); break;
    case 'lit': out.push(node.ch); break;
    default: break;
  }
  return out;
}
/** A string that matches the pattern (anywhere, as JSON Schema says), or null when none was found. */
function regexExample(pattern, r, { minLength = 0, maxLength = Infinity } = {}) {
  let re;
  try { re = new RegExp(pattern, 'u'); } catch (e) { try { re = new RegExp(pattern); } catch (e2) { return null; } }
  let tree;
  try { tree = parseRe(pattern); } catch (e) { return null; }
  for (let k = 0; k < 40; k++) {
    let s;
    try { s = genRe(tree, r, []).join(''); } catch (e) { return null; }
    if (re.test(s) && s.length >= minLength && s.length <= maxLength) return s;
  }
  return null;
}

// ---------- values ----------
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
const NAMES = ['Ada', 'Bo', 'Chen', 'Dara', 'Eli', 'Femi', 'Gus', 'Hana', 'Ivo', 'Jun'];
function formatValue(fmt, r, i) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const day = r.int(1, 28), mon = r.int(1, 12), h = r.int(0, 23), mi = r.int(0, 59), se = r.int(0, 59);
  const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[r.int(0, 15)]).join('');
  switch (fmt) {
    case 'email': case 'idn-email': return `${r.pick(NAMES).toLowerCase()}${i}@example.com`;
    case 'date': return `2026-${pad(mon)}-${pad(day)}`;
    case 'date-time': return `2026-${pad(mon)}-${pad(day)}T${pad(h)}:${pad(mi)}:${pad(se)}Z`;
    case 'time': return `${pad(h)}:${pad(mi)}:${pad(se)}Z`;
    case 'duration': return `P${r.int(1, 30)}D`;
    case 'uri': case 'iri': case 'url': return `https://example.com/${r.pick(WORDS)}/${i}`;
    case 'uri-reference': case 'iri-reference': return `/${r.pick(WORDS)}/${i}`;
    case 'uri-template': return `https://example.com/{${r.pick(WORDS)}}`;
    case 'uuid': return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
    case 'ipv4': return `192.0.2.${r.int(1, 254)}`;
    case 'ipv6': return `2001:db8::${r.int(1, 9999)}`;
    case 'hostname': case 'idn-hostname': return `${r.pick(WORDS)}${i}.example.com`;
    case 'json-pointer': return `/${r.pick(WORDS)}/0`;
    case 'relative-json-pointer': return '0/' + r.pick(WORDS);
    case 'regex': return '^[a-z]+$';
    case 'byte': return Buffer.from(`${r.pick(WORDS)} ${i}`).toString('base64');
    case 'int32': case 'int64': return String(r.int(1, 1000));
    case 'password': return `pw-${hex(10)}`;
    default: return null;
  }
}

function fitLength(s, min, max, r) {
  let t = String(s);
  while (t.length < min) t += r.pick(WORDS).slice(0, Math.max(1, min - t.length));
  if (t.length > max) t = t.slice(0, max);
  return t;
}

function numberIn(s, integer, r, draft) {
  let lo = -Infinity, hi = Infinity, loEx = false, hiEx = false;
  if (typeof s.minimum === 'number') { lo = s.minimum; loEx = draft === '04' && s.exclusiveMinimum === true; }
  if (typeof s.maximum === 'number') { hi = s.maximum; hiEx = draft === '04' && s.exclusiveMaximum === true; }
  if (typeof s.exclusiveMinimum === 'number' && s.exclusiveMinimum >= lo) { lo = s.exclusiveMinimum; loEx = true; }
  if (typeof s.exclusiveMaximum === 'number' && s.exclusiveMaximum <= hi) { hi = s.exclusiveMaximum; hiEx = true; }
  const step = typeof s.multipleOf === 'number' && s.multipleOf > 0 ? s.multipleOf : (integer ? 1 : 0);
  if (lo === -Infinity && hi === Infinity) { lo = integer ? 1 : 0; hi = integer ? 100 : 100; }
  else if (lo === -Infinity) lo = hi - 100;
  else if (hi === Infinity) hi = lo + 100;
  const ok = (v) => (loEx ? v > lo : v >= lo) && (hiEx ? v < hi : v <= hi) && (!integer || Number.isInteger(v));
  if (step) {
    const first = Math.ceil(lo / step), last = Math.floor(hi / step);
    for (let k = 0; k < 6 && first <= last; k++) {
      const n = r.int(first, last);
      const v = Number((n * step).toFixed(10));
      if (ok(v)) return v;
    }
    for (let n = first; n <= last && n < first + 5; n++) { const v = Number((n * step).toFixed(10)); if (ok(v)) return v; }
    return Number((first * step).toFixed(10));
  }
  for (let k = 0; k < 6; k++) {
    const v = integer ? r.int(Math.ceil(lo), Math.floor(hi)) : Math.round((lo + r.next() * (hi - lo)) * 100) / 100;
    if (ok(v)) return v;
  }
  return integer ? Math.ceil(lo + (loEx ? 1 : 0)) : lo + (hi - lo) / 2;
}

/**
 * Builds sample values. set: SchemaSet, resolve(url, ptr, ref) through set.refs.
 * opts: { mode: 'all' | 'required', seed, variety (bulk: vary choices), maxDepth, draft }
 */
function createGenerator(set, opts = {}) {
  const mode = opts.mode === 'required' ? 'required' : 'all';
  const maxDepth = opts.maxDepth || 6;
  // past this many values, objects get their required members only (keeps samples of big recursive schemas small)
  const budget = opts.budget || 400;
  const draft = opts.draft || '2020-12';
  // variety: 0 = first choices and defaults, 1 = varied values but first branches and types, 2 = everything varied
  let variety = opts.variety === true ? 2 : Number(opts.variety) || 0;
  let r = rng(opts.seed || 1);
  let counter = 1;

  const refTarget = (url, ptr) => {
    const ref = set.refs.find((x) => x.url === url && x.ptr === ptr && x.kw === '$ref') || set.refs.find((x) => x.url === url && x.ptr === ptr);
    return ref && ref.target && ref.target.ptr !== undefined ? ref.target : null;
  };
  const at = (url, ptr) => set.at(url, ptr);
  const join = (ptr, ...segs) => ptr + segs.map((s) => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('');

  /** Merges a schema with its $ref target and allOf parts into one view (shallow), for generation. */
  function flatten(url, ptr, seen = new Set(), depth = 0) {
    const s = at(url, ptr);
    if (s === true || s === undefined) return { s: {}, url, ptr, parts: [], props: {}, propLoc: {}, required: [], nots: [] };
    if (s === false) return { s: { not: {} }, url, ptr, parts: [], never: true, props: {}, propLoc: {}, required: [], nots: [] };
    const key = url + '#' + ptr;
    if (seen.has(key) || depth > 20) return { s: {}, url, ptr, parts: [], props: {}, propLoc: {}, required: [], nots: [] };
    seen.add(key);
    let parts = [{ s, url, ptr }];
    const t = refTarget(url, ptr);
    if (t) parts.push(flatten(t.url, t.ptr, seen, depth + 1));
    if (Array.isArray(s.allOf)) s.allOf.forEach((_, i) => parts.push(flatten(url, join(ptr, 'allOf', i), seen, depth + 1)));
    // the merged keyword view: later parts do not override earlier constraints
    const m = {};
    const props = {}, propLoc = {};
    const required = new Set();
    const nots = [];
    for (const p of parts) {
      const ps = p.s;
      if (!ps || typeof ps !== 'object') continue;
      if (p.nots) nots.push(...p.nots);
      else if (ps.not && typeof ps.not === 'object') nots.push(ps.not);
      if (p.props) {
        // an already flattened part ($ref target or allOf item)
        for (const name of Object.keys(p.props)) if (!(name in props)) { props[name] = p.props[name]; propLoc[name] = p.propLoc[name]; }
        (p.required || []).forEach((x) => required.add(x));
      }
      for (const [k, v] of Object.entries(ps)) {
        if (k === 'properties' && v && typeof v === 'object') { for (const name of Object.keys(v)) if (!(name in props)) { props[name] = v[name]; propLoc[name] = { url: p.url, ptr: join(p.ptr, 'properties', name) }; } continue; }
        if (k === 'required' && Array.isArray(v)) { v.forEach((x) => required.add(x)); continue; }
        if (k === 'allOf' || k === '$ref') continue;
        if (!(k in m)) m[k] = v;
      }
      for (const kw of ['items', 'additionalProperties', 'patternProperties', 'prefixItems', 'oneOf', 'anyOf', 'if', 'then', 'else', 'contains']) if (ps[kw] !== undefined && !m['@' + kw]) m['@' + kw] = { url: p.url, ptr: join(p.ptr, kw) };
    }
    return { s: m, props, propLoc, required: [...required], nots, url, ptr, parts: [] };
  }

  function stringValue(s, name, i) {
    const minL = typeof s.minLength === 'number' ? s.minLength : 0;
    const maxL = typeof s.maxLength === 'number' ? s.maxLength : Infinity;
    if (typeof s.pattern === 'string') {
      const ex = regexExample(s.pattern, r, { minLength: minL, maxLength: maxL });
      if (ex !== null) return ex;
    }
    const f = typeof s.format === 'string' ? formatValue(s.format, r, i) : null;
    if (f !== null) return f;
    const base = /name/i.test(name || '') ? `${r.pick(NAMES)} ${r.pick(['Lee', 'Kim', 'Diaz', 'Okafor', 'Novak'])}` : /(id|code|key)$/i.test(name || '') ? `${(name || 'id').toLowerCase()}-${i}` : `${r.pick(WORDS)} ${i}`;
    return fitLength(base, minL, maxL === Infinity ? Math.max(minL, base.length) : maxL, r);
  }

  function gen(url, ptr, name, depth, stack) {
    const raw = at(url, ptr);
    if (raw === false) return undefined;
    const fl = flatten(url, ptr);
    const s = fl.s;
    const key = url + '#' + ptr;
    const loops = stack.filter((k) => k === key).length;
    if ('const' in s) return s.const;
    if (Array.isArray(s.enum) && s.enum.length) return variety ? r.pick(s.enum) : s.enum[0];
    if (!variety && 'default' in s && s.default !== undefined) return s.default;
    if (!variety && Array.isArray(s.examples) && s.examples.length) return s.examples[0];
    const branches = s['@oneOf'] || s['@anyOf'];
    if (branches) {
      const list = at(branches.url, branches.ptr);
      if (Array.isArray(list) && list.length) {
        const order = list.map((_, i) => i).filter((i) => { const b = at(branches.url, join(branches.ptr, i)); return !(b && b.type === 'null'); });
        const pickI = order.length ? (variety >= 2 ? r.pick(order) : order[0]) : 0;
        const v = gen(branches.url, join(branches.ptr, pickI), name, depth, stack.concat(key));
        if (v !== undefined && !Object.keys(fl.props || {}).length && !s.type) return v;
        if (v && typeof v === 'object' && !Array.isArray(v)) return Object.assign(objectValue(fl, depth, stack.concat(key), loops), v);
        if (v !== undefined) return v;
      }
    }
    let types = Array.isArray(s.type) ? s.type : (typeof s.type === 'string' ? [s.type] : []);
    if (!types.length) {
      if (Object.keys(fl.props || {}).length || s.additionalProperties !== undefined || s.patternProperties || s.required) types = ['object'];
      else if (s['@items'] || s['@prefixItems']) types = ['array'];
      else if (s.pattern || s.format || s.minLength !== undefined) types = ['string'];
      else if (s.minimum !== undefined || s.maximum !== undefined || s.multipleOf !== undefined) types = ['number'];
      else types = ['string'];
    }
    const nonNull = types.filter((t) => t !== 'null');
    const t = nonNull.length ? (variety >= 2 ? r.pick(nonNull) : nonNull[0]) : 'null';
    const i = counter++;
    switch (t) {
      case 'object': return objectValue(fl, depth, stack.concat(key), loops);
      case 'array': return arrayValue(fl, name, depth, stack.concat(key), loops);
      case 'string': return stringValue(s, name, i);
      case 'integer': return numberIn(s, true, r, draft);
      case 'number': return numberIn(s, false, r, draft);
      case 'boolean': return variety ? r.next() < 0.5 : true;
      default: return null;
    }
  }

  function objectValue(fl, depth, stack, loops) {
    const out = {};
    if (depth >= maxDepth || loops >= 2 || counter > budget) {
      return minimalObject(fl, 0);
    }
    const req = new Set(fl.required || []);
    for (const name of Object.keys(fl.props || {})) {
      if (mode === 'required' && !req.has(name)) continue;
      const loc = fl.propLoc[name];
      const ps = at(loc.url, loc.ptr);
      if (ps === false) continue;
      if (!req.has(name) && ps && typeof ps === 'object' && ps.deprecated === true) continue;
      const v = gen(loc.url, loc.ptr, name, depth + 1, stack);
      if (v !== undefined) out[name] = v;
    }
    for (const name of req) if (!(name in out)) out[name] = `${name} ${counter++}`;
    // "not both" rules (not: { required: [a, b] }): leave out an optional one
    for (const n of fl.nots || []) {
      if (!n || !Array.isArray(n.required) || !n.required.length) continue;
      if (n.required.every((k) => k in out)) { const drop = n.required.slice().reverse().find((k) => !req.has(k)); if (drop) delete out[drop]; }
    }
    const pp = fl.s['@patternProperties'];
    if (pp && (mode === 'all' || (typeof fl.s.minProperties === 'number' && fl.s.minProperties > Object.keys(out).length))) {
      const map = at(pp.url, pp.ptr) || {};
      for (const pat of Object.keys(map).slice(0, 3)) {
        if (Object.keys(out).length && mode === 'required') break;
        const key = regexExample(pat, r, { minLength: 1 }) || null;
        if (!key || key in out) continue;
        const v = gen(pp.url, join(pp.ptr, pat), key, depth + 1, stack);
        if (v !== undefined) out[key] = v;
        if (mode === 'all') break;
      }
    }
    const ap = fl.s['@additionalProperties'];
    if (mode === 'all' && !Object.keys(out).length && ap) {
      const aps = at(ap.url, ap.ptr);
      if (aps && aps !== true && typeof aps === 'object') { const v = gen(ap.url, ap.ptr, 'key', depth + 1, stack); if (v !== undefined) out.key1 = v; }
    }
    const minP = typeof fl.s.minProperties === 'number' ? fl.s.minProperties : 0;
    for (let k = Object.keys(out).length; k < minP && fl.s.additionalProperties !== false; k++) {
      if (ap) { const v = gen(ap.url, ap.ptr, 'key', depth + 1, stack); out[`key${k + 1}`] = v === undefined ? `value ${k + 1}` : v; } else out[`key${k + 1}`] = `value ${k + 1}`;
    }
    return out;
  }
  /** Required members and enough members for minProperties, with minimal values (for deep or large documents). */
  function minimalObject(fl, d) {
    const out = {};
    for (const name of fl.required || []) if (fl.propLoc && fl.propLoc[name]) { const v = shallow(fl.propLoc[name], d + 1); if (v !== undefined) out[name] = v; }
    const minP = typeof fl.s.minProperties === 'number' ? fl.s.minProperties : 0;
    const pp = fl.s['@patternProperties'], ap = fl.s['@additionalProperties'];
    for (let k = Object.keys(out).length; k < minP; k++) {
      const pat = pp ? Object.keys(at(pp.url, pp.ptr) || {})[0] : undefined;
      const key = pat !== undefined ? regexExample(pat, r, { minLength: 1 }) : `key${k + 1}`;
      if (!key || key in out) break;
      out[key] = pat !== undefined ? shallow({ url: pp.url, ptr: join(pp.ptr, pat) }, d + 1) : (ap && at(ap.url, ap.ptr) && typeof at(ap.url, ap.ptr) === 'object' ? shallow(ap, d + 1) : `value ${k + 1}`);
    }
    return out;
  }
  function shallow(loc, d = 0) {
    const fl = flatten(loc.url, loc.ptr);
    const s = fl.s;
    if ('const' in s) return s.const;
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
    if ('default' in s) return s.default;
    const br = s['@oneOf'] || s['@anyOf'];
    if (br && Array.isArray(at(br.url, br.ptr)) && d < 6) return shallow({ url: br.url, ptr: join(br.ptr, 0) }, d + 1);
    let t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
    if (!t && (Object.keys(fl.props || {}).length || fl.required.length || s.minProperties)) t = 'object';
    if (t === 'array') { const it = s['@items']; const n = typeof s.minItems === 'number' ? Math.min(s.minItems, 20) : 0; const a = []; for (let k = 0; k < n; k++) a.push(it && d < 6 ? shallow(it, d + 1) : `item ${k + 1}`); return a; }
    if (t === 'object') return d < 6 ? minimalObject(fl, d) : {};
    if (t === 'integer' || t === 'number') return numberIn(s, t === 'integer', r, draft);
    if (t === 'boolean') return false;
    if (t === 'null') return null;
    return stringValue(s, '', counter++);
  }

  function arrayValue(fl, name, depth, stack, loops) {
    const s = fl.s;
    const out = [];
    const tuple = s['@prefixItems'] || (s['@items'] && Array.isArray(at(s['@items'].url, s['@items'].ptr)) ? s['@items'] : null);
    const minI = typeof s.minItems === 'number' ? s.minItems : 0;
    const maxI = typeof s.maxItems === 'number' ? s.maxItems : Infinity;
    if (depth >= maxDepth || loops >= 2) {
      if (!minI) return out;
    }
    if (tuple) {
      const list = at(tuple.url, tuple.ptr);
      const n = mode === 'required' ? Math.min(list.length, Math.max(minI, 0)) : list.length;
      for (let k = 0; k < n && k < maxI; k++) out.push(gen(tuple.url, join(tuple.ptr, k), name, depth + 1, stack));
      const extra = s['@items'] && s['@prefixItems'] ? s['@items'] : null;
      while (out.length < minI && extra) out.push(gen(extra.url, extra.ptr, name, depth + 1, stack));
      return out;
    }
    const it = s['@items'];
    let n = mode === 'required' || counter > budget ? minI : Math.max(minI, variety ? r.int(1, 3) : 1);
    n = Math.min(n, maxI, 50);
    if (it && at(it.url, it.ptr) !== true) {
      for (let k = 0; k < n; k++) {
        let v = gen(it.url, it.ptr, name, depth + 1, stack);
        if (s.uniqueItems === true) for (let tries = 0; tries < 5 && out.some((x) => JSON.stringify(x) === JSON.stringify(v)); tries++) { variety0(() => { v = gen(it.url, it.ptr, name, depth + 1, stack); }); }
        if (s.uniqueItems === true && out.some((x) => JSON.stringify(x) === JSON.stringify(v))) break;
        out.push(v);
      }
    } else for (let k = 0; k < n; k++) out.push(`${r.pick(WORDS)} ${counter++}`);
    return out;
  }
  // a short run with varied choices (for unique array items)
  function variety0(fn) { const save = variety; variety = Math.max(1, variety); try { fn(); } finally { variety = save; } }

  return {
    /** One document for the schema at (url, ptr). */
    document(url, ptr = '', seed) { if (seed !== undefined) r = rng(seed); counter = 1; return gen(url, ptr, '', 0, []); },
  };
}

/** One document (opts.mode) or `count` documents with varied values (bulk test data). */
function generate(set, { mode = 'all', count = 1, seed = 7, draft } = {}) {
  const root = set.rootFile();
  if (count <= 1) {
    const g = createGenerator(set, { mode, seed, draft });
    return g.document(root.url, '');
  }
  const g = createGenerator(set, { mode, seed, variety: true, draft });
  const out = [];
  for (let k = 0; k < count; k++) out.push(g.document(root.url, '', seed + k * 7919));
  return out;
}

const ptrSegs = (p) => (p ? p.slice(1).split('/').map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~')) : []);
function getPath(doc, segs) { let v = doc; for (const k of segs) { if (v === null || typeof v !== 'object') return undefined; v = v[k]; } return v; }
/**
 * Makes a failing document pass by leaving out parts: for each error (deepest first) it tries to remove the member the
 * error is about, or one member of the object the error is on, and keeps a removal only when the error count drops.
 * Returns the fixed document or null. Bounded: about 400 checks.
 */
function repair(doc, check) {
  let cur = JSON.parse(JSON.stringify(doc));
  const count = (d) => (check(d) ? 0 : (check.errors || []).length || 1);
  let n = count(cur);
  let budget = 400;
  for (let round = 0; round < 40 && n > 0 && budget > 0; round++) {
    const errs = (check(cur), check.errors || []).slice().sort((a, b) => b.instancePath.length - a.instancePath.length);
    let improved = false;
    for (const e of errs) {
      if (budget <= 0) break;
      const segs = ptrSegs(e.instancePath);
      const tries = [];
      if (segs.length) tries.push(segs);
      const here = getPath(cur, segs);
      if (here && typeof here === 'object' && !Array.isArray(here)) for (const k of Object.keys(here).reverse()) tries.push(segs.concat(k));
      for (const t of tries) {
        if (budget-- <= 0) break;
        const parent = getPath(cur, t.slice(0, -1));
        if (!parent || typeof parent !== 'object' || Array.isArray(parent)) continue;
        const key = t[t.length - 1];
        if (!(key in parent)) continue;
        const copy = JSON.parse(JSON.stringify(cur));
        delete getPath(copy, t.slice(0, -1))[key];
        const m = count(copy);
        if (m < n) { cur = copy; n = m; improved = true; break; }
      }
      if (improved) break;
    }
    if (!improved) break;
  }
  return n === 0 ? cur : null;
}

/**
 * Like generate(), but each document is checked (check(doc) -> true when valid) and made again with other choices
 * when it fails, up to a few tries each (oneOf branches that overlap, if/then rules). Returns { docs, valid }.
 */
function generateChecked(set, { mode = 'all', count = 1, seed = 7, draft, check }) {
  const root = set.rootFile();
  const ok = (d) => { try { return !check || !!check(d); } catch (e) { return false; } };
  const docs = [];
  let valid = 0;
  const plain = createGenerator(set, { mode, seed, draft });
  const varied = createGenerator(set, { mode, seed, draft, variety: 2 });
  const values = createGenerator(set, { mode, seed, draft, variety: 1 });
  for (let k = 0; k < count; k++) {
    let best;
    const s0 = seed + k * 7919;
    // a single document keeps defaults and first choices when they pass; test data varies from the start
    best = count <= 1 ? plain.document(root.url, '', s0) : varied.document(root.url, '', s0);
    let pass = ok(best);
    // then other branch choices, then varied values on the first branches, then the plain document
    for (let t = 1; t <= 24 && !pass; t++) {
      const gen = count <= 1 ? (t <= 2 ? plain : t <= 12 ? values : varied) : (t <= 8 ? varied : values);
      const d = gen.document(root.url, '', s0 + t * 104729);
      if (ok(d)) { best = d; pass = true; }
    }
    if (!pass && count > 1) { const d = plain.document(root.url, '', s0); if (ok(d)) { best = d; pass = true; } }
    if (!pass && check) { const fixed = repair(best, check); if (fixed) { best = fixed; pass = true; } }
    if (pass) valid++;
    docs.push(best);
  }
  return { docs, valid };
}

module.exports = { generate, generateChecked, repair, createGenerator, regexExample, rng, formatValue, numberIn, parseRe };
