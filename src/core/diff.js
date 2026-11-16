'use strict';
// Zovo Pro "Schema diff": compares an older and a newer version of a schema (each with its local $ref files) and lists
// the changes that can break data or code written for the old one: removed properties, new required fields, narrowed
// types or enums, tighter limits, new patterns, closed objects. Changes that only widen what is allowed are listed
// apart, and so are text changes (title, description). The two schemas are walked side by side by data path; $ref
// are followed on both sides, and a schema that refers to itself is compared once.
const { typesOf, short } = require('./model');
const { joinPointer } = require('./parse');

const MIN_KEYS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties', 'minContains'];
const MAX_KEYS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties', 'maxContains'];
const LABEL = {
  minimum: 'minimum', exclusiveMinimum: 'exclusive minimum', minLength: 'min length', minItems: 'min items', minProperties: 'min properties', minContains: 'min contains',
  maximum: 'maximum', exclusiveMaximum: 'exclusive maximum', maxLength: 'max length', maxItems: 'max items', maxProperties: 'max properties', maxContains: 'max contains',
};
const MAX_CHANGES = 5000;

function diffSets(oldSet, newSet) {
  const breaking = [], other = [], text = [];
  const seen = new Set();
  const add = (list, where, what) => { if (breaking.length + other.length + text.length < MAX_CHANGES) list.push({ where: where || '(root)', what }); };

  function resolve(set, url, ptr, depth = 0) {
    const r = set.refAt(url, ptr)[0];
    const s = set.at(url, ptr);
    if (!r || depth > 30) return { url, ptr, s };
    const t = r.target || {};
    if (t.ptr === undefined) return { url, ptr, s, unresolved: t.remote || t.missing || r.ref };
    // a $ref with keywords of its own beside it: compare the target, then the own keywords count too (rare)
    return resolve(set, t.url, t.ptr, depth + 1);
  }
  const isObj = (s) => s && typeof s === 'object' && !Array.isArray(s);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const exMin = (s) => (s.exclusiveMinimum === true && isNum(s.minimum) ? s.minimum : isNum(s.exclusiveMinimum) ? s.exclusiveMinimum : undefined);
  const exMax = (s) => (s.exclusiveMaximum === true && isNum(s.maximum) ? s.maximum : isNum(s.exclusiveMaximum) ? s.exclusiveMaximum : undefined);
  const val = (s, k) => (k === 'exclusiveMinimum' ? exMin(s) : k === 'exclusiveMaximum' ? exMax(s) : k === 'minimum' && s.exclusiveMinimum === true ? undefined : k === 'maximum' && s.exclusiveMaximum === true ? undefined : (isNum(s[k]) ? s[k] : undefined));

  function walk(oldLoc, newLoc, where, depth) {
    if (depth > 60) return;
    const a = resolve(oldSet, oldLoc.url, oldLoc.ptr);
    const b = resolve(newSet, newLoc.url, newLoc.ptr);
    const key = `${a.url}#${a.ptr}|${b.url}#${b.ptr}`;
    if (seen.has(key)) return;
    seen.add(key);
    const A = a.s, B = b.s;
    if (A === undefined && B === undefined) return;
    if (a.unresolved || b.unresolved) {
      if ((a.unresolved || '') !== (b.unresolved || '')) add(other, where, `$ref changed: ${a.unresolved || '(local schema)'} to ${b.unresolved || '(local schema)'} (not compared further)`);
      return;
    }
    if (A === false && B !== false) { add(other, where, 'was "never allowed" (false), now allowed'); return; }
    if (B === false && A !== false) { add(breaking, where, 'now never allowed (schema false)'); return; }
    const SA = isObj(A) ? A : {}, SB = isObj(B) ? B : {};
    // types
    const ta = new Set(typesOf(A === true ? {} : SA)), tb = new Set(typesOf(B === true ? {} : SB));
    const widen = (s) => { const x = new Set(s); if (x.has('number')) x.add('integer'); return x; };
    if (ta.size && tb.size) {
      const removed = [...ta].filter((t) => !widen(tb).has(t));
      const added = [...tb].filter((t) => !widen(ta).has(t));
      if (removed.length) add(breaking, where, `type narrowed: ${[...ta].join(' or ')} to ${[...tb].join(' or ')}`);
      else if (added.length) add(other, where, `type widened: ${[...ta].join(' or ')} to ${[...tb].join(' or ')}`);
    } else if (!ta.size && tb.size && !('type' in SA) && 'type' in SB) add(breaking, where, `type now limited to ${[...tb].join(' or ')}`);
    else if (ta.size && !tb.size && 'type' in SA && !('type' in SB)) add(other, where, `type no longer limited (was ${[...ta].join(' or ')})`);
    // enum and const
    const ea = Array.isArray(SA.enum) ? SA.enum.map((v) => JSON.stringify(v)) : null;
    const eb = Array.isArray(SB.enum) ? SB.enum.map((v) => JSON.stringify(v)) : null;
    if (ea && eb) {
      const gone = ea.filter((v) => !eb.includes(v)), neu = eb.filter((v) => !ea.includes(v));
      if (gone.length) add(breaking, where, `enum values removed: ${gone.slice(0, 20).join(', ')}${gone.length > 20 ? ', ...' : ''}`);
      if (neu.length) add(other, where, `enum values added: ${neu.slice(0, 20).join(', ')}${neu.length > 20 ? ', ...' : ''}`);
    } else if (!ea && eb) add(breaking, where, `now limited to the values ${eb.slice(0, 20).join(', ')}`);
    else if (ea && !eb) add(other, where, 'enum removed: any value of the type allowed now');
    if ('const' in SB && (!('const' in SA) || JSON.stringify(SA.const) !== JSON.stringify(SB.const))) add(breaking, where, `${'const' in SA ? `const changed from ${short(SA.const, 60)}` : 'now fixed'} to ${short(SB.const, 60)}`);
    else if ('const' in SA && !('const' in SB)) add(other, where, `const ${short(SA.const, 60)} removed`);
    // limits
    for (const k of MIN_KEYS) {
      const x = val(SA, k), y = val(SB, k);
      if (y !== undefined && (x === undefined || y > x)) add(breaking, where, x === undefined ? `${LABEL[k]} ${y} added` : `${LABEL[k]} raised from ${x} to ${y}`);
      else if (x !== undefined && (y === undefined || y < x)) add(other, where, y === undefined ? `${LABEL[k]} ${x} removed` : `${LABEL[k]} lowered from ${x} to ${y}`);
    }
    for (const k of MAX_KEYS) {
      const x = val(SA, k), y = val(SB, k);
      if (y !== undefined && (x === undefined || y < x)) add(breaking, where, x === undefined ? `${LABEL[k]} ${y} added` : `${LABEL[k]} lowered from ${x} to ${y}`);
      else if (x !== undefined && (y === undefined || y > x)) add(other, where, y === undefined ? `${LABEL[k]} ${x} removed` : `${LABEL[k]} raised from ${x} to ${y}`);
    }
    if (isNum(SB.multipleOf) && SA.multipleOf !== SB.multipleOf) add(breaking, where, isNum(SA.multipleOf) ? `multipleOf changed from ${SA.multipleOf} to ${SB.multipleOf}` : `multipleOf ${SB.multipleOf} added`);
    else if (isNum(SA.multipleOf) && !isNum(SB.multipleOf)) add(other, where, `multipleOf ${SA.multipleOf} removed`);
    for (const k of ['pattern', 'format']) {
      if (typeof SB[k] === 'string' && SA[k] !== SB[k]) add(breaking, where, typeof SA[k] === 'string' ? `${k} changed from ${SA[k]} to ${SB[k]}` : `${k} ${SB[k]} added`);
      else if (typeof SA[k] === 'string' && typeof SB[k] !== 'string') add(other, where, `${k} ${SA[k]} removed`);
    }
    if (SB.uniqueItems === true && SA.uniqueItems !== true) add(breaking, where, 'items must now be unique');
    else if (SA.uniqueItems === true && SB.uniqueItems !== true) add(other, where, 'items no longer need to be unique');
    if (SB.deprecated === true && SA.deprecated !== true) add(other, where, 'marked deprecated');
    if (SB.readOnly === true && SA.readOnly !== true) add(other, where, 'marked read only');
    for (const k of ['title', 'description']) if (typeof SA[k] === 'string' && typeof SB[k] === 'string' && SA[k] !== SB[k]) add(text, where, `${k} changed`); else if (typeof SA[k] !== typeof SB[k] && (typeof SA[k] === 'string' || typeof SB[k] === 'string')) add(text, where, `${k} ${typeof SB[k] === 'string' ? 'added' : 'removed'}`);
    // required and properties
    const ra = new Set(Array.isArray(SA.required) ? SA.required : []), rb = new Set(Array.isArray(SB.required) ? SB.required : []);
    const pa = isObj(SA.properties) ? SA.properties : {}, pb = isObj(SB.properties) ? SB.properties : {};
    const sub = (name) => (where ? `${where}.${name}` : name);
    for (const r of rb) if (!ra.has(r)) add(breaking, sub(r), r in pa ? 'now required' : 'new required property');
    for (const r of ra) if (!rb.has(r) && r in pb) add(other, sub(r), 'no longer required');
    for (const name of Object.keys(pa)) {
      if (!(name in pb)) {
        const closed = SB.additionalProperties === false || SB.unevaluatedProperties === false;
        add(breaking, sub(name), closed ? 'property removed (data that has it is now rejected)' : 'property removed');
      } else walk({ url: a.url, ptr: joinPointer(a.ptr, 'properties', name) }, { url: b.url, ptr: joinPointer(b.ptr, 'properties', name) }, sub(name), depth + 1);
    }
    for (const name of Object.keys(pb)) if (!(name in pa) && !rb.has(name)) add(other, sub(name), 'optional property added');
    // additional properties
    const apA = SA.additionalProperties, apB = SB.additionalProperties;
    if (apB === false && apA !== false) add(breaking, where, 'other keys no longer allowed (additionalProperties false)');
    else if (apA === false && apB !== false) add(other, where, 'other keys allowed now');
    else if (isObj(apA) && isObj(apB)) walk({ url: a.url, ptr: joinPointer(a.ptr, 'additionalProperties') }, { url: b.url, ptr: joinPointer(b.ptr, 'additionalProperties') }, `${where || ''}.*`, depth + 1);
    else if (isObj(apB) && apA === undefined) add(breaking, where, 'other keys now have a schema');
    const ppa = isObj(SA.patternProperties) ? SA.patternProperties : {}, ppb = isObj(SB.patternProperties) ? SB.patternProperties : {};
    for (const p of Object.keys(ppa)) if (p in ppb) walk({ url: a.url, ptr: joinPointer(a.ptr, 'patternProperties', p) }, { url: b.url, ptr: joinPointer(b.ptr, 'patternProperties', p) }, `${where || ''}./${p}/`, depth + 1); else add(other, where, `pattern property /${p}/ removed`);
    for (const p of Object.keys(ppb)) if (!(p in ppa)) add(breaking, where, `pattern property /${p}/ added (keys that match it get a schema)`);
    // items
    const ia = SA.items, ib = SB.items;
    if (isObj(ia) && isObj(ib)) walk({ url: a.url, ptr: joinPointer(a.ptr, 'items') }, { url: b.url, ptr: joinPointer(b.ptr, 'items') }, `${where || ''}[]`, depth + 1);
    else if (ia === undefined && isObj(ib) && Object.keys(ib).length) add(breaking, `${where || ''}[]`, 'items now have a schema');
    const ta2 = Array.isArray(SA.prefixItems) ? SA.prefixItems : Array.isArray(ia) ? ia : null;
    const tb2 = Array.isArray(SB.prefixItems) ? SB.prefixItems : Array.isArray(ib) ? ib : null;
    if (ta2 && tb2) {
      const ka = Array.isArray(SA.prefixItems) ? 'prefixItems' : 'items', kb = Array.isArray(SB.prefixItems) ? 'prefixItems' : 'items';
      for (let i = 0; i < Math.min(ta2.length, tb2.length); i++) walk({ url: a.url, ptr: joinPointer(a.ptr, ka, String(i)) }, { url: b.url, ptr: joinPointer(b.ptr, kb, String(i)) }, `${where || ''}[${i}]`, depth + 1);
      if (tb2.length > ta2.length) add(breaking, where, `tuple has ${tb2.length - ta2.length} more position(s) with a schema`);
      if (tb2.length < ta2.length) add(other, where, `tuple has ${ta2.length - tb2.length} fewer position(s) with a schema`);
    }
    // combinators
    for (const [kw, word] of [['allOf', 'all of'], ['anyOf', 'any of'], ['oneOf', 'one of']]) {
      const la = Array.isArray(SA[kw]) ? SA[kw] : null, lb = Array.isArray(SB[kw]) ? SB[kw] : null;
      if (!la && !lb) continue;
      if (!la && lb) { add(breaking, where, `${word} added (${lb.length} schemas)`); continue; }
      if (la && !lb) { add(other, where, `${word} removed`); continue; }
      for (let i = 0; i < Math.min(la.length, lb.length); i++) walk({ url: a.url, ptr: joinPointer(a.ptr, kw, String(i)) }, { url: b.url, ptr: joinPointer(b.ptr, kw, String(i)) }, `${where || ''} (${word} #${i + 1})`.trim(), depth + 1);
      if (lb.length > la.length) add(kw === 'allOf' ? breaking : other, where, `${word}: ${lb.length - la.length} schema(s) added`);
      if (lb.length < la.length) add(kw === 'allOf' ? other : breaking, where, `${word}: ${la.length - lb.length} schema(s) removed`);
    }
    for (const kw of ['not', 'if', 'then', 'else', 'contains', 'propertyNames']) {
      if (isObj(SA[kw]) && isObj(SB[kw])) walk({ url: a.url, ptr: joinPointer(a.ptr, kw) }, { url: b.url, ptr: joinPointer(b.ptr, kw) }, `${where || ''} (${kw})`.trim(), depth + 1);
      else if (!isObj(SA[kw]) && isObj(SB[kw])) add(breaking, where, `"${kw}" rule added`);
      else if (isObj(SA[kw]) && !isObj(SB[kw])) add(other, where, `"${kw}" rule removed`);
    }
  }

  const ra = oldSet.rootFile(), rb = newSet.rootFile();
  walk({ url: ra.url, ptr: '' }, { url: rb.url, ptr: '' }, '', 0);
  // definitions that are not reached from the root: compared by name
  for (const kw of ['$defs', 'definitions']) {
    const da = isObjOf(ra.value, kw), db = isObjOf(rb.value, kw);
    for (const n of Object.keys(da)) {
      if (!(n in db)) { if (!(kw === '$defs' && n in isObjOf(rb.value, 'definitions')) && !(kw === 'definitions' && n in isObjOf(rb.value, '$defs'))) add(breaking, `${kw}/${n}`, 'definition removed (a $ref to it from another schema breaks)'); continue; }
      walk({ url: ra.url, ptr: joinPointer('', kw, n) }, { url: rb.url, ptr: joinPointer('', kw, n) }, `${kw}/${n}`, 1);
    }
    for (const n of Object.keys(db)) if (!(n in da)) add(other, `${kw}/${n}`, 'definition added');
  }
  return { breaking, other, text, truncated: breaking.length + other.length + text.length >= MAX_CHANGES };
}
function isObjOf(v, k) { return v && typeof v === 'object' && v[k] && typeof v[k] === 'object' && !Array.isArray(v[k]) ? v[k] : {}; }

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
function diffMarkdown(d, oldName, newName) {
  const L = [`# Schema diff: ${oldName} to ${newName}`, ''];
  L.push(`${d.breaking.length} breaking change${d.breaking.length === 1 ? '' : 's'}, ${d.other.length} other change${d.other.length === 1 ? '' : 's'}, ${d.text.length} text change${d.text.length === 1 ? '' : 's'}.`, '');
  L.push('Breaking means data or code made for the old schema can fail with the new one.', '');
  const table = (list) => { L.push('| Where | Change |', '| --- | --- |'); for (const c of list) L.push(`| \`${cell(c.where)}\` | ${cell(c.what)} |`); L.push(''); };
  L.push('## Breaking changes', '');
  if (d.breaking.length) table(d.breaking); else L.push('No breaking changes found.', '');
  L.push('## Other changes', '');
  if (d.other.length) table(d.other); else L.push('None.', '');
  if (d.text.length) { L.push('## Title and description changes', ''); table(d.text); }
  if (d.truncated) L.push('(The list stops at 5,000 changes.)', '');
  return L.join('\n');
}

module.exports = { diffSets, diffMarkdown };
