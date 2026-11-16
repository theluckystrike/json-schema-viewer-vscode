'use strict';
// File access for the schema set in VS Code: the unsaved text of an open editor wins, else the workspace file system.
// Only local files are read; nothing is downloaded.
const vscode = require('vscode');
const { normUrl } = require('./core/schemaset');

function decode(buf) {
  const b = Buffer.from(buf);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.slice(2).toString('utf16le');
  return b.toString('utf8').replace(/^﻿/, '');
}

/** The address a SchemaSet uses for a VS Code uri (WHATWG form, so $ref resolve the same way in tests). */
function urlOf(uri) { return normUrl(uri.toString()); }
function uriOf(url) { return vscode.Uri.parse(url); }

function createIo() {
  return {
    async read(url) {
      if (!/^(file|vscode-[a-z-]+|untitled):/i.test(url)) return null;
      const uri = uriOf(url);
      const key = uri.toString();
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key || urlOf(d.uri) === url);
      if (open) return open.getText();
      try {
        const st = await vscode.workspace.fs.stat(uri);
        if (st.type === vscode.FileType.Directory) return null;
        if (st.size > 50 * 1024 * 1024) return null;
        return decode(await vscode.workspace.fs.readFile(uri));
      } catch (e) { return null; }
    },
  };
}

module.exports = { createIo, urlOf, uriOf, decode };
