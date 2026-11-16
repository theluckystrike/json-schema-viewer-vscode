'use strict';
// Validation with ajv 8 (MIT) on this computer: draft-04 (ajv-draft-04), draft-06 and draft-07 (Ajv), 2019-09
// (Ajv2019) and 2020-12 (Ajv2020), formats from ajv-formats. Every file of the schema set is added to ajv under its own
// address, so local $ref across files work. A remote $ref is never downloaded: it is taken as "anything goes" and the
// result says which addresses were not checked. Each error carries the data path, the line in the data file and the
// schema rule that failed.
const { Ajv, Ajv2019, Ajv2020, AjvDraft04, addFormats, draft06 } = require('../../lib/vendor.js');
const { effectiveDraft, isMeta, stripHash } = require('./schemaset');

const MAX_ERRORS = 1000;

function makeAjv(draft, opts = {}) {
  const o = { allErrors: true, strict: false, validateSchema: false, validateFormats: true, verbose: false, multipleOfPrecision: 9, ...opts };
  let ajv;
  if (draft === '04') ajv = new AjvDraft04(o);
  else if (draft === '2019-09') ajv = new Ajv2019(o);
  else if (draft === '2020-12') ajv = new Ajv2020(o);
  else { ajv = new Ajv(o); if (draft === '06') { try { ajv.addMetaSchema(draft06); } catch (e) { /* already there */ } } }
  addFormats(ajv);
  return ajv;
}

/** The meta-schema draft for a $schema address, or ''. */
function metaDraft(uri) {
  const u = String(uri || '');
  if (!isMeta(u)) return '';
  if (/draft-0[34]/.test(u)) return '04';
  if (/draft-06/.test(u)) return '06';
  if (/draft-07/.test(u)) return '07';
  if (/2019-09/.test(u)) return '2019-09';
  return '2020-12';
}
const META_IDS = {
  '04': 'http://json-schema.org/draft-04/schema', '06': 'http://json-schema.org/draft-06/schema', '07': 'http://json-schema.org/draft-07/schema',
  '2019-09': 'https://json-schema.org/draft/2019-09/schema', '2020-12': 'https://json-schema.org/draft/2020-12/schema',
};

/**
 * Compiles the root schema of a loaded SchemaSet. Returns { validate, draft, notChecked: [address], error }.
 */
function compileSet(set) {
  const root = set.rootFile();
  if (!root || root.value === undefined) return { error: root && root.error ? root.error.message : 'The schema could not be read.' };
  const { draft } = effectiveDraft(root.value);
  const notChecked = [];
  const attempt = (unicode) => {
    const ajv = makeAjv(draft, unicode ? {} : { unicodeRegExp: false });
    const added = new Set();
    for (const f of set.fileList()) {
      if (f.value === undefined || (typeof f.value !== 'object' && typeof f.value !== 'boolean')) continue;
      try { ajv.addSchema(f.value, f.url); added.add(f.url); } catch (e) { /* duplicate $id: the first file keeps it */ }
    }
    for (let i = 0; i < 300; i++) {
      try {
        let v = added.has(root.url) ? ajv.getSchema(root.url) : null;
        // a schema whose $id ajv already knows (the meta-schemas it ships): use that one
        if (!v && root.value && typeof root.value === 'object' && typeof root.value.$id === 'string') v = ajv.getSchema(root.value.$id);
        if (!v) return { error: 'The schema could not be compiled.' };
        return { validate: v, ajv };
      } catch (e) {
        const miss = e && (e.missingSchema || e.missingRef);
        if (!miss) return { error: String((e && e.message) || e).split('\n')[0], regex: /regular expression|Invalid regular|Invalid escape|Invalid group|Invalid property name|Lone quantifier/i.test(String(e && e.message)) };
        const doc = stripHash(String(e.missingSchema || e.missingRef));
        // A relative $ref resolved against a web $id: use the file next to the referring one when the set has it.
        const local = set.refs.find((r) => stripHash(r.abs) === doc && r.target && r.target.url && r.target.ptr !== undefined);
        if (local && !added.has(doc)) {
          const f = set.files.get(local.target.url);
          try { ajv.addSchema(f.value, doc); added.add(doc); continue; } catch (e2) { /* fall through */ }
        }
        if (added.has(doc)) return { error: `$ref ${e.missingRef || doc} could not be resolved.` };
        if (!notChecked.includes(doc)) notChecked.push(doc);
        try { ajv.addSchema(true, doc); added.add(doc); } catch (e2) { return { error: String((e2 && e2.message) || e2).split('\n')[0] }; }
      }
    }
    return { error: 'Too many $ref could not be resolved.' };
  };
  let r = attempt(true);
  if (r.error && r.regex) r = attempt(false);
  return { ...r, draft, notChecked };
}

/** Turns ajv errors into { path, message, keyword, schemaPath, line, col } with the line of each in the data. */
function mapErrors(errors, parsed) {
  const out = [];
  for (const e of (errors || []).slice(0, MAX_ERRORS)) {
    let ptr = e.instancePath || '';
    let loc = null;
    if (e.keyword === 'additionalProperties' && e.params && e.params.additionalProperty !== undefined) {
      const key = ptr + '/' + String(e.params.additionalProperty).replace(/~/g, '~0').replace(/\//g, '~1');
      loc = parsed && parsed.locateKey ? parsed.locateKey(key) : null;
      ptr = key;
    } else if (e.keyword === 'unevaluatedProperties' && e.params && e.params.unevaluatedProperty !== undefined) {
      const key = ptr + '/' + String(e.params.unevaluatedProperty).replace(/~/g, '~0').replace(/\//g, '~1');
      loc = parsed && parsed.locateKey ? parsed.locateKey(key) : null;
      ptr = key;
    }
    if (!loc && parsed && parsed.locate) {
      let p = e.instancePath || '';
      while (!loc) { loc = parsed.locate(p); if (loc || !p) break; p = p.slice(0, p.lastIndexOf('/')); }
    }
    let message = e.message || e.keyword;
    if (e.keyword === 'enum' && e.params && Array.isArray(e.params.allowedValues)) message += ': ' + e.params.allowedValues.slice(0, 12).map((v) => JSON.stringify(v)).join(', ') + (e.params.allowedValues.length > 12 ? ', …' : '');
    if (e.keyword === 'additionalProperties' && e.params) message += `: "${e.params.additionalProperty}"`;
    if (e.keyword === 'unevaluatedProperties' && e.params) message += `: "${e.params.unevaluatedProperty}"`;
    if (e.keyword === 'const' && e.params && 'allowedValue' in e.params) message += ': ' + JSON.stringify(e.params.allowedValue);
    out.push({ path: ptr || '/', message, keyword: e.keyword, schemaPath: e.schemaPath, line: loc ? loc.line : 1, col: loc ? loc.col : 1 });
  }
  return { list: out, more: Math.max(0, (errors || []).length - MAX_ERRORS) };
}

/**
 * Validates data (parsed: { value, locate, locateKey }) with a compiled set. dropSchemaKey: leave out the top-level
 * "$schema" of the data (it only names the schema). Returns { valid, errors: [...], more }.
 */
function validateData(compiled, parsed, { dropSchemaKey } = {}) {
  let data = parsed.value;
  if (dropSchemaKey && data && typeof data === 'object' && !Array.isArray(data) && '$schema' in data) { data = { ...data }; delete data.$schema; }
  const ok = compiled.validate(data);
  if (ok) return { valid: true, errors: [], more: 0 };
  const m = mapErrors(compiled.validate.errors, parsed);
  return { valid: false, errors: m.list, more: m.more };
}

/** Checks a schema document against its draft's meta-schema (built into ajv, no download). */
function validateAgainstMeta(parsed, draftHint) {
  const value = parsed.value;
  const draft = metaDraft(value && value.$schema) || draftHint || effectiveDraft(value).draft;
  const ajv = makeAjv(draft);
  const v = ajv.getSchema(META_IDS[draft]) || ajv.getSchema(META_IDS[draft] + '#');
  if (!v) return { valid: true, errors: [], more: 0, draft, skipped: true };
  const ok = v(value);
  if (ok) return { valid: true, errors: [], more: 0, draft };
  const m = mapErrors(v.errors, parsed);
  return { valid: false, errors: m.list, more: m.more, draft };
}

module.exports = { makeAjv, compileSet, validateData, validateAgainstMeta, mapErrors, metaDraft, META_IDS };
