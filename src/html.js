'use strict';
// Webview HTML for the JSON Schema docs view. Kept free of the vscode module so tests can check the CSP: no remote
// origin anywhere (default-src 'none'), scripts only with the page nonce, styles from the media folder or with the
// nonce, no inline style attributes (indents are set from the script).
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

const PREFIX = 'jsonSchemaViewer';

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function csp(cspSource, n) {
  return ["default-src 'none'", `style-src ${cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`, `img-src ${cspSource} data:`, `font-src ${cspSource}`].join('; ');
}

/** p: { cspSource, media(name) -> uri string, title, nonce?, showSupportLinks?, head?(nonce) } */
function docsHtml(p) {
  const n = p.nonce || crypto.randomBytes(24).toString('base64url');
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttr(p.media('docs.css'))}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${escapeAttr(p.title || 'JSON Schema')}</title>
</head>
<body>
<div id="app">
  <div id="toolbar" role="toolbar" aria-label="JSON Schema docs">
    <span id="name" class="chip" title="The opened file"></span>
    <input id="q" type="search" placeholder="Search properties" aria-label="Search property names in the schema and the files it uses" spellcheck="false">
    <span id="hits" class="muted"></span>
    <span class="grp"><button id="expandAll" title="Open the tree three levels deep">Expand</button><button id="collapseAll" title="Close every row">Collapse</button></span>
    <button id="validateBtn" title="Check a JSON or YAML file of this workspace against this schema; errors go to the Problems panel">Validate a file...</button>
    <button id="openText" title="Open the schema text next to the docs">Text</button>
    <span class="spacer"></span>
    <span class="reach-slot"></span>
  </div>
  <div id="banner" hidden></div>
  <div id="results" hidden role="listbox" aria-label="Search results"></div>
  <div id="main">
    <div id="treeWrap"><div id="tree" role="tree" tabindex="0" aria-label="Properties"></div></div>
    <aside id="details" aria-live="polite"></aside>
  </div>
  <div id="err" hidden><h2 id="errTitle">This file could not be read</h2><p id="errText"></p><p><button id="errOpenText">Open as text at the error</button></p></div>
  <div id="statusbar"><span id="status" class="muted">Reading the schema...</span></div>
  <div id="footer">${footer}</div>
</div>
<script nonce="${n}" src="${escapeAttr(p.media('docs.js'))}"></script>
</body>
</html>`;
}

module.exports = { docsHtml, csp, escapeAttr };
