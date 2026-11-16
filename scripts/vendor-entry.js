'use strict';
// Vendor entry: ajv 8 (drafts 06/07, 2019-09, 2020-12), ajv-draft-04, ajv-formats and yaml, bundled by esbuild.
const Ajv = require('ajv').default;
const Ajv2019 = require('ajv/dist/2019').default;
const Ajv2020 = require('ajv/dist/2020').default;
const AjvDraft04 = require('ajv-draft-04').default;
const addFormats = require('ajv-formats').default;
const draft06 = require('ajv/dist/refs/json-schema-draft-06.json');
const YAML = require('yaml');
module.exports = { Ajv, Ajv2019, Ajv2020, AjvDraft04, addFormats, draft06, YAML, versions: { ajv: require('ajv/package.json').version, ajvFormats: require('ajv-formats/package.json').version, ajvDraft04: require('ajv-draft-04/package.json').version, yaml: require('yaml/package.json').version } };
