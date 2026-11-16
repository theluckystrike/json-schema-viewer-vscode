'use strict';
// REACH1: this listing's Pro tools for the viewer toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  prefix: 'jsonSchemaViewer',
  triesKey: 'jsonSchemaViewer.proTrial',
  slot: '.reach-slot',
  tools: [
    { id: 'sample', title: 'Generate sample JSON', command: 'jsonSchemaViewer.sample' },
    { id: 'export', title: 'Export docs', command: 'jsonSchemaViewer.export' },
    { id: 'diff', title: 'Schema diff', command: 'jsonSchemaViewer.diff' },
  ],
};
