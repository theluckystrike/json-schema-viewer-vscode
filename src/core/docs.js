'use strict';
// Zovo Pro "Export docs": the schema as one Markdown file or one HTML page (no scripts, styles inline), for a README or
// a docs site. One section per object: the root, each definition and each nested object, with a table of its
// properties (name, type, required, description, rules). A $ref links to the section of its target instead of copying
// it, also when the target is in another local file. Remote $ref show their address.
const { constraintsOf, typesOf } = require('./model');
const { effectiveDraft } = require('./schemaset');
const { splitPointer, joinPointer } = require('./parse');

const MAX_SECTIONS = 1000;

function createDocModel(set) {
  const root = set.rootFile();
  const draft = effectiveDraft(root.value).draft;
  const sections = [];
  const byLoc = new Map(); // url#ptr -> section
  const used = new Set();
  const at = (url, ptr) => set.at(url, ptr);
  const refOf = (url, ptr) => { const r = set.refAt(url, ptr)[0]; return r ? r.target || {} : null; };
  const fileName = (url) => decodeURIComponent(url.split('/').pop());

  function nameFor(url, ptr, hint) {
    const segs = splitPointer(ptr);
    const s = at(url, ptr);
    if (segs.length >= 2 && (segs[segs.length - 2] === '$defs' || segs[segs.length - 2] === 'definitions')) return segs[segs.length - 1];
    if (!segs.length) return (s && typeof s === 'object' && typeof s.title === 'string' && s.title.trim()) || fileName(url).replace(/\.(schema\.)?(json|ya?ml)$/i, '');
    return hint || (s && typeof s === 'object' && typeof s.title === 'string' && s.title.trim()) || segs[segs.length - 1];
  }
  function slug(name) {
    let base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    return id;
  }
  /** Is this schema worth a section of its own (an object with members, or a definition / file root)? */
  function isObjectish(s) { return !!(s && typeof s === 'object' && (s.properties || s.patternProperties || (s.type === 'object' && s.additionalProperties && typeof s.additionalProperties === 'object'))); }
  function sectionFor(url, ptr, hint, force) {
    const key = url + '#' + ptr;
    if (byLoc.has(key)) return byLoc.get(key);
    const s = at(url, ptr);
    if (!force && !isObjectish(s)) return null;
    if (sections.length >= MAX_SECTIONS) return null;
    const name = nameFor(url, ptr, hint);
    const sec = { id: slug(name), name, url, ptr, file: fileName(url), filled: false };
    byLoc.set(key, sec);
    sections.push(sec);
    return sec;
  }
  /** Follows $ref chains to the schema that has the content. { url, ptr } or { remote } / { missing }. */
  function follow(url, ptr, seen = new Set()) {
    const k = url + '#' + ptr;
    if (seen.has(k) || seen.size > 30) return { url, ptr };
    seen.add(k);
    const t = refOf(url, ptr);
    const s = at(url, ptr);
    if (!t) return { url, ptr };
    if (t.ptr === undefined) return t.remote ? { remote: t.remote, url, ptr } : { missing: t.missing || 'not found', url, ptr };
    // a $ref with properties of its own beside it (2019-09 and later) is documented where it is
    if (isObjectish(s)) return { url, ptr };
    return follow(t.url, t.ptr, seen);
  }

  /** A type cell: [{ text, link? }] */
  function typeOf(url, ptr, hint, depth = 0) {
    const s = at(url, ptr);
    if (s === true || s === undefined) return [{ text: 'any' }];
    if (s === false) return [{ text: 'never' }];
    if (depth > 6) return [{ text: typesOf(s).join(' or ') || 'any' }];
    const t = refOf(url, ptr);
    if (t) {
      if (t.remote) return [{ text: `$ref ${t.remote}`, remote: true }];
      if (t.ptr === undefined) return [{ text: `$ref ${s.$ref || ''} (not found)` }];
      const target = follow(t.url, t.ptr);
      if (target.remote) return [{ text: `$ref ${target.remote}`, remote: true }];
      const ts = at(target.url, target.ptr);
      if (isObjectish(ts) || splitPointer(target.ptr).length === 0 || /\/(\$defs|definitions)\/[^/]+$/.test(target.ptr)) {
        const sec = sectionFor(target.url, target.ptr, undefined, true);
        if (sec) return [{ text: sec.name, link: sec.id }];
      }
      return typeOf(target.url, target.ptr, hint, depth + 1);
    }
    const parts = [];
    const types = typesOf(s);
    if (types.includes('array') || s.items !== undefined || s.prefixItems) {
      const items = s.prefixItems ? null : (s.items && !Array.isArray(s.items) ? joinPointer(ptr, 'items') : null);
      if (items !== null) parts.push({ text: 'array of ' }, ...typeOf(url, items, hint ? `${hint} item` : 'item', depth + 1));
      else parts.push({ text: Array.isArray(s.prefixItems || s.items) ? 'array (tuple)' : 'array' });
    }
    if (isObjectish(s)) {
      const sec = sectionFor(url, ptr, hint);
      if (sec) parts.push({ text: sec.name, link: sec.id });
    }
    const rest = types.filter((x) => x !== 'array' && !(x === 'object' && isObjectish(s)));
    if (rest.length) { if (parts.length) parts.push({ text: ' or ' }); parts.push({ text: rest.join(' or ') }); }
    for (const [kw, word] of [['oneOf', 'one of'], ['anyOf', 'any of'], ['allOf', 'all of']]) {
      if (!Array.isArray(s[kw]) || !s[kw].length) continue;
      if (parts.length) parts.push({ text: '; ' });
      parts.push({ text: `${word}: ` });
      s[kw].forEach((_, i) => { if (i) parts.push({ text: ', ' }); parts.push(...typeOf(url, joinPointer(ptr, kw, String(i)), hint ? `${hint} ${i + 1}` : `option ${i + 1}`, depth + 1)); });
    }
    if (!parts.length) parts.push({ text: 'any' });
    return parts;
  }

  function fill(sec) {
    sec.filled = true;
    const s = at(sec.url, sec.ptr);
    if (!s || typeof s !== 'object') { sec.types = [{ text: s === false ? 'never' : 'any' }]; sec.props = []; return; }
    sec.title = typeof s.title === 'string' ? s.title : '';
    sec.desc = typeof s.description === 'string' ? s.description : '';
    sec.cons = constraintsOf(s, draft).filter(([l]) => l !== 'additional properties');
    sec.types = typeOfOwn(sec);
    sec.closed = s.additionalProperties === false || s.unevaluatedProperties === false;
    sec.props = [];
    const req = new Set(Array.isArray(s.required) ? s.required : []);
    const props = s.properties && typeof s.properties === 'object' ? s.properties : {};
    for (const name of Object.keys(props)) {
      const ptr = joinPointer(sec.ptr, 'properties', name);
      const ps = at(sec.url, ptr);
      const tgt = refOf(sec.url, ptr) && follow(sec.url, ptr);
      const ds = ps && typeof ps === 'object' ? ps : {};
      const tds = tgt && tgt.ptr !== undefined ? at(tgt.url, tgt.ptr) : null;
      sec.props.push({
        name, required: req.has(name), type: typeOf(sec.url, ptr, `${sec.name}.${name}`),
        desc: typeof ds.description === 'string' ? ds.description : (tds && typeof tds.description === 'string' ? tds.description : ''),
        cons: constraintsOf(ds, draft).map(([l, v]) => `${l}: ${v}`), deprecated: ds.deprecated === true,
      });
    }
    for (const r of req) if (!(r in props)) sec.props.push({ name: r, required: true, type: [{ text: 'any' }], desc: '', cons: [] });
    if (s.patternProperties && typeof s.patternProperties === 'object') for (const pat of Object.keys(s.patternProperties)) sec.props.push({ name: `/${pat}/`, pattern: true, required: false, type: typeOf(sec.url, joinPointer(sec.ptr, 'patternProperties', pat), `${sec.name} entry`), desc: (s.patternProperties[pat] && s.patternProperties[pat].description) || 'Any key that matches the pattern.', cons: [] });
    if (s.additionalProperties && typeof s.additionalProperties === 'object') sec.props.push({ name: '(any other key)', pattern: true, required: false, type: typeOf(sec.url, joinPointer(sec.ptr, 'additionalProperties'), `${sec.name} value`), desc: s.additionalProperties.description || '', cons: [] });
  }
  function typeOfOwn(sec) {
    const s = at(sec.url, sec.ptr);
    const types = typesOf(s);
    const out = [];
    for (const [kw, word] of [['oneOf', 'one of'], ['anyOf', 'any of'], ['allOf', 'all of']]) {
      if (!Array.isArray(s[kw])) continue;
      if (out.length) out.push({ text: '; ' });
      out.push({ text: `${word}: ` });
      s[kw].forEach((_, i) => { if (i) out.push({ text: ', ' }); out.push(...typeOf(sec.url, joinPointer(sec.ptr, kw, String(i)), `${sec.name} ${i + 1}`)); });
    }
    const t = refOf(sec.url, sec.ptr);
    if (t && t.ptr !== undefined && !(s.properties)) { if (out.length) out.push({ text: '; ' }); out.push({ text: 'see ' }, ...typeOf(sec.url, sec.ptr, sec.name)); }
    if (!out.length && types.length) out.push({ text: types.join(' or ') });
    return out;
  }

  const rootSec = sectionFor(root.url, '', undefined, true);
  // definitions of the root file are listed even when nothing refers to them
  const defs = [];
  for (const kw of ['$defs', 'definitions']) if (root.value && typeof root.value === 'object' && root.value[kw] && typeof root.value[kw] === 'object') for (const n of Object.keys(root.value[kw])) defs.push(joinPointer('', kw, n));
  const fillAll = () => { for (let i = 0; i < sections.length; i++) if (!sections[i].filled) fill(sections[i]); };
  fillAll();
  for (const p of defs) sectionFor(root.url, p, undefined, true);
  fillAll();
  const rv = root.value && typeof root.value === 'object' ? root.value : {};
  return {
    title: rootSec.name, description: typeof rv.description === 'string' ? rv.description : '', id: typeof rv.$id === 'string' ? rv.$id : '',
    draft, file: root.name, sections, truncated: sections.length >= MAX_SECTIONS,
  };
}

// ---------- Markdown ----------
const mdCell = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').replace(/</g, '&lt;').trim();
const mdKeep = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').replace(/</g, '&lt;');
const mdType = (parts) => parts.map((p) => (p.link ? `[${mdCell(p.text)}](#${p.link})` : p.remote ? `\`${mdCell(p.text)}\`` : mdKeep(p.text))).join('').trim();

function toMarkdown(model, { generator = 'JSON Schema Viewer & Validator' } = {}) {
  const L = [];
  L.push(`# ${model.title}`, '');
  if (model.description) L.push(model.description.trim(), '');
  const meta = [`File: \`${model.file}\``, `JSON Schema draft ${model.draft}`];
  if (model.id) meta.push(`$id: \`${model.id}\``);
  L.push(meta.join(' · '), '');
  if (model.sections.length > 1) {
    L.push('## Contents', '');
    for (const s of model.sections) L.push(`- [${mdCell(s.name)}](#${s.id})`);
    L.push('');
  }
  for (const s of model.sections) {
    L.push(`<a id="${s.id}"></a>`, '', `## ${mdCell(s.name)}`, '');
    if (s.title && s.title !== s.name) L.push(`**${mdCell(s.title)}**`, '');
    if (s.desc) L.push(s.desc.trim(), '');
    const facts = [];
    if (s.types && s.types.length) facts.push(`Type: ${mdType(s.types)}`);
    if (s.file !== model.file) facts.push(`From \`${s.file}\``);
    if (s.closed) facts.push('No other keys allowed');
    if (facts.length) L.push(facts.join(' · '), '');
    if (s.cons && s.cons.length) L.push(s.cons.map(([l, v]) => `${l}: \`${mdCell(v)}\``).join(' · '), '');
    if (s.props.length) {
      L.push('| Property | Type | Required | Description |', '| --- | --- | --- | --- |');
      for (const p of s.props) {
        const desc = [p.deprecated ? '**Deprecated.**' : '', mdCell(p.desc), p.cons.length ? p.cons.map((c) => `\`${mdCell(c)}\``).join(' ') : ''].filter(Boolean).join(' ');
        L.push(`| ${p.pattern ? mdCell(p.name) : `\`${mdCell(p.name)}\``} | ${mdType(p.type)} | ${p.required ? 'yes' : ''} | ${desc} |`);
      }
      L.push('');
    }
  }
  if (model.truncated) L.push(`(Stopped at ${MAX_SECTIONS} sections.)`, '');
  L.push('---', '', `Made with ${generator}.`, '');
  return L.join('\n');
}

// ---------- HTML ----------
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const htmlType = (parts) => parts.map((p) => (p.link ? `<a href="#${esc(p.link)}">${esc(p.text)}</a>` : p.remote ? `<code>${esc(p.text)}</code>` : esc(p.text))).join('');
const STYLE = `body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;color:#1f2328;background:#fff}
main{max-width:1100px;margin:0 auto;padding:24px 32px 48px}h1{font-size:28px;margin:0 0 8px}h2{font-size:20px;margin:36px 0 8px;padding-top:8px;border-top:1px solid #d8dee4}
.meta{color:#59636e;font-size:13px}code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2f4f6;padding:1px 4px;border-radius:4px}
table{border-collapse:collapse;width:100%;margin:8px 0 4px;font-size:14px}th,td{border:1px solid #d8dee4;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f6f8fa}
td.req{color:#9a3412;font-weight:600}nav ul{columns:3;padding-left:18px}a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}.dep{color:#9a3412;font-weight:600}
@media (prefers-color-scheme: dark){body{background:#0d1117;color:#e6edf3}code{background:#161b22}th{background:#161b22}th,td,h2{border-color:#30363d}.meta{color:#9198a1}a{color:#4493f8}}`;

function toHtml(model, { generator = 'JSON Schema Viewer & Validator' } = {}) {
  const H = [];
  H.push('<!DOCTYPE html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">', `<title>${esc(model.title)}</title>`, `<style>${STYLE}</style>`, '</head>', '<body>', '<main>');
  H.push(`<h1>${esc(model.title)}</h1>`);
  if (model.description) H.push(`<p>${esc(model.description)}</p>`);
  H.push(`<p class="meta">File <code>${esc(model.file)}</code> · JSON Schema draft ${esc(model.draft)}${model.id ? ` · $id <code>${esc(model.id)}</code>` : ''}</p>`);
  if (model.sections.length > 1) H.push('<nav><ul>' + model.sections.map((s) => `<li><a href="#${esc(s.id)}">${esc(s.name)}</a></li>`).join('') + '</ul></nav>');
  for (const s of model.sections) {
    H.push(`<section id="${esc(s.id)}">`, `<h2>${esc(s.name)}</h2>`);
    if (s.title && s.title !== s.name) H.push(`<p><strong>${esc(s.title)}</strong></p>`);
    if (s.desc) H.push(`<p>${esc(s.desc)}</p>`);
    const facts = [];
    if (s.types && s.types.length) facts.push(`Type: ${htmlType(s.types)}`);
    if (s.file !== model.file) facts.push(`From <code>${esc(s.file)}</code>`);
    if (s.closed) facts.push('No other keys allowed');
    if (facts.length) H.push(`<p class="meta">${facts.join(' · ')}</p>`);
    if (s.cons && s.cons.length) H.push(`<p class="meta">${s.cons.map(([l, v]) => `${esc(l)}: <code>${esc(v)}</code>`).join(' · ')}</p>`);
    if (s.props.length) {
      H.push('<table><thead><tr><th>Property</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>');
      for (const p of s.props) H.push(`<tr><td>${p.pattern ? esc(p.name) : `<code>${esc(p.name)}</code>`}</td><td>${htmlType(p.type)}</td><td class="${p.required ? 'req' : ''}">${p.required ? 'yes' : ''}</td><td>${p.deprecated ? '<span class="dep">Deprecated.</span> ' : ''}${esc(p.desc)}${p.cons.length ? ' ' + p.cons.map((c) => `<code>${esc(c)}</code>`).join(' ') : ''}</td></tr>`);
      H.push('</tbody></table>');
    }
    H.push('</section>');
  }
  H.push(`<p class="meta">Made with ${esc(generator)}.</p>`, '</main>', '</body>', '</html>', '');
  return H.join('\n');
}

module.exports = { createDocModel, toMarkdown, toHtml, mdCell, esc };
