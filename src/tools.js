'use strict';
// The three Zovo Pro tools. Each one checks the free try (src/pro.js) first, on every use, so the second use of a tool
// opens the Pro panel at once (before any pick), whatever schema it is used on. A try counts only after the tool
// showed its result.
//   sample: sample JSON (all fields or required only) or test data (many documents), checked against the schema
//   export: the docs as one Markdown file or one HTML page
//   diff:   this schema against an older version, breaking changes first, as a Markdown report
const vscode = require('vscode');
const { SchemaSet, looksLikeSchema } = require('./core/schemaset');
const { parseText } = require('./core/parse');
const V = require('./core/validate');
const { generateChecked } = require('./core/sample');
const { createDocModel, toMarkdown, toHtml } = require('./core/docs');
const { diffSets, diffMarkdown } = require('./core/diff');
const { urlOf } = require('./host');

const IGNORE = { ignoreFocusOut: true };
const SCHEMA_NAME_RE = /\.schema\.(json|ya?ml)$/i;
const DATA_RE = /\.(json|jsonc|json5|ya?ml)$/i;
const SCHEMA_GLOB = '**/*.{json,yaml,yml}';
const baseName = (u) => decodeURIComponent(String(u.path || u).split('/').pop());
const stem = (u) => baseName(u).replace(/\.(schema\.)?(json|jsonc|ya?ml)$/i, '') || 'schema';

function createTools({ context, pro, viewer, io, refresh }) {
  const isUri = (a) => !!(a && typeof a === 'object' && a.scheme && typeof a.path === 'string');
  async function exists(uri) { try { await vscode.workspace.fs.stat(uri); return true; } catch (e) { return false; } }
  async function uniqueFile(dir, base, ext) {
    let u = vscode.Uri.joinPath(dir, `${base}${ext}`);
    for (let i = 2; await exists(u); i++) u = vscode.Uri.joinPath(dir, `${base}-${i}${ext}`);
    return u;
  }
  const dirOf = (uri) => vscode.Uri.joinPath(uri, '..');
  async function textOf(uri) {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    return open ? open.getText() : io.read(urlOf(uri));
  }
  /** Workspace schema files: *.schema.json / .yaml first, then JSON or YAML files whose text says they are schemas. */
  async function schemaFiles(except) {
    let uris = [];
    try { uris = await vscode.workspace.findFiles(SCHEMA_GLOB, '**/{node_modules,.git}/**', 3000); } catch (e) { uris = []; }
    const out = [];
    for (const u of uris) {
      if (except && u.toString() === except.toString()) continue;
      if (SCHEMA_NAME_RE.test(u.path)) { out.push(u); continue; }
      try {
        const st = await vscode.workspace.fs.stat(u);
        if (st.size > 2 * 1024 * 1024) continue;
        const t = await io.read(urlOf(u));
        if (t && /json-schema\.org\//.test(t.slice(0, 4000))) out.push(u);
      } catch (e) { /* skip */ }
    }
    return out;
  }
  async function pickFile(uris, placeHolder) {
    const items = uris.map((u) => ({ label: baseName(u), description: vscode.workspace.asRelativePath(u, false), uri: u })).sort((a, b) => a.description.localeCompare(b.description));
    items.push({ label: 'Choose a file...', description: 'JSON or YAML', choose: true });
    const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, ...IGNORE });
    if (!pick) return null;
    if (!pick.choose) return pick.uri;
    const sel = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, openLabel: 'Use this file', filters: { 'JSON Schema': ['json', 'yaml', 'yml'] } });
    return sel && sel.length ? sel[0] : null;
  }
  /** The schema a tool works on: the clicked file, the active docs view, the active editor (when it is a schema), or a pick. */
  async function schemaTarget(arg, verb) {
    if (isUri(arg)) return arg;
    const vs = viewer.activeSession();
    if (vs && vs.panel.active) return vs.document.uri;
    const ed = vscode.window.activeTextEditor;
    if (ed && DATA_RE.test(ed.document.uri.path)) {
      const p = parseText(ed.document.getText(), baseName(ed.document.uri));
      if (!p.error && (SCHEMA_NAME_RE.test(ed.document.uri.path) || looksLikeSchema(p.value))) return ed.document.uri;
    }
    if (vs) return vs.document.uri;
    return pickFile(await schemaFiles(), `Pick the JSON Schema to ${verb}`);
  }
  async function loadSchema(uri) {
    const set = new SchemaSet(io);
    await set.load(urlOf(uri));
    const root = set.rootFile();
    if (!root || root.error) { vscode.window.showErrorMessage(`${baseName(uri)}: ${root && root.error ? root.error.message : 'could not be read'}`); return null; }
    if (root.value === null || typeof root.value !== 'object' && typeof root.value !== 'boolean') { vscode.window.showErrorMessage(`${baseName(uri)} is not a JSON Schema (it is not an object).`); return null; }
    return set;
  }
  async function writeAndOpen(dir, base, ext, text, language) {
    let uri = null;
    if (dir.scheme === 'file' || dir.scheme === 'vscode-userdata') {
      try { uri = await uniqueFile(dir, base, ext); await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8')); } catch (e) { uri = null; }
    }
    const doc = uri ? await vscode.workspace.openTextDocument(uri) : await vscode.workspace.openTextDocument({ content: text, language });
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    return { uri, doc };
  }

  // ---------- Generate sample JSON ----------
  async function sampleTool(arg, opt) {
    const o = (opt && typeof opt === 'object' && !Array.isArray(opt)) ? opt : {};
    if (!(await pro.allowed('sample', o))) return undefined;
    const schemaUri = await schemaTarget(arg, 'make a sample of');
    if (!schemaUri) return undefined;
    const set = await loadSchema(schemaUri);
    if (!set) return undefined;
    let mode = o.mode, count = o.count;
    if (!mode) {
      const pick = await vscode.window.showQuickPick([
        { label: 'One document with all fields', id: 'all', detail: 'Every property the schema lists, with example values' },
        { label: 'One document with required fields only', id: 'required', detail: 'The smallest document the schema accepts' },
        { label: 'Test data: many documents', id: 'many', detail: 'An array of documents with different values, each checked against the schema' },
      ], { placeHolder: `Sample JSON for ${baseName(schemaUri)}`, ...IGNORE });
      if (!pick) return undefined;
      mode = pick.id;
    }
    if (mode === 'many' && !count) {
      const v = await vscode.window.showInputBox({ prompt: 'How many documents? (1 to 1,000)', value: '20', ...IGNORE, validateInput: (t) => (/^\d+$/.test(t.trim()) && +t >= 1 && +t <= 1000 ? null : 'A whole number from 1 to 1,000') });
      if (v === undefined) return undefined;
      count = Number(v.trim());
    }
    const many = mode === 'many';
    const compiled = V.compileSet(set);
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Generating sample JSON' }, async () =>
      generateChecked(set, { mode: many ? 'all' : mode, count: many ? count || 20 : 1, draft: compiled.draft, check: compiled.validate || null }));
    const value = many ? r.docs : r.docs[0];
    const text = JSON.stringify(value, null, 2) + '\n';
    const base = `${stem(schemaUri)}.${many ? 'test-data' : mode === 'required' ? 'sample-required' : 'sample'}`;
    const out = await writeAndOpen(dirOf(schemaUri), base, '.json', text, 'json');
    const n = many ? r.docs.length : 1;
    const check = compiled.validate ? `${r.valid} of ${n} ${n === 1 ? 'passes' : 'pass'} the schema` : `not checked: ${compiled.error}`;
    // the result line first: the free-try line of pro.produced() then shows on top of it
    vscode.window.setStatusBarMessage(`Sample JSON: ${n} document${n === 1 ? '' : 's'} written${out.uri ? ` to ${baseName(out.uri)}` : ''}; ${check}.`, 12000);
    await pro.produced('sample');
    refresh();
    return { uri: out.uri, doc: out.doc, count: n, valid: r.valid, mode, checked: !!compiled.validate };
  }

  // ---------- Export docs ----------
  async function exportTool(arg, opt) {
    const o = (opt && typeof opt === 'object' && !Array.isArray(opt)) ? opt : {};
    if (!(await pro.allowed('export', o))) return undefined;
    const schemaUri = await schemaTarget(arg, 'export');
    if (!schemaUri) return undefined;
    const set = await loadSchema(schemaUri);
    if (!set) return undefined;
    let format = o.format;
    if (!format) {
      const pick = await vscode.window.showQuickPick([
        { label: 'Markdown (.md)', id: 'md', detail: 'For a README or a docs site; tables with links between sections' },
        { label: 'One HTML page (.html)', id: 'html', detail: 'A single page with its styles inside; no scripts, light and dark' },
      ], { placeHolder: `Export the docs of ${baseName(schemaUri)}`, ...IGNORE });
      if (!pick) return undefined;
      format = pick.id;
    }
    const model = createDocModel(set);
    const text = format === 'html' ? toHtml(model) : toMarkdown(model);
    const out = await writeAndOpen(dirOf(schemaUri), `${stem(schemaUri)}.docs`, format === 'html' ? '.html' : '.md', text, format === 'html' ? 'html' : 'markdown');
    vscode.window.setStatusBarMessage(`Export docs: ${model.sections.length} section${model.sections.length === 1 ? '' : 's'} written${out.uri ? ` to ${baseName(out.uri)}` : ''}.`, 12000);
    await pro.produced('export');
    refresh();
    return { uri: out.uri, doc: out.doc, sections: model.sections.length, format };
  }

  // ---------- Schema diff ----------
  async function diffTool(arg, opt) {
    const o = (opt && typeof opt === 'object' && !Array.isArray(opt)) ? opt : {};
    if (!(await pro.allowed('diff', o))) return undefined;
    const newUri = await schemaTarget(arg, 'compare');
    if (!newUri) return undefined;
    const oldUri = o.older || await pickFile(await schemaFiles(newUri), `Pick the older version to compare ${baseName(newUri)} with`);
    if (!oldUri) return undefined;
    const b = await loadSchema(newUri);
    if (!b) return undefined;
    const a = await loadSchema(oldUri);
    if (!a) return undefined;
    const d = diffSets(a, b);
    const md = diffMarkdown(d, baseName(oldUri), baseName(newUri));
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    vscode.window.setStatusBarMessage(`Schema diff: ${d.breaking.length} breaking, ${d.other.length} other change${d.other.length === 1 ? '' : 's'}.`, 12000);
    await pro.produced('diff');
    refresh();
    return { doc, breaking: d.breaking.length, other: d.other.length, text: d.text.length };
  }

  return { sampleTool, exportTool, diffTool, schemaTarget, schemaFiles };
}

module.exports = { createTools, SCHEMA_NAME_RE, DATA_RE };
