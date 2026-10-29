// Data formats: schemas for well-known JSON files (package.json, tsconfig.json / jsconfig.json, .prettierrc, .eslintrc)
// through Monaco's JSON service, schema-based completion, hover and validation for well-known YAML files (GitHub Actions
// workflows, Docker Compose files, YAML .prettierrc / .eslintrc), and Reformat Code for YAML and XML. Everything is
// offline: the schemas are compact hand-written subsets in this folder (json-schemas.js, yaml-schemas.js), the YAML
// support is yaml.js and the XML formatter xml.js.
(() => {
  const monaco = ide.monaco;
  const { el, basename } = ide.util;
  const here = document.currentScript.src.replace(/[^/]*$/, '');

  // ---------- compact schema notation ----------
  // Helpers that build JSON Schema (draft 7 subset) objects. Monaco's JSON service reads them as they are, and yaml.js
  // understands the same subset: type, enum, pattern, properties, patternProperties, additionalProperties, items,
  // anyOf, description, default and examples (suggested values that are not enforced).
  const def = (description, x) => (description ? { description, ...x } : { ...x });
  const schema = {
    ANY: {},
    str: (d, x) => def(d, { type: 'string', ...x }),
    num: (d, x) => def(d, { type: 'number', ...x }),
    int: (d, x) => def(d, { type: 'integer', ...x }),
    bool: (d, dflt, x) => def(d, { type: 'boolean', ...(dflt !== undefined && { default: dflt }), ...x }),
    en: (d, values, x) => def(d, { enum: values, ...x }),
    // An object that also takes keys it does not list (tools add their own keys to package.json).
    obj: (d, properties, x) => def(d, { type: 'object', properties, ...x }),
    // An object whose keys are only the ones listed (and those of `x.patternProperties`).
    closed: (d, properties, x) => def(d, { type: 'object', properties, additionalProperties: false, ...x }),
    map: (d, value, x) => def(d, { type: 'object', additionalProperties: value, ...x }),
    arr: (d, items, x) => def(d, { type: 'array', items, ...x }),
    strs: (d, x) => def(d, { type: 'array', items: { type: 'string' }, ...x }),
    any: (d, ...anyOf) => def(d, { anyOf }),
    // Case-insensitive values (TypeScript's target, module, lib…): the canonical spellings complete, any case validates.
    ci: (d, values, x) => def(d, { anyOf: [{ enum: values }, { type: 'string', pattern: `^(?:${values.map((v) => v.replace(/[.]/g, '\\.').replace(/[a-z]/gi, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`)).join('|')})$` }], ...x }),
  };

  // ---------- JSON: Monaco's JSON service ----------
  // Monaco 0.57 has the JSON service under monaco.json (monaco.languages.json is a deprecated stub there).
  const jsonDefaults = monaco.json?.jsonDefaults || monaco.languages.json?.jsonDefaults;
  const jsonSchemas = new Map(); // uri -> {uri, fileMatch, schema}
  // Adds schemas to the ones already set (another plugin may have its own) and turns validation on. fileMatch patterns
  // are matched against the model's file URI (file:///c%3A/…/package.json) with "**/" in front.
  function addJsonSchemas(list) {
    if (!jsonDefaults) return;
    for (const s of list) jsonSchemas.set(s.uri, s);
    const cur = jsonDefaults.diagnosticsOptions || {};
    const others = (cur.schemas || []).filter((s) => !jsonSchemas.has(s.uri));
    jsonDefaults.setDiagnosticsOptions({ ...cur, validate: true, schemas: [...others, ...jsonSchemas.values()] });
  }
  // Monaco loads its JSON support when the first JSON model is created, so the first JSON file opened had no schemas,
  // completion or formatter for a moment (Ctrl+Alt+L right after opening it found none). A throwaway model loads it
  // at start.
  if (jsonDefaults) monaco.editor.createModel('', 'json', monaco.Uri.parse('inmemory://pyide/data-formats/warm-up.json')).dispose();

  // .prettierrc and .eslintrc have no extension and are either JSON or YAML: the first character tells.
  const SNIFFED = /^\.(prettierrc|eslintrc)$/i;
  function sniff(model) {
    if (model.uri.scheme !== 'file' || !SNIFFED.test(basename(model.uri.fsPath))) return;
    const text = model.getValue().replace(/^\uFEFF/, '').replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '');
    const want = !text || text[0] === '{' ? 'json' : 'yaml';
    if (model.getLanguageId() !== want) monaco.editor.setModelLanguage(model, want);
  }
  monaco.editor.getModels().forEach(sniff);
  monaco.editor.onDidCreateModel(sniff);

  // ---------- Reformat Code ----------
  // The formatters (yaml.js, xml.js) are Monaco DocumentFormattingEditProviders, which Reformat Code (Ctrl+Alt+L) runs.
  // A file they refuse to format would otherwise read "already properly formatted": Reformat Code asks this hook first,
  // which answers only with the reason, and leaves formatting to the providers.
  const refusals = new Map(); // language id -> (model, indentSize) -> reason string | null
  ide.on('ready', () => ide.tooling?.addFormatter?.((tab) => {
    const model = tab?.model;
    const why = model && !model.isDisposed() && refusals.get(model.getLanguageId())?.(model, indentOf(model));
    return why ? { error: why } : null;
  }));
  const indentOf = (model) => {
    const o = model.getOptions();
    return Math.max(1, Number(o.indentSize) || o.tabSize || 2);
  };
  // A whole-document edit, or none when the text is the same.
  function wholeEdit(model, text) {
    const old = model.getValue(monaco.editor.EndOfLinePreference.LF);
    return old === text ? [] : [{ range: model.getFullModelRange(), text }];
  }

  ide.dataFormats = { schema, addJsonSchemas, jsonSchemas, refusals, indentOf, wholeEdit, here };

  // The YAML engine and the XML formatter first, then the schemas that use them.
  for (const file of ['yaml.js', 'xml.js', 'json-schemas.js', 'yaml-schemas.js']) {
    const s = el('script');
    s.src = here + file;
    s.async = false;
    document.body.appendChild(s);
  }
})();
