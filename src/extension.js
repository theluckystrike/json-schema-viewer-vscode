'use strict';
// JSON Schema Viewer & Validator by Zovo. Free core: a JSON Schema (draft-04, 06, 07, 2019-09, 2020-12; JSON or YAML)
// opens as readable docs, a property tree with types, required marks, defaults, enums, patterns, limits and
// descriptions, with $ref and $defs followed (also into other local files; a web address is never downloaded). Search
// properties, jump from a row to its schema line. Validate any JSON or YAML file against a local schema with ajv:
// every error in the Problems panel with its path, line and rule. The docs view is an optional editor: files keep
// opening as text. No network and no telemetry; nothing shows on activation. Pro tools (pro.js) ask only when used:
// sample JSON and test data, docs export, schema diff.
const vscode = require('vscode');
const { SchemaDocsProvider, VIEW_TYPE } = require('./viewer');
const { createTools } = require('./tools');
const { createValidator, DATA_RE } = require('./validator');
const { createIo } = require('./host');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createReach } = require('./reach');
const reachConfig = require('./reach-config');

const EXT_ID = 'zovo.zovo-json-schema-viewer';
const PREFIX = 'jsonSchemaViewer';
const SAMPLE_FILES = ['order.schema.json', 'address.schema.json', 'order.json', 'order-with-errors.yaml'];
const SCHEMA_NAME_RE = /\.schema\.(json|ya?ml)$/i;
const META_TEXT_RE = /["']?\$schema["']?\s*:\s*["']?https?:\/\/json-schema\.org\//;

let pro, reach, viewer, tools, validator, ctxRef;

function setting(key, dflt) { try { const v = vscode.workspace.getConfiguration(PREFIX).get(key, dflt); return v === undefined ? dflt : v; } catch (e) { return dflt; } }
const isSample = (uri) => !!(ctxRef && uri && uri.scheme === 'file' && (uri.fsPath.startsWith(ctxRef.extensionUri.fsPath) || (ctxRef.globalStorageUri && uri.fsPath.startsWith(ctxRef.globalStorageUri.fsPath))));
function refreshPro() { if (reach) reach.refresh(); }
const asUri = (a) => (a && a.scheme ? a : null);
const asOpts = (o) => (o && typeof o === 'object' && !Array.isArray(o) && !o.scheme ? o : {});

/** True when a text document is a JSON Schema by name or by its $schema (for the title bar button). */
function isSchemaDoc(doc) {
  if (!doc || !doc.uri) return false;
  if (SCHEMA_NAME_RE.test(doc.uri.path)) return true;
  if (!['json', 'jsonc', 'yaml'].includes(doc.languageId) && !DATA_RE.test(doc.uri.path)) return false;
  return META_TEXT_RE.test(doc.getText().slice(0, 65536));
}

function activate(context) {
  ctxRef = context;
  let rating = { success() {}, failure() {} };
  try { rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'JSON Schema Viewer' }); } catch (e) { /* rating is optional */ }
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  pro = createPro({ vscode, context });
  context.subscriptions.push(pro.onDidChange(() => refreshPro()));
  reach = createReach({ vscode, ...reachConfig, context, licensed: () => !!pro.licensed, shown: () => setting('showProTools', true) !== false });
  reach.registerCtx();
  const io = createIo();
  validator = createValidator({ context, io, setting });
  viewer = new SchemaDocsProvider(context, { io, rating, reach, isSample, validator });
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, viewer, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
  tools = createTools({ context, pro, viewer, io, refresh: refreshPro });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) refreshPro(); }));

  // the title bar button shows on schema files (by name or by a json-schema.org $schema)
  let ctxTimer = null;
  const updateCtx = () => {
    clearTimeout(ctxTimer);
    ctxTimer = setTimeout(() => {
      const ed = vscode.window.activeTextEditor;
      vscode.commands.executeCommand('setContext', `${PREFIX}.isSchema`, !!(ed && isSchemaDoc(ed.document)));
    }, 150);
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateCtx), vscode.workspace.onDidSaveTextDocument(updateCtx), { dispose: () => clearTimeout(ctxTimer) });
  updateCtx();

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...a) => {
    try { return await fn(...a); } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e).split('\n')[0]); return undefined; }
  }));
  const target = (uri) => {
    if (uri && uri.scheme) return uri;
    const ed = vscode.window.activeTextEditor;
    const vs = viewer.activeSession();
    if (vs && vs.panel.active) return vs.document.uri;
    if (ed && DATA_RE.test(ed.document.uri.path)) return ed.document.uri;
    if (ed && ['json', 'jsonc', 'yaml'].includes(ed.document.languageId)) return ed.document.uri;
    return vs ? vs.document.uri : null;
  };
  reg(`${PREFIX}.open`, async (uri) => {
    const u = target(asUri(uri));
    if (!u) { vscode.window.showInformationMessage('Open a JSON Schema file (JSON or YAML) first.'); return; }
    // from the title bar of the schema's text editor: the docs open next to it, the text tab stays
    const ed = vscode.window.activeTextEditor;
    const beside = !!(ed && ed.document.uri.toString() === u.toString());
    await vscode.commands.executeCommand('vscode.openWith', u, VIEW_TYPE, { preview: false, ...(beside ? { viewColumn: vscode.ViewColumn.Beside } : {}) });
  });
  reg(`${PREFIX}.openAsText`, async (uri) => {
    const u = asUri(uri) || viewer.activeUri();
    if (!u) { vscode.window.showInformationMessage('Open a schema in the JSON Schema docs first.'); return; }
    await vscode.commands.executeCommand('vscode.openWith', u, 'default', { viewColumn: vscode.ViewColumn.Beside, preview: false });
  });
  reg(`${PREFIX}.validate`, async (uri) => {
    const u = asUri(uri);
    const vs = viewer.activeSession();
    if (!u && vs && vs.panel.active) {
      // from a schema's docs view: pick the data file to check against it
      const r = await validator.validateWithSchema(vs.document.uri);
      if (r) vs.post({ type: 'validation', ok: r.valid, text: r.summary });
      return r || undefined;
    }
    const t = u || target(null);
    if (!t) { vscode.window.showInformationMessage('Open a JSON or YAML file first.'); return undefined; }
    return (await validator.validateFile(t, { ask: true })) || undefined;
  });
  reg(`${PREFIX}.chooseSchema`, async (uri) => {
    const t = asUri(uri) || target(null);
    if (!t) { vscode.window.showInformationMessage('Open a JSON or YAML file first.'); return undefined; }
    return (await validator.chooseSchema(t)) || undefined;
  });
  reg(`${PREFIX}.clearProblems`, () => { validator.diag.clear(); validator.validated.clear(); });
  reg(`${PREFIX}.openSample`, async () => {
    // A copy in the extension's storage, so the $ref between the files resolve and edits never touch the extension.
    const dst = vscode.Uri.joinPath(context.globalStorageUri, 'shop');
    await vscode.workspace.fs.createDirectory(dst);
    for (const f of SAMPLE_FILES) {
      const to = vscode.Uri.joinPath(dst, f);
      let there = true; try { await vscode.workspace.fs.stat(to); } catch (e) { there = false; }
      if (!there) await vscode.workspace.fs.writeFile(to, await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'samples', 'shop', f)));
    }
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(dst, 'order.schema.json'), VIEW_TYPE, { preview: false });
  });
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${PREFIX}.start`, false));
  reg(`${PREFIX}.sample`, reach.wrap((uri, opt) => tools.sampleTool(asUri(uri), asOpts(opt))));
  reg(`${PREFIX}.export`, reach.wrap((uri, opt) => tools.exportTool(asUri(uri), asOpts(opt))));
  reg(`${PREFIX}.diff`, reach.wrap((uri, opt) => tools.diffTool(asUri(uri), asOpts(opt))));
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  return { viewer: () => viewer, pro: () => pro, tools: () => tools, validator: () => validator };
}

function deactivate() {}

module.exports = { activate, deactivate, isSchemaDoc, _internal: { viewer: () => viewer, pro: () => pro, tools: () => tools, validator: () => validator } };
