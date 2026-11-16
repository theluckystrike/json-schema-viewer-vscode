// JSON Schema docs view (webview side). Draws the property tree from the model the extension host sends: one summary
// per subschema, keyed "<file>:<pointer>". A $ref is followed by key when its row opens, so a schema that refers to
// itself opens one level per click and never loops. No network: the CSP allows no connections and this script makes
// none. Exposes window.__jsonSchemaDocs for the real-app test.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const S = { model: null, name: '', expanded: new Set(['0']), sel: null, rows: [], hits: [], q: '', msg: 0 };
  window.__jsonSchemaDocs = S;
  const post = (m) => vscode.postMessage(m);

  // ---------- model helpers ----------
  function node(key) { return key && S.model ? S.model.nodes[key] || null : null; }
  /** Follows $ref chains: the list of nodes whose children merge into this one (own first). */
  function chain(key) {
    const out = [];
    const seen = new Set();
    let k = key;
    while (k && !seen.has(k) && out.length < 20) {
      seen.add(k);
      const n = node(k);
      if (!n) break;
      out.push(n);
      k = n.ref && n.ref.k ? n.ref.k : null;
    }
    return out;
  }
  function typeText(key) {
    if (!key) return 'any';
    const c = chain(key);
    for (const n of c) {
      if (n.b === false) return 'never';
      if (n.t && n.t.length) {
        let t = n.t.join(' | ');
        if (n.t.length === 1 && n.t[0] === 'array') {
          const it = c.map((x) => x.it).find(Boolean);
          if (it) { const inner = typeText(it); t = `${inner.includes(' ') ? `(${inner})` : inner}[]`; }
        }
        return t;
      }
    }
    for (const n of c) {
      if (n.one) return `one of ${n.one.length}`;
      if (n.any) return `any of ${n.any.length}`;
      if (n.all) return `all of ${n.all.length}`;
      if (n.ref && n.ref.remote) return 'remote $ref';
      if (n.ref && n.ref.missing) return 'unresolved $ref';
    }
    return 'any';
  }
  function refName(n) {
    if (!n || !n.ref) return '';
    if (n.ref.k) {
      const t = node(n.ref.k);
      const segs = t ? t.p.split('/') : [];
      if (t && t.ti) return t.ti;
      if (segs.length && segs[segs.length - 1]) return decodeURIComponent(segs[segs.length - 1].replace(/~1/g, '/').replace(/~0/g, '~'));
      return S.model.files[t ? t.f : 0] ? S.model.files[t.f].name : n.ref.raw;
    }
    return n.ref.raw;
  }

  /** Child rows of a row: [{ label, key, req, kind }] */
  function children(row) {
    if (row.kind === 'defs') return (row.defs || []).map(([name, key, kw]) => ({ label: name, key, kind: 'def', kw }));
    const out = [];
    const c = chain(row.key);
    const seenProps = new Set();
    for (const n of c) {
      for (const [name, key, req] of n.props || []) { if (seenProps.has(name)) continue; seenProps.add(name); out.push({ label: name, key, req: !!req, kind: 'prop' }); }
    }
    for (const n of c) {
      for (const [pat, key] of n.pp || []) out.push({ label: `/${pat}/`, key, kind: 'pattern', kw: 1 });
      if (n.ap) out.push({ label: '(other keys)', key: n.ap, kind: 'additional', kw: 1 });
      (n.pi || []).forEach((key, i) => out.push({ label: `[${i}]`, key, kind: 'item', kw: 1 }));
      if (n.it) out.push({ label: '[items]', key: n.it, kind: 'items', kw: 1 });
      if (n.ai) out.push({ label: '[more items]', key: n.ai, kind: 'items', kw: 1 });
      if (n.ct) out.push({ label: '(contains)', key: n.ct, kind: 'contains', kw: 1 });
      if (n.pn) out.push({ label: '(key names)', key: n.pn, kind: 'names', kw: 1 });
      for (const [kw, word] of [['all', 'all of'], ['any', 'any of'], ['one', 'one of']]) (n[kw] || []).forEach((key, i) => out.push({ label: `${word} #${i + 1}`, key, kind: 'combo', kw: 1 }));
      for (const kw of ['not', 'if', 'then', 'else']) if (n[kw]) out.push({ label: kw, key: n[kw], kind: 'combo', kw: 1 });
      for (const [name, key] of n.ds || []) out.push({ label: `(when "${name}" is present)`, key, kind: 'combo', kw: 1 });
    }
    if (row.id === '0' && c[0] && c[0].defs && c[0].defs.length) out.push({ label: `Definitions (${c[0].defs.length})`, key: null, kind: 'defs', defs: c[0].defs, kw: 1 });
    return out;
  }
  const hasChildren = (row) => children(row).length > 0;
  function dataPathOf(parts) {
    let p = '';
    for (const r of parts) {
      if (r.kind === 'prop') p += (p ? '.' : '') + r.label;
      else if (r.kind === 'items') p += '[]';
      else if (r.kind === 'item') p += r.label;
      else if (r.kind === 'additional') p += (p ? '.' : '') + '*';
      else if (r.kind === 'pattern') p += (p ? '.' : '') + r.label;
      else if (r.kind === 'def') p = '#' + r.label;
      else if (r.kind === 'defs') p = '';
      else p += ` (${r.label})`;
    }
    return p || '(root)';
  }

  // ---------- rows ----------
  function rootRow() {
    const n = node(S.model.root);
    return { id: '0', label: (n && n.ti) || S.name, key: S.model.root, kind: 'root', depth: 0, parents: [] };
  }
  function visibleRows() {
    const out = [];
    const walk = (row) => {
      out.push(row);
      if (out.length > 20000) return;
      if (!S.expanded.has(row.id)) return;
      children(row).forEach((c, i) => walk({ ...c, id: `${row.id}/${i}`, depth: row.depth + 1, parents: row.parents.concat([row]) }));
    };
    if (S.model && S.model.root) walk(rootRow());
    return out;
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function draw() {
    const tree = $('tree');
    const rows = visibleRows();
    S.rows = rows;
    const frag = document.createDocumentFragment();
    rows.forEach((row, i) => {
      const n = node(row.key);
      const r = el('div', 'row' + (row.kw ? ' kw' : '') + (S.sel === row.id ? ' sel' : ''));
      r.dataset.i = String(i);
      r.dataset.id = row.id;
      r.setAttribute('role', 'treeitem');
      r.style.paddingLeft = (6 + row.depth * 16) + 'px';
      const kids = hasChildren(row);
      if (kids) r.setAttribute('aria-expanded', S.expanded.has(row.id) ? 'true' : 'false');
      r.appendChild(el('span', 'tw', kids ? (S.expanded.has(row.id) ? '▾' : '▸') : ''));
      r.appendChild(el('span', 'name', row.label));
      if (row.req) r.appendChild(el('span', 'req', 'required'));
      if (row.kind !== 'defs') r.appendChild(el('span', 'type', row.key ? typeText(row.key) : 'any'));
      if (n && n.ref) {
        const cls = n.ref.remote ? 'ref remote' : n.ref.missing ? 'ref missing' : 'ref';
        const ch = el('span', cls, n.ref.remote ? `remote $ref: ${n.ref.remote}` : n.ref.missing ? `$ref not found: ${n.ref.raw}` : `→ ${refName(n)}`);
        if (n.ref.remote) ch.title = 'Remote $ref addresses are never downloaded. Click to copy the address.';
        else if (n.ref.missing) ch.title = n.ref.missing;
        else { const t = node(n.ref.k); ch.title = `${n.ref.raw}${t && t.f !== n.f ? ` (in ${S.model.files[t.f].name})` : ''}`; }
        r.appendChild(ch);
      }
      const c = chain(row.key);
      if (c.some((x) => x.dep)) r.appendChild(el('span', 'dep', 'deprecated'));
      const cons = [];
      for (const x of c) for (const [l, v] of x.c || []) if (cons.length < 3 && !cons.some((y) => y.startsWith(l))) cons.push(`${l}: ${v.length > 40 ? v.slice(0, 39) + '…' : v}`);
      if (cons.length) r.appendChild(el('span', 'cons', cons.join('  ')));
      const desc = (c.find((x) => x.d) || {}).d || (c.find((x) => x.ti && row.kind !== 'root') || {}).ti || '';
      if (desc) r.appendChild(el('span', 'desc', desc.split('\n')[0]));
      frag.appendChild(r);
    });
    tree.textContent = '';
    tree.appendChild(frag);
    if (!rows.find((r) => r.id === S.sel)) S.sel = null;
    details();
  }
  function rowById(id) { return S.rows.find((r) => r.id === id) || null; }
  function select(id, scroll) {
    S.sel = id;
    for (const e of document.querySelectorAll('#tree .row.sel')) e.classList.remove('sel');
    const e = document.querySelector(`#tree .row[data-id="${CSS.escape(id)}"]`);
    if (e) { e.classList.add('sel'); if (scroll) e.scrollIntoView({ block: 'center' }); }
    details();
  }
  function toggle(id) { if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id); draw(); }
  function reveal(row) {
    const n = node(row && row.key);
    if (!n) return;
    post({ type: 'reveal', f: n.f, l: n.l });
  }

  // ---------- details ----------
  function details() {
    const d = $('details');
    d.textContent = '';
    const row = S.sel ? rowById(S.sel) : null;
    if (!row) { d.appendChild(el('p', 'empty', 'Select a row to see all of its rules. Double-click a row to open its line in the schema text.')); return; }
    const c = chain(row.key);
    const own = c[0];
    d.appendChild(el('h3', '', row.label));
    d.appendChild(el('div', 'dpath', dataPathOf(row.parents.concat([row]).slice(1))));
    const tbl = el('table');
    const tr = (k, v) => { const t = el('tr'); t.appendChild(el('td', '', k)); const td = el('td'); if (v instanceof Node) td.appendChild(v); else td.textContent = v; t.appendChild(td); tbl.appendChild(t); };
    if (row.kind !== 'defs') tr('type', row.key ? typeText(row.key) : 'any');
    if (row.req) tr('required', 'yes');
    const title = (c.find((x) => x.ti) || {}).ti;
    if (title) tr('title', title);
    const seen = new Set();
    for (const x of c) for (const [l, v] of x.c || []) { if (seen.has(l)) continue; seen.add(l); tr(l, v); }
    if (c.some((x) => x.dep)) tr('deprecated', 'yes');
    if (own && own.ref) {
      if (own.ref.k) {
        const t = node(own.ref.k);
        tr('$ref', `${own.ref.raw}${t && t.f !== own.f ? ` (${S.model.files[t.f].name})` : ''}`);
      } else if (own.ref.remote) tr('$ref', `${own.ref.remote} (remote, not downloaded)`);
      else tr('$ref', `${own.ref.raw}: ${own.ref.missing}`);
    }
    const desc = (c.find((x) => x.d) || {}).d;
    if (desc) d.appendChild(el('div', 'text', desc));
    if (tbl.childNodes.length) d.appendChild(tbl);
    const cm = (c.find((x) => x.cm) || {}).cm;
    if (cm) { d.appendChild(el('div', 'muted', '$comment')); d.appendChild(el('div', 'text', cm)); }
    const acts = el('div', 'acts');
    if (own) {
      const b = el('button', '', `Go to line ${own.l || 1}${own.f ? ` of ${S.model.files[own.f].name}` : ''}`);
      b.id = 'goLine';
      b.addEventListener('click', () => reveal(row));
      acts.appendChild(b);
    }
    if (own && own.ref && own.ref.k) {
      const t = node(own.ref.k);
      const b = el('button', '', `Go to the $ref target (line ${t ? t.l : 1}${t && t.f !== own.f ? ` of ${S.model.files[t.f].name}` : ''})`);
      b.id = 'goRef';
      b.addEventListener('click', () => post({ type: 'reveal', f: t.f, l: t.l }));
      acts.appendChild(b);
    }
    if (own && own.ref && own.ref.remote) {
      const b = el('button', '', 'Copy the address');
      b.addEventListener('click', () => post({ type: 'copy', text: own.ref.remote }));
      acts.appendChild(b);
    }
    if (acts.childNodes.length) d.appendChild(acts);
  }

  // ---------- search ----------
  function search(q) {
    S.q = q;
    const box = $('results');
    box.textContent = '';
    S.hits = [];
    if (!q) { box.hidden = true; $('hits').textContent = ''; return; }
    const ql = q.toLowerCase();
    const queue = [rootRow()];
    let visited = 0;
    const seenKeys = new Map();
    while (queue.length && visited < 20000 && S.hits.length < 300) {
      const row = queue.shift();
      visited++;
      if (row.id !== '0' && row.kind !== 'defs' && row.label.toLowerCase().includes(ql)) S.hits.push(row);
      if (row.depth >= 12) continue;
      // a schema reached again through another path is searched once
      const k = row.key ? row.key + '|' + row.kind : row.id;
      if ((seenKeys.get(k) || 0) >= 1 && row.key) continue;
      seenKeys.set(k, (seenKeys.get(k) || 0) + 1);
      children(row).forEach((c, i) => queue.push({ ...c, id: `${row.id}/${i}`, depth: row.depth + 1, parents: row.parents.concat([row]) }));
    }
    $('hits').textContent = S.hits.length ? `${S.hits.length}${S.hits.length >= 300 ? '+' : ''} found` : 'none found';
    for (const h of S.hits) {
      const e = el('div', 'hit');
      e.setAttribute('role', 'option');
      e.appendChild(el('span', 'name', h.label));
      e.appendChild(el('span', 'type', h.key ? typeText(h.key) : 'any'));
      e.appendChild(el('span', 'path', dataPathOf(h.parents.concat([h]).slice(1))));
      e.addEventListener('click', () => goTo(h));
      box.appendChild(e);
    }
    box.hidden = false;
  }
  function goTo(h) {
    for (const p of h.parents) S.expanded.add(p.id);
    draw();
    select(h.id, true);
    const e = document.querySelector(`#tree .row[data-id="${CSS.escape(h.id)}"]`);
    if (e) { e.classList.add('flash'); setTimeout(() => e.classList.remove('flash'), 1200); }
  }

  // ---------- banner and status ----------
  function banner(parts) {
    const b = $('banner');
    b.textContent = '';
    for (const p of parts) {
      const e = el('p', p.cls || '', p.text);
      if (p.button) { const btn = el('button', '', p.button.label); btn.id = p.button.id; btn.addEventListener('click', p.button.fn); e.appendChild(btn); }
      b.appendChild(e);
    }
    b.hidden = !parts.length;
  }
  let validation = null;
  function showBanner() {
    const parts = [];
    const info = S.model ? S.model.info : null;
    if (validation) parts.push(validation);
    if (info && !info.looksLikeSchema) parts.push({ cls: 'warn', text: 'This file does not look like a JSON Schema: no schema keywords at the top. To check it against a schema, validate it.', button: { id: 'validateThis', label: 'Validate this file...', fn: () => post({ type: 'validateThis' }) } });
    if (info && info.missing && info.missing.length) parts.push({ cls: 'err', text: `${info.missing.length} $ref could not be resolved: ${info.missing.slice(0, 3).map((m) => `${m.text} (line ${m.l})`).join('; ')}${info.missing.length > 3 ? '; ...' : ''}` });
    if (info && info.remote && info.remote.length) parts.push({ cls: 'muted', text: `${info.remote.length} remote $ref ${info.remote.length === 1 ? 'is' : 'are'} shown by address and never downloaded.` });
    if (info && info.truncated) parts.push({ cls: 'warn', text: `Very large schema: the first ${info.count.toLocaleString()} subschemas are shown.` });
    const errs = S.model ? S.model.files.filter((f, i) => i > 0 && f.error) : [];
    if (errs.length) parts.push({ cls: 'err', text: `Could not read: ${errs.slice(0, 3).map((f) => `${f.name} (${f.error})`).join('; ')}` });
    banner(parts);
  }

  // ---------- events ----------
  $('tree').addEventListener('click', (e) => {
    const r = e.target.closest('.row');
    if (!r) return;
    const row = S.rows[Number(r.dataset.i)];
    if (!row) return;
    if (e.target.closest('.ref.remote')) { const n = node(row.key); if (n && n.ref) post({ type: 'copy', text: n.ref.remote }); }
    if (e.target.classList.contains('tw')) { toggle(row.id); return; }
    select(row.id);
  });
  $('tree').addEventListener('dblclick', (e) => {
    const r = e.target.closest('.row');
    if (!r || e.target.classList.contains('tw')) return;
    const row = S.rows[Number(r.dataset.i)];
    if (row) reveal(row);
  });
  $('tree').addEventListener('keydown', (e) => {
    const i = S.rows.findIndex((r) => r.id === S.sel);
    const row = S.rows[i];
    if (e.key === 'ArrowDown' && i < S.rows.length - 1) { select(S.rows[i + 1].id, true); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && i > 0) { select(S.rows[i - 1].id, true); e.preventDefault(); }
    else if (e.key === 'ArrowRight' && row && hasChildren(row) && !S.expanded.has(row.id)) { toggle(row.id); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' && row && S.expanded.has(row.id)) { toggle(row.id); e.preventDefault(); }
    else if (e.key === 'Enter' && row) { reveal(row); e.preventDefault(); }
  });
  let qTimer = null;
  $('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => search($('q').value.trim()), 150); });
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && S.hits[0]) goTo(S.hits[0]); if (e.key === 'Escape') { $('q').value = ''; search(''); } });
  $('expandAll').addEventListener('click', () => {
    const add = (row, d) => { if (d > 3 || S.expanded.size > 3000) return; S.expanded.add(row.id); children(row).forEach((c, i) => add({ ...c, id: `${row.id}/${i}`, depth: row.depth + 1, parents: [] }, d + 1)); };
    if (S.model && S.model.root) add(rootRow(), 0);
    draw();
  });
  $('collapseAll').addEventListener('click', () => { S.expanded = new Set(['0']); draw(); });
  $('validateBtn').addEventListener('click', () => post({ type: 'validateFile' }));
  $('openText').addEventListener('click', () => post({ type: 'openText' }));
  $('errOpenText').addEventListener('click', () => post({ type: 'openText', line: S.errLine || 1 }));

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    S.msg++;
    if (m.type === 'load') {
      const first = !S.model;
      S.model = m.model;
      S.name = m.name;
      $('name').textContent = m.name;
      $('err').hidden = true;
      $('main').hidden = false;
      if (first) S.expanded = new Set(['0']);
      draw();
      if (first) { const r0 = S.rows[0]; if (r0) select(r0.id); }
      if (S.q) search(S.q);
      $('status').textContent = m.status || '';
      showBanner();
    } else if (m.type === 'error') {
      S.model = null;
      S.errLine = m.line || 1;
      $('name').textContent = m.name || '';
      $('errTitle').textContent = m.title || 'This file could not be read';
      $('errText').textContent = m.message + (m.line ? ` (line ${m.line}${m.col ? `, column ${m.col}` : ''})` : '');
      $('err').hidden = false;
      $('main').hidden = true;
      $('results').hidden = true;
      $('status').textContent = 'Fix the text and the docs redraw.';
      banner([]);
    } else if (m.type === 'validation') {
      validation = m.text ? { cls: m.ok ? 'ok' : 'warn', text: m.text } : null;
      showBanner();
    } else if (m.type === 'notice') {
      $('status').textContent = m.message;
    }
  });
  post({ type: 'ready' });
})();
