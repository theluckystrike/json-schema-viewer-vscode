'use strict';
// Free validation: a JSON or YAML file against a local schema, with ajv on this computer. The schema comes from the
// file's own "$schema" (a local path, or a JSON Schema meta-schema address: then the file is checked as a schema), from
// the jsonSchemaViewer.schemas setting, from an earlier pick for that file, or from a picker. Every error goes to the
// Problems panel with its data path, its line and the schema rule that failed. Files validated in this window are
// checked again when they or their schema are saved. Remote schemas are never downloaded.
const vscode = require('vscode');
const { parseText } = require('./core/parse');
const { SchemaSet, resolveUrl, isMeta, isLocalUrl, looksLikeSchema } = require('./core/schemaset');
const V = require('./core/validate');
const { urlOf, uriOf } = require('./host');

const IGNORE = { ignoreFocusOut: true };
const DATA_RE = /\.(json|jsonc|json5|ya?ml)$/i;
const SCHEMA_GLOB = '**/*.{schema.json,schema.yaml,schema.yml,Schema.json,SCHEMA.JSON}';
const PICK_KEY = 'jsonSchemaViewer.picked';
const baseName = (u) => decodeURIComponent(String(u.path || u).split('/').pop());

/** A small glob matcher for fileMatch entries: *, **, ?, {a,b}; matched against the workspace-relative path. */
function globRe(g) {
  let s = String(g).trim().replace(/^\.\//, '');
  const anywhere = !s.includes('/');
  s = s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\{([^}]*)\}/g, (m, a) => `(${a.split(',').join('|')})`)
    .replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
  return new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${s}$`, 'i');
}

function createValidator({ context, io, setting }) {
  const diag = vscode.languages.createDiagnosticCollection('jsonSchemaViewer');
  context.subscriptions.push(diag);
  const validated = new Map(); // data uri string -> { schemaUri, files: [schema file urls] }
  const picked = () => ({ ...(context.workspaceState.get(PICK_KEY) || {}) });

  async function readDoc(uri) {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    return io.read(urlOf(uri));
  }
  async function exists(uri) { try { await vscode.workspace.fs.stat(uri); return true; } catch (e) { return false; } }

  async function pickSchema(dataUri, placeHolder) {
    let uris = [];
    try { uris = await vscode.workspace.findFiles(SCHEMA_GLOB, '**/{node_modules,.git}/**', 2000); } catch (e) { uris = []; }
    const items = uris.filter((u) => !dataUri || u.toString() !== dataUri.toString()).map((u) => ({ label: baseName(u), description: vscode.workspace.asRelativePath(u, false), uri: u }))
      .sort((a, b) => a.description.localeCompare(b.description));
    items.push({ label: 'Choose a schema file...', description: 'JSON or YAML', choose: true });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: placeHolder || `Pick the JSON Schema to check ${dataUri ? baseName(dataUri) : 'the file'} against`, matchOnDescription: true, ...IGNORE });
    if (!pick) return null;
    if (!pick.choose) return pick.uri;
    const sel = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, openLabel: 'Use this schema', filters: { 'JSON Schema': ['json', 'yaml', 'yml'] } });
    return sel && sel.length ? sel[0] : null;
  }

  /** The schema for a data file: { uri, via } or { meta: draft, via: '$schema' } or null. ask: show the picker. */
  async function findSchema(dataUri, parsed, ask) {
    const v = parsed && parsed.value;
    const declared = v && typeof v === 'object' && !Array.isArray(v) && typeof v.$schema === 'string' ? v.$schema.trim() : '';
    if (declared && isMeta(declared)) return { meta: V.metaDraft(declared), via: '$schema' };
    let remoteNote = '';
    if (declared) {
      const abs = resolveUrl(declared, urlOf(dataUri));
      if (isLocalUrl(abs)) {
        const u = uriOf(abs.split('#')[0]);
        if (await exists(u)) return { uri: u, via: '$schema' };
        remoteNote = `its $schema ${declared} was not found`;
      } else remoteNote = `its $schema ${declared} is a web address, which is never downloaded`;
    }
    const folder = vscode.workspace.getWorkspaceFolder ? vscode.workspace.getWorkspaceFolder(dataUri) : (vscode.workspace.workspaceFolders || [])[0];
    const rel = folder ? vscode.workspace.asRelativePath(dataUri, false) : baseName(dataUri);
    const list = setting('schemas', []);
    if (Array.isArray(list)) {
      for (const e of list) {
        if (!e || typeof e.url !== 'string' || !Array.isArray(e.fileMatch)) continue;
        if (!e.fileMatch.some((g) => typeof g === 'string' && globRe(g).test(rel.replace(/\\/g, '/')))) continue;
        if (/^[a-z][a-z0-9+.-]*:/i.test(e.url) && !/^file:/i.test(e.url)) continue; // web addresses are never fetched
        const base = folder ? folder.uri : vscode.Uri.joinPath(dataUri, '..');
        const u = /^file:/i.test(e.url) ? vscode.Uri.parse(e.url) : e.url.startsWith('/') ? vscode.Uri.file(e.url) : vscode.Uri.joinPath(base, e.url);
        if (await exists(u)) return { uri: u, via: 'setting' };
      }
    }
    const p = picked()[dataUri.toString()];
    if (p) { const u = vscode.Uri.parse(p); if (await exists(u)) return { uri: u, via: 'picked' }; }
    if (v && !declared && /\.schema\.(json|ya?ml)$/i.test(dataUri.path) && looksLikeSchema(v)) return { meta: '', via: 'schema file' };
    if (!ask) return null;
    const u = await pickSchema(dataUri, remoteNote ? `${baseName(dataUri)}: ${remoteNote}. Pick a local schema` : undefined);
    if (!u) return null;
    const m = picked(); m[dataUri.toString()] = u.toString();
    await context.workspaceState.update(PICK_KEY, m);
    return { uri: u, via: 'picked' };
  }

  function setDiagnostics(dataUri, errors, docText) {
    const lines = String(docText || '').split('\n');
    const list = errors.map((e) => {
      const l = Math.max(0, (e.line || 1) - 1);
      const c = Math.max(0, (e.col || 1) - 1);
      const end = Math.max(c + 1, (lines[l] || '').replace(/\r$/, '').length);
      const d = new vscode.Diagnostic(new vscode.Range(l, c, l, end), `${e.path}: ${e.message} (rule ${e.keyword} at ${e.schemaPath})`, vscode.DiagnosticSeverity.Error);
      d.source = 'JSON Schema';
      d.code = e.keyword;
      return d;
    });
    diag.set(dataUri, list);
  }

  /**
   * Validates one data file. o: { schemaUri, ask (show pickers), quiet (no message) }.
   * Returns { valid, errors, schemaName, summary, notChecked, parseError } or null when cancelled.
   */
  async function validateFile(dataUri, o = {}) {
    const name = baseName(dataUri);
    const text = await readDoc(dataUri);
    if (text === null || text === undefined) { if (!o.quiet) vscode.window.showErrorMessage(`${name} could not be read.`); return null; }
    const parsed = parseText(text, name);
    if (parsed.error) {
      const e = parsed.error;
      const l = Math.max(0, (e.line || 1) - 1);
      const d = new vscode.Diagnostic(new vscode.Range(l, Math.max(0, (e.col || 1) - 1), l, 10000), `Not valid ${parsed.kind === 'yaml' ? 'YAML' : 'JSON'}: ${e.message}`, vscode.DiagnosticSeverity.Error);
      d.source = 'JSON Schema';
      diag.set(dataUri, [d]);
      const summary = `${name} is not valid ${parsed.kind === 'yaml' ? 'YAML' : 'JSON'} (line ${e.line}): ${e.message}`;
      if (!o.quiet) vscode.window.showWarningMessage(summary);
      return { valid: false, errors: [], parseError: e, summary };
    }
    const found = o.schemaUri ? { uri: o.schemaUri, via: 'given' } : await findSchema(dataUri, parsed, o.ask !== false);
    if (!found) return null;
    let res, schemaName, files = [], notChecked = [];
    if (found.uri) {
      const set = new SchemaSet(io);
      await set.load(urlOf(found.uri));
      const root = set.rootFile();
      schemaName = baseName(found.uri);
      if (!root || root.error) {
        const summary = `The schema ${schemaName} could not be read: ${root && root.error ? root.error.message : 'unknown error'}`;
        if (!o.quiet) vscode.window.showErrorMessage(summary);
        return { valid: false, errors: [], schemaError: true, summary };
      }
      const compiled = V.compileSet(set);
      if (compiled.error) {
        const summary = `The schema ${schemaName} could not be compiled: ${compiled.error}`;
        if (!o.quiet) vscode.window.showErrorMessage(summary);
        return { valid: false, errors: [], schemaError: true, summary };
      }
      notChecked = compiled.notChecked;
      files = set.order;
      // a top-level "$schema" string in data names its schema; it is not data to check
      res = V.validateData(compiled, parsed, { dropSchemaKey: true });
      res.draft = compiled.draft;
    } else {
      res = V.validateAgainstMeta(parsed, found.meta || undefined);
      schemaName = `the JSON Schema ${res.draft === '04' || res.draft === '06' || res.draft === '07' ? `draft-${res.draft}` : res.draft} meta-schema`;
    }
    setDiagnostics(dataUri, res.errors, text);
    validated.set(dataUri.toString(), { schemaUri: found.uri || null, meta: found.uri ? null : (found.meta || ''), files });
    const n = res.errors.length + (res.more || 0);
    const tail = notChecked.length ? ` ${notChecked.length} remote $ref ${notChecked.length === 1 ? 'was' : 'were'} not checked (never downloaded).` : '';
    const summary = res.valid
      ? `${name} is valid against ${schemaName}.${tail}`
      : `${name}: ${n.toLocaleString()} error${n === 1 ? '' : 's'} against ${schemaName}. See the Problems panel.${tail}`;
    if (!o.quiet) {
      if (res.valid) vscode.window.showInformationMessage(summary);
      else { vscode.window.showWarningMessage(summary); try { await vscode.commands.executeCommand('workbench.actions.view.problems'); } catch (e) { /* no panel in tests */ } }
    }
    return { valid: res.valid, errors: res.errors, more: res.more || 0, schemaName, summary, notChecked, via: found.via };
  }

  /** From the docs view of a schema: pick a JSON or YAML file of the workspace and check it against that schema. */
  async function validateWithSchema(schemaUri, dataUri) {
    let target = dataUri;
    if (!target) {
      let uris = [];
      try { uris = await vscode.workspace.findFiles('**/*.{json,jsonc,yaml,yml}', '**/{node_modules,.git}/**', 3000); } catch (e) { uris = []; }
      const items = uris.filter((u) => u.toString() !== schemaUri.toString() && !/\.schema\.(json|ya?ml)$/i.test(u.path))
        .map((u) => ({ label: baseName(u), description: vscode.workspace.asRelativePath(u, false), uri: u })).sort((a, b) => a.description.localeCompare(b.description));
      items.push({ label: 'Choose a file...', description: 'JSON or YAML', choose: true });
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `Pick the JSON or YAML file to check against ${baseName(schemaUri)}`, matchOnDescription: true, ...IGNORE });
      if (!pick) return null;
      if (pick.choose) {
        const sel = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, openLabel: 'Validate', filters: { 'JSON and YAML': ['json', 'jsonc', 'yaml', 'yml'] } });
        if (!sel || !sel.length) return null;
        target = sel[0];
      } else target = pick.uri;
    }
    const m = picked(); m[target.toString()] = schemaUri.toString();
    await context.workspaceState.update(PICK_KEY, m);
    return validateFile(target, { schemaUri });
  }

  /** Picks the schema for a data file again (the picker every time) and validates. */
  async function chooseSchema(dataUri) {
    const u = await pickSchema(dataUri);
    if (!u) return null;
    const m = picked(); m[dataUri.toString()] = u.toString();
    await context.workspaceState.update(PICK_KEY, m);
    return validateFile(dataUri, { schemaUri: u });
  }

  /** On save: files validated in this window are checked again (also when one of their schema files is saved). */
  async function onSave(doc) {
    if (setting('validateOnSave', true) === false) return;
    const k = doc.uri.toString();
    const u = urlOf(doc.uri);
    for (const [x, v] of [...validated.entries()]) {
      if (x !== k && !(v.files || []).includes(u)) continue;
      try {
        const r = await validateFile(vscode.Uri.parse(x), { schemaUri: v.schemaUri || undefined, quiet: true, ask: false });
        if (r) vscode.window.setStatusBarMessage(`JSON Schema: ${r.summary}`, 8000);
      } catch (e) { /* keep the old results */ }
    }
  }
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((d) => { onSave(d); }));

  return { validateFile, validateWithSchema, chooseSchema, findSchema, onSave, diag, validated, DATA_RE };
}

module.exports = { createValidator, globRe, DATA_RE };
