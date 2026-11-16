'use strict';
// Reads JSON (comments and trailing commas allowed) and YAML text into a plain value and keeps a way back from a JSON
// pointer to the line and column in the text: the docs view jumps to schema lines with it, and validation puts each
// error on the line of the value that failed. JSON: jsonc-parser (MIT, lib/jsonc-parser). YAML: yaml (ISC, lib/vendor.js).
const jp = require('../../lib/jsonc-parser/main.js');
const { YAML } = require('../../lib/vendor.js');

const YAML_RE = /\.ya?ml$/i;

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: off - starts[lo] + 1 };
  };
}

/** '/a/b~1c/0' -> ['a', 'b/c', '0'] */
function splitPointer(p) {
  if (!p || p === '/') return p === '/' ? [''] : [];
  return String(p).replace(/^\//, '').split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}
const escSeg = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
function joinPointer(base, ...segs) { return base + segs.map((s) => '/' + escSeg(s)).join(''); }

const JSON_ERRORS = {
  1: 'Invalid symbol', 2: 'Invalid number format', 3: 'Property name expected', 4: 'Value expected', 5: 'Colon expected',
  6: 'Comma expected', 7: 'Closing brace expected', 8: 'Closing bracket expected', 9: 'End of file expected',
  10: 'Invalid comment token', 11: 'Unexpected end of comment', 12: 'Unexpected end of string', 13: 'Unexpected end of number',
  14: 'Invalid unicode', 15: 'Invalid escape character', 16: 'Invalid character',
};

function kindOf(name, text) {
  if (YAML_RE.test(name || '')) return 'yaml';
  if (/\.(json|jsonc|json5)$/i.test(name || '')) return 'json';
  const t = String(text || '').replace(/^﻿/, '').trimStart();
  return t.startsWith('{') || t.startsWith('[') || t === '' ? 'json' : 'yaml';
}

function parseJson(text) {
  const pos = lineIndex(text);
  const errors = [];
  const tree = jp.parseTree(text, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false });
  if (errors.length || !tree) {
    const e = errors[0] || { error: 4, offset: 0 };
    const p = pos(e.offset);
    return { error: { message: `${JSON_ERRORS[e.error] || 'Syntax error'} at line ${p.line}, column ${p.col}`, line: p.line, col: p.col } };
  }
  const value = jp.getNodeValue(tree);
  function node(pointer) {
    const segs = splitPointer(pointer);
    let n = tree, prop = null;
    for (const s of segs) {
      if (!n) return null;
      if (n.type === 'object') {
        // the last member with that key wins, as in the parsed value
        prop = (n.children || []).filter((c) => c.children && c.children[0].value === s).pop() || null;
        if (!prop || !prop.children[1]) return null;
        n = prop.children[1];
      } else if (n.type === 'array') {
        prop = null;
        n = /^\d+$/.test(s) && n.children ? n.children[Number(s)] || null : null;
      } else return null;
    }
    return n ? { n, prop } : null;
  }
  return {
    kind: 'json', value,
    /** { line, col } of the value at the pointer (the key's line for an object member), or null */
    locate(pointer) { const f = node(pointer); if (!f) return null; return pos(f.prop ? f.prop.offset : f.n.offset); },
    /** { line, col } of the member key (for "additional property" errors) */
    locateKey(pointer) { const f = node(pointer); if (!f || !f.prop) return null; return pos(f.prop.offset); },
  };
}

function parseYaml(text) {
  const pos = lineIndex(text);
  let doc, multi = false;
  try {
    // several documents in one file: the first one is read
    const all = YAML.parseAllDocuments(text, { prettyErrors: true, uniqueKeys: false, strict: false });
    const list = Array.isArray(all) ? all : [all];
    doc = list[0] || YAML.parseDocument(text, { prettyErrors: true, uniqueKeys: false, strict: false });
    multi = list.length > 1;
  } catch (e) {
    return { error: { message: String((e && e.message) || e).split('\n')[0], line: 1, col: 1 } };
  }
  const errs = doc.errors || [];
  if (errs.length) {
    const e = errs[0];
    const lp = e.linePos && e.linePos[0];
    const line = lp ? lp.line : 1, col = lp ? lp.col : 1;
    return { error: { message: String(e.message).split('\n')[0].replace(/:\s*$/, ''), line, col } };
  }
  let value;
  try { value = doc.toJS({ maxAliasCount: 10000 }); } catch (e) { return { error: { message: String((e && e.message) || e).split('\n')[0], line: 1, col: 1 } }; }
  if (value === undefined) value = null;
  function find(pointer) {
    let n = doc.contents, key = null;
    for (const s of splitPointer(pointer)) {
      if (n && YAML.isAlias(n)) n = n.resolve(doc);
      if (YAML.isMap(n)) { const pair = n.items.filter((it) => { const k = it.key && YAML.isScalar(it.key) ? it.key.value : it.key; return String(k) === s; }).pop(); if (!pair) return null; key = pair.key; n = pair.value; }
      else if (YAML.isSeq(n)) { if (!/^\d+$/.test(s)) return null; n = n.items[Number(s)]; key = null; if (n === undefined) return null; }
      else return null;
    }
    return { n, key };
  }
  const at = (node) => (node && node.range ? pos(node.range[0]) : null);
  return {
    kind: 'yaml', value, multi,
    locate(pointer) { const f = find(pointer); if (!f) return null; return at(f.key) || at(f.n) || null; },
    locateKey(pointer) { const f = find(pointer); return f ? at(f.key) : null; },
  };
}

/** Parses JSON or YAML text. { kind, value, locate(ptr), locateKey(ptr) } or { error: { message, line, col } } */
function parseText(text, name) {
  const t = String(text == null ? '' : text).replace(/^﻿/, '');
  const kind = kindOf(name, t);
  if (!t.trim()) return { kind, error: { message: 'The file is empty.', line: 1, col: 1 } };
  const r = kind === 'yaml' ? parseYaml(t) : parseJson(t);
  r.kind = kind;
  return r;
}

/** The value at a pointer, or undefined. */
function getAt(value, pointer) {
  let v = value;
  for (const s of splitPointer(pointer)) {
    if (v === null || typeof v !== 'object') return undefined;
    if (Array.isArray(v)) { if (!/^\d+$/.test(s)) return undefined; v = v[Number(s)]; }
    else { if (!Object.prototype.hasOwnProperty.call(v, s)) return undefined; v = v[s]; }
  }
  return v;
}

module.exports = { parseText, kindOf, splitPointer, joinPointer, escSeg, getAt, lineIndex, YAML_RE };
