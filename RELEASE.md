# JSON Schema Viewer & Validator 0.1.0 (zovo.zovo-json-schema-viewer)

New listing, staged only. NICHE7 row 7, built by lane NEWB14.

- vsix: out/NEWB14-dist/zovo.zovo-json-schema-viewer/zovo.zovo-json-schema-viewer-0.1.0.vsix
- sha256: 736e7f405ff533a5c51e4a3abdcc7a979bafb04f4b219d846e700a33fcc277f9 (392,021 bytes, 52 files)
- Product repo: factory/products/json-schema-viewer-vscode, local commits only (no remote).
- Unit tests: 246 of 246 pass with `npm test` (scripts/test.js); `node --test` in the repo runs 248 of 248. They cover the JSON and YAML parsers with lines, the schema set (local $ref across files, web $id mapped to files next to the schema, the 2020-12 meta-schema with its 7 vocabulary files, remote $ref never read), the model, validation on drafts 04, 06, 07, 2019-09 and 2020-12 with real files, sample JSON, docs export, schema diff, the extension against a vscode stub (A-then-B for each Pro tool, Escape uses no try, a reload keeps the count, the count never goes down when the stored value reads stale), and the license and rating tests copied by apply.sh.
- Real-app gate: VS Code 1.142.0 on port 9457 through buildslot, run r1 on this exact vsix: 79 PASS, 0 FAIL (out/NEWB14-data/json-schema/schema-gate-r1.json and .tsv, screenshots in out/NEWB14-data/json-schema/shots/schema-r1-*.png). The earlier run dev1 (77 PASS, 1 FAIL) was on a dev build with a placeholder screenshot. Its one FAIL was in the gate: the check expected "files" where the extension correctly said "1 file".

## What it is

- Display name: JSON Schema Viewer & Validator (30 characters). The phrase "json schema" comes first, and the description starts with "JSON Schema viewer".
- Keywords: json schema, json, schema, validator, documentation. Engines: ^1.75.0, so it installs in Cursor and Windsurf.
- Free core:
  - A custom editor with priority "option" for *.schema.json, *.schema.yaml and *.schema.yml, so these files still open as text. A title-bar button shows on those files and on any JSON or YAML file whose $schema is a json-schema.org address. Any JSON or YAML file opens from the Command Palette.
  - The docs view: a property tree with type, required and deprecated marks, rules and descriptions, plus a details pane. $ref opens in place, also into other local files. Remote $ref addresses are shown, never downloaded, and a click copies the address.
  - Search, a double-click to the line in the text, and "Go to the $ref target".
  - Validation of JSON and YAML files with ajv 8. The schema comes from $schema, the jsonSchemaViewer.schemas setting, an earlier pick or a picker. Errors go to the Problems panel with path, line and rule. A schema file is checked against the meta-schema of its draft, which ships inside the extension. Files are checked again on save.
- Zovo Pro tools (1 free try each, module 2026-11-15.conv2 with TRIES_MAX 1, listing tag "jsonschema", tries key jsonSchemaViewer.proTrial, TRIAL_USES = 1 in src/pro.js, no triesMax in the proinfo JSON):
  - Generate sample JSON: one document with all fields, one with required fields only, or test data (1 to 1,000 documents). Each document is checked against the schema.
  - Export docs: one Markdown file or one HTML page with no scripts, with a section per object and links for every $ref.
  - Schema diff: a Markdown report against an older schema file, with breaking changes first.
- Nothing pops up on open. The webview CSP is default-src 'none' with nonce scripts. The extension makes no network calls. The Pro panel shows only after a click on a Pro tool with no tries left. Activation: onUri and onLanguage json, jsonc and yaml, plus the implicit customEditor and command events. No "*" and no onStartupFinished.
- Vendored: lib/vendor.js is one esbuild bundle of ajv 8.20.0, ajv-formats 3.0.1, ajv-draft-04 1.0.0, fast-deep-equal 3.1.3, json-schema-traverse 1.0.0 (all MIT), fast-uri 3.1.9 (BSD-3-Clause) and yaml 2.9.1 (ISC). lib/jsonc-parser is jsonc-parser 3.3.1 (MIT). All are listed in THIRD-PARTY-NOTICES.md. src/ is shipped as plain files, so src/license/*.js and src/rate.js are byte-identical to factory/sprint.

## Samples used

- Shipped: samples/shop (ours, made-up data). It has order.schema.json (2020-12, with $defs, oneOf, a deprecated field and a $ref to another file), address.schema.json, order.json (valid) and order-with-errors.yaml (11 errors).
- Unit-test fixtures (ours, not in the vsix): order-v1.schema.json (an older version for the diff), broken.schema.json and broken.yaml. In the gate, ORDER.SCHEMA.JSON is an upper-case copy.
- Real (tests and gate, not in the vsix, never executed; list in test/fixtures/real/SOURCES.txt):
  - SchemaStore (Apache-2.0): package.json, tsconfig.json (471 KB) and github-workflow.json schemas.
  - OAI OpenAPI-Specification (Apache-2.0): the OpenAPI 3.0 schema in YAML (draft-04), petstore.yaml and uspto.yaml.
  - actions/starter-workflows (MIT): ci/node.js.yml.
  - microsoft/vscode (MIT): src/tsconfig.json and extensions/git/package.json.
  - The JSON Schema 2020-12 meta-schema and its 7 vocabulary files, as shipped in ajv 8.20.0 (MIT).

## Gate coverage (r1)

- order.schema.json opens in the text editor by default, with no toast. The book button opens the docs beside it. The gate checks the status line, the 12 root rows, the row texts and the dark theme colors.
- In the tree, the gate opens lines, its $defs item and shipTo, which is a $ref to address.schema.json. It checks the details of price, search ("country" gives 2 hits, and a click opens the tree there), a double-click to the qty line in the text (the right line number), and "Go to the $ref target" into address.schema.json.
- 4 real schemas open as docs with their counts, no toast, and unchanged on disk: SchemaStore package (draft-07 with 9 remote $ref), tsconfig, GitHub workflow, and the OpenAPI 3.0 YAML (draft-04). Remote $ref rows show their address. A click copies it (the gate checked the clipboard, then put the old text back) and opens no URL. The 2020-12 meta-schema opens from the Command Palette with its 8 files, and "all of #1" opens meta/core.
- A broken schema shows "Comma expected at line 6, column 5" with no toast. A data file opened as docs shows the "does not look like a JSON Schema" banner, and its "Validate this file..." button reports the file valid.
- Validation: order-with-errors.yaml gives 11 errors in the Problems panel with path, rule and line. The real petstore.yaml is valid against the OpenAPI 3.0 schema (picked in the schema picker), node.js.yml against the GitHub workflow schema, and VS Code's Git extension package.json against the package schema (from the docs toolbar, which lists data files only). A schema file is checked against the bundled 2020-12 meta-schema. broken.yaml says "not valid YAML (line 1)".
- Right-click on ORDER.SCHEMA.JSON shows Open as JSON Schema Docs, Validate, and the 3 Zovo Pro entries.
- Each Pro tool runs on schema A, and its output is checked:
  - Sample: order.sample.json is written and opened, with id ORD-004211, sku values that fit the pattern, shipTo and payment.
  - Export: openapi-3.0.docs.html is written as one page with 74 sections, property tables, $ref links and no script.
  - Diff: the report against order-v1.schema.json says 5 breaking changes, 6 other changes and 1 text change, with the expected rows.
- Each try counts only after the result showed. The second use on schema B (another file) opens the Pro panel after the click and writes nothing:
  - sample: the Explorer entry on ORDER.SCHEMA.JSON
  - export: the toolbar row on address.schema.json
  - diff: the Command Palette on github-workflow.schema.json
- The info tab shows "no free tries left" for 2 tools and "1 free try left" for the third. After VS Code restarts, the row says "0 tries left" and the panel opens again. No URL was opened.
- At the end: no error toasts, no CSP errors, no webview network requests, no extension-host sockets, no webview console errors, no URL opened, and the sample files unchanged on disk.

## Defects found and fixed

- No product defect was found by the gate.
- Release fix: images/screenshot.png was a placeholder (a copy of the 128x128 icon). It is now the 1400x900 real-app shot from gate dev1 (schema-dev1-screenshot.png).
- Gate fixes, not product defects: the package.schema.json status check expected "files" and now accepts "1 file". The window title is now neutral, and a clipboard check (with restore) was added for the remote $ref click.

## Known limits

- Remote $ref are never downloaded. They count as "anything goes" during validation, and the result says how many were not checked.
- Only the first document of a multi-document YAML file is read. Files up to 50 MB.
- Files whose $schema is a meta-schema but whose name is not *.schema.json/yaml/yml get the title-bar button and the palette command, not the custom editor entry. VS Code selectors match names only.
- The 4th Pro idea in the row (code generation for TypeScript, Python and Go) is not built.
- The gate used VS Code's simple file dialog setting. The test-data mode (many documents) and the Markdown export were checked in unit tests, not in the gate.
