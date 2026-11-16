'use strict';
// The JSON Schema docs view: a custom text editor, so the schema stays a normal VS Code text document and the docs
// redraw when the text changes (also when it is edited in a text editor next to it, or when a file it refers to
// changes). Registered with priority "option": schema files keep opening as text; the docs open through "Open as JSON
// Schema Docs" (title bar, Explorer, Command Palette) or Reopen Editor With. The view never writes the file.
const vscode = require('vscode');
const { SchemaSet } = require('./core/schemaset');
const { buildModel, stats } = require('./core/model');
const { docsHtml } = require('./html');
const { urlOf, uriOf } = require('./host');
const support = require('./support');

const VIEW_TYPE = 'jsonSchemaViewer.docs';
const PREFIX = 'jsonSchemaViewer';

/** Loads the schema set of a document: { set, model, error }. */
async function loadSet(io, uri) {
  const set = new SchemaSet(io);
  await set.load(urlOf(uri));
  const root = set.rootFile();
  if (!root || root.error) return { set, error: root ? root.error : { message: 'The file could not be read.', line: 0 } };
  return { set, model: buildModel(set), error: null };
}

function statusText(model) {
  const st = stats(model);
  const i = model.info;
  const parts = [`JSON Schema ${i.draft === '04' || i.draft === '06' || i.draft === '07' ? `draft-${i.draft}` : i.draft}${i.declared ? '' : ' (no $schema, guessed)'}`,
    `${st.props.toLocaleString()} propert${st.props === 1 ? 'y' : 'ies'}`, `${st.defs} definition${st.defs === 1 ? '' : 's'}`, `${st.files} file${st.files === 1 ? '' : 's'}`];
  if (i.remote.length) parts.push(`${i.remote.length} remote $ref not downloaded`);
  return parts.join(' · ');
}

class SchemaDocsProvider {
  constructor(ctx, hooks) {
    this.ctx = ctx;
    this.hooks = hooks; // { io, rating, reach, isSample(uri), validator }
    this.sessions = new Map();
    this.lastActive = null;
  }

  html(webview) {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    const reach = this.hooks.reach;
    return docsHtml({
      cspSource: webview.cspSource,
      media: (name) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...name.split('/'))).toString(),
      title: 'JSON Schema', showSupportLinks: support.showLinks(vscode, PREFIX),
      head: reach ? (n) => reach.headHtml(n) : undefined,
    });
  }

  webviewOptions() {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    const reach = this.hooks.reach;
    return { enableScripts: true, enableCommandUris: [...new Set([...support.commandUris(PREFIX), ...(reach ? reach.commandIds() : [])])], localResourceRoots: [media] };
  }

  async resolveCustomTextEditor(document, panel) {
    const key = document.uri.toString();
    const s = { document, panel, data: null, gen: 0, timer: null, counted: false, loaded: null, loadedResolve: null };
    s.loaded = new Promise((r) => { s.loadedResolve = r; });
    this.sessions.set(key, s);
    this.lastActive = s;
    const wv = panel.webview;
    wv.options = this.webviewOptions();
    wv.html = this.html(wv);
    const reach = this.hooks.reach;
    const subs = [];
    if (reach) subs.push(reach.attach(wv, panel));
    s.post = (m) => { try { const p = wv.postMessage(m); return p && p.then ? p.then(undefined, () => false) : Promise.resolve(true); } catch (e) { return Promise.resolve(false); } };
    subs.push(wv.onDidReceiveMessage((m) => this.onMessage(s, m)));
    const inSet = (u) => { const k = urlOf(u); return u.toString() === key || !!(s.data && s.data.set && s.data.set.files.has(k)); };
    subs.push(vscode.workspace.onDidChangeTextDocument((e) => { if (e.contentChanges.length && inSet(e.document.uri)) this.schedule(s); }));
    subs.push(vscode.workspace.onDidSaveTextDocument((d) => { if (d.uri.toString() !== key && inSet(d.uri)) this.schedule(s); }));
    if (panel.onDidChangeViewState) subs.push(panel.onDidChangeViewState(() => { if (panel.active) this.lastActive = s; if (panel.visible && reach) reach.refresh(); }));
    panel.onDidDispose(() => {
      clearTimeout(s.timer);
      for (const d of subs) { try { d.dispose(); } catch (e) { /* gone */ } }
      if (this.sessions.get(key) === s) this.sessions.delete(key);
      if (this.lastActive === s) this.lastActive = null;
    });
  }

  schedule(s) { clearTimeout(s.timer); s.timer = setTimeout(() => this.load(s), 350); }

  async load(s) {
    const gen = ++s.gen;
    let d;
    try { d = await loadSet(this.hooks.io, s.document.uri); } catch (e) { d = { error: { message: String((e && e.message) || e), line: 0 } }; }
    if (gen !== s.gen) return;
    const name = decodeURIComponent(s.document.uri.path.split('/').pop());
    if (d.error) {
      s.data = d.set ? { set: d.set } : null;
      s.post({ type: 'error', name, title: 'This file could not be read', message: d.error.message, line: d.error.line, col: d.error.col });
      if (!s.counted) { s.counted = true; if (this.hooks.rating) this.hooks.rating.failure(); }
      s.loadedResolve({ error: d.error.message });
      return;
    }
    s.data = d;
    s.post({ type: 'load', gen, name, model: d.model, status: statusText(d.model) });
    if (!s.counted) {
      s.counted = true;
      if (this.hooks.rating && !(this.hooks.isSample && this.hooks.isSample(s.document.uri))) this.hooks.rating.success(s.document.uri);
    }
    s.loadedResolve({ ok: true, nodes: Object.keys(d.model.nodes).length, files: d.model.files.length });
  }

  async onMessage(s, m) {
    const reach = this.hooks.reach;
    if (reach && reach.onMessage(m)) return;
    if (!m || typeof m !== 'object') return;
    try {
      switch (m.type) {
        case 'ready': await this.load(s); break;
        case 'reveal': await this.reveal(s, m.f, m.l); break;
        case 'openText': await this.openText(s.document.uri, m.line || 1); break;
        case 'copy': if (typeof m.text === 'string') { await vscode.env.clipboard.writeText(m.text); vscode.window.setStatusBarMessage(`Copied ${m.text}. Remote $ref addresses are never downloaded.`, 6000); } break;
        case 'validateFile': {
          const r = await this.hooks.validator.validateWithSchema(s.document.uri);
          if (r) s.post({ type: 'validation', ok: r.valid, text: r.summary });
          break;
        }
        case 'validateThis': {
          const r = await this.hooks.validator.validateFile(s.document.uri, { ask: true });
          if (r) s.post({ type: 'validation', ok: r.valid, text: r.summary });
          break;
        }
        default: break;
      }
    } catch (e) {
      s.post({ type: 'notice', message: String((e && e.message) || e).split('\n')[0] });
    }
  }

  async openText(uri, line) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = new vscode.Position(Math.max(0, (Number(line) || 1) - 1), 0);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false, selection: new vscode.Range(pos, pos) });
  }

  /** Opens the text of a file of the set next to the view, with the cursor on the line. */
  async reveal(s, f, line) {
    const file = s.data && s.data.model ? s.data.model.files[f] : null;
    if (!file) return;
    await this.openText(uriOf(file.url), line);
  }

  /** The session of the active (or last active) docs view. */
  activeSession() {
    for (const s of this.sessions.values()) if (s.panel.active) return s;
    return this.lastActive && this.sessions.has(this.lastActive.document.uri.toString()) ? this.lastActive : null;
  }
  activeUri() { const s = this.activeSession(); return s ? s.document.uri : null; }
}

module.exports = { SchemaDocsProvider, VIEW_TYPE, loadSet, statusText };
