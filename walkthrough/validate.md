# Validate JSON and YAML files

Right-click a JSON or YAML file and pick "Validate Against a JSON Schema". The schema comes from:

1. the file's own `$schema`, when it is a path to a schema on this computer;
2. the `jsonSchemaViewer.schemas` setting;
3. the schema you picked for that file before;
4. a picker with the schema files of the workspace.

Every error goes to the Problems panel with the data path, the line and the rule that failed. After a fix, save the file and it is checked again.

A file whose `$schema` is a json-schema.org address is a schema itself: it is checked against the meta-schema of its draft.
