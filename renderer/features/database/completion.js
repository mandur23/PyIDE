// Query console completions: schema-aware SQL with signature help, the MongoDB shell, and Redis commands and keys.
// Providers register per Monaco language but answer only for console models (completionHost.consoleFor), never for
// project files. Schema data is the tree the Database tool window loads (one cache, refreshed after DDL); a kind adds
// its own keywords, functions and data types through ui.completion, merged over the ANSI defaults below.
(() => {
  const monaco = ide.monaco;
  const host = ide.database.completionHost;
  const K = monaco.languages.CompletionItemKind;
  const SNIPPET = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  const list = (s) => s.split(/\s*,\s*/).filter(Boolean);
  const none = { suggestions: [] };

  // The statement around the caret: {before: its text up to the caret, full: all of it}, or null between statements.
  function statementAround(model, position, mode) {
    const text = model.getValue();
    const offset = model.getOffsetAt(position);
    const part = host.splitStatements(text, mode).find((p) => offset >= p.start && offset <= p.end);
    if (!part) return { before: '', full: '' };
    return { before: text.slice(part.start, offset), full: text.slice(part.start, part.end) };
  }
  const rangeFor = (position, word) => new monaco.Range(position.lineNumber, position.column - word.length, position.lineNumber, position.column);

  // ---------- SQL ----------
  const ANSI = {
    keywords: list(`SELECT, DISTINCT, FROM, WHERE, GROUP BY, HAVING, ORDER BY, ASC, DESC, LIMIT, OFFSET, AS, JOIN, INNER JOIN, LEFT JOIN,
      RIGHT JOIN, FULL JOIN, CROSS JOIN, ON, USING, UNION, UNION ALL, INTERSECT, EXCEPT, INSERT INTO, VALUES, UPDATE, SET, DELETE FROM,
      CREATE TABLE, CREATE VIEW, CREATE INDEX, ALTER TABLE, ADD COLUMN, DROP TABLE, DROP VIEW, DROP INDEX, PRIMARY KEY, FOREIGN KEY,
      REFERENCES, UNIQUE, CHECK, DEFAULT, NOT NULL, NULL, IS NULL, IS NOT NULL, AND, OR, NOT, IN, EXISTS, BETWEEN, LIKE, CASE, WHEN,
      THEN, ELSE, END, WITH, OVER, PARTITION BY, BEGIN, COMMIT, ROLLBACK, TRUE, FALSE`),
    functions: ['COUNT(expression)', 'SUM(expression)', 'AVG(expression)', 'MIN(expression)', 'MAX(expression)', 'COALESCE(value1, value2[, ...])',
      'NULLIF(value1, value2)', 'CAST(expression AS type)', 'UPPER(string)', 'LOWER(string)', 'SUBSTRING(string FROM start[ FOR length])',
      'TRIM([LEADING | TRAILING | BOTH] [characters FROM] string)', 'CHAR_LENGTH(string)', 'POSITION(substring IN string)', 'ABS(number)',
      'ROUND(number[, digits])', 'FLOOR(number)', 'CEIL(number)', 'MOD(dividend, divisor)', 'EXTRACT(field FROM source)', 'CURRENT_DATE',
      'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'ROW_NUMBER()', 'RANK()', 'DENSE_RANK()', 'LAG(expression[, offset[, default]])',
      'LEAD(expression[, offset[, default]])', 'FIRST_VALUE(expression)', 'LAST_VALUE(expression)']
      .map((signature) => ({ name: signature.match(/^\w+/)[0], signature })),
    dataTypes: list('INTEGER, SMALLINT, BIGINT, DECIMAL, NUMERIC, REAL, DOUBLE PRECISION, FLOAT, CHAR, VARCHAR, BOOLEAN, DATE, TIME, TIMESTAMP, INTERVAL, BLOB'),
  };
  // Words that must be quoted as identifiers.
  const RESERVED = new Set(list(`ALL, ALTER, AND, ANY, AS, ASC, BETWEEN, BY, CASE, CHECK, COLUMN, CONSTRAINT, CREATE, CROSS, CURRENT_DATE,
    CURRENT_TIME, CURRENT_TIMESTAMP, DEFAULT, DELETE, DESC, DISTINCT, DROP, ELSE, END, EXCEPT, EXISTS, FALSE, FOR, FOREIGN, FROM, FULL,
    GRANT, GROUP, HAVING, IN, INDEX, INNER, INSERT, INTERSECT, INTO, IS, JOIN, KEY, LEFT, LIKE, LIMIT, NOT, NULL, OFFSET, ON, OR, ORDER,
    OUTER, PRIMARY, REFERENCES, RIGHT, SELECT, SET, TABLE, THEN, TO, TRUE, UNION, UNIQUE, UPDATE, USER, USING, VALUES, VIEW, WHEN, WHERE, WITH`));
  const CLAUSE = /\b(WHERE|ON|SET|VALUES|SELECT|GROUP|ORDER|HAVING|LIMIT|USING|UNION|AND|OR|LEFT|RIGHT|INNER|OUTER|CROSS|FULL|NATURAL|JOIN|WINDOW|RETURNING)\b|[()=<>]/i;
  const NOT_ALIAS = new Set(list(`WHERE, ON, JOIN, LEFT, RIGHT, INNER, OUTER, FULL, CROSS, NATURAL, GROUP, ORDER, HAVING, LIMIT, SET, VALUES,
    USING, UNION, EXCEPT, INTERSECT, WINDOW, AS, SELECT, OFFSET, FETCH, RETURNING, DEFAULT, LATERAL, TABLESAMPLE, WITH`));
  const IDENT = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$#]*)';
  const unquote = (s) => (/^["`[]/.test(s) ? s.slice(1, -1) : s);
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();

  // Removes string literals and comments so clause detection ignores them; `open` when the text ends inside one.
  function scrub(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
      if (text.startsWith('--', i)) { const e = text.indexOf('\n', i); if (e < 0) return { text: out, open: true }; i = e; continue; }
      if (text.startsWith('/*', i)) { const e = text.indexOf('*/', i + 2); if (e < 0) return { text: out, open: true }; out += ' '; i = e + 2; continue; }
      if (text[i] === "'") {
        let j = i + 1;
        while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
        if (j >= text.length) return { text: out, open: true };
        out += "''";
        i = j + 1;
        continue;
      }
      out += text[i++];
    }
    return { text: out, open: false };
  }

  // Table references of a statement: [{parts: [schema?, table], alias}], from FROM lists, JOINs, UPDATE and INTO.
  function tableRefs(sql) {
    const refs = [];
    const name = `(${IDENT}(?:\\s*\\.\\s*${IDENT})?)`;
    const alias = `(?:\\s+(?:AS\\s+)?(${IDENT}))?`;
    const head = new RegExp(`\\b(FROM|JOIN|UPDATE|INTO)\\s+${name}${alias}`, 'gi');
    const more = new RegExp(`\\s*,\\s*${name}${alias}`, 'iy');
    const add = (n, a) => {
      const parts = n.split(/\s*\.\s*/).map(unquote);
      refs.push({ parts, alias: a && !NOT_ALIAS.has(a.toUpperCase()) ? unquote(a) : null });
    };
    for (let m; (m = head.exec(sql));) {
      if (m[3] && NOT_ALIAS.has(m[3].toUpperCase())) head.lastIndex = m.index + m[0].length - m[3].length;
      add(m[2], m[3]);
      if (m[1].toUpperCase() !== 'FROM') continue;
      more.lastIndex = head.lastIndex;
      for (let n; (n = more.exec(sql));) { add(n[1], n[2]); head.lastIndex = more.lastIndex; }
    }
    return refs;
  }

  // Schemas -> tables with columns, as the tree holds them for SQL kinds.
  const schemasOf = (tree) => tree.filter((n) => Array.isArray(n.children));
  const tablesOf = (schema) => schema.children.filter((t) => Array.isArray(t.columns));
  function findTable(tree, parts, implicit) {
    const [table, schema] = [...parts].reverse();
    const candidates = schemasOf(tree).filter((s) => (schema ? same(s.name, schema) : true))
      .sort((a, b) => Number(implicit.includes(b.name)) - Number(implicit.includes(a.name)));
    for (const s of candidates) {
      const t = tablesOf(s).find((x) => same(x.name, table));
      if (t) return { schema: s.name, table: t };
    }
    return null;
  }

  function sqlCompletion(c) {
    const merge = (a = [], b = [], key = (x) => x.toUpperCase()) => [...new Map([...a, ...b].map((x) => [key(x), x])).values()];
    const own = c.completion || {};
    return {
      keywords: merge(ANSI.keywords, own.keywords),
      functions: merge(ANSI.functions, own.functions, (f) => f.name.toUpperCase()),
      dataTypes: merge(ANSI.dataTypes, own.dataTypes),
    };
  }

  async function provideSql(model, position) {
    const c = host.consoleFor(model);
    if (!c || c.ui.language !== 'sql') return none;
    const { before, full } = statementAround(model, position, c.ui.statementSeparator);
    const clean = scrub(before);
    if (clean.open) return none;
    const word = clean.text.match(/[\w$#]*$/)[0];
    const rest = clean.text.slice(0, clean.text.length - word.length);
    const range = rangeFor(position, word);
    const quote = c.driver.quote || '"';
    const implicit = c.driver.implicitSchemas || [];
    const ident = (n) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !RESERVED.has(n.toUpperCase()) ? n : `${quote}${n.split(quote).join(quote + quote)}${quote}`);
    const tree = await host.tree(c.id);
    // The word being typed right after a table name is not its alias yet (FROM users WH|).
    const refs = tableRefs(scrub(full).text).map((r) => (r.alias && r.alias === word && /\s$/.test(rest) ? { ...r, alias: null } : r));
    const items = [];
    const push = (label, kind, insertText, sortText, extra = {}) => items.push({ label, kind, insertText, sortText, range, ...extra });
    const columnItems = (found, rank) => {
      for (const [i, col] of found.table.columns.entries()) {
        push({ label: col.name, detail: col.type ? ` ${col.type.toLowerCase()}` : '', description: found.table.name }, K.Field, ident(col.name), `${rank}${found.table.name}\u0000${String(i).padStart(4, '0')}`,
          { detail: `${tr('column')} · ${found.table.name}`, filterText: col.name });
      }
    };
    const tableItems = (rank, { qualify = true, only = null } = {}) => {
      for (const s of schemasOf(tree)) {
        if (only && !same(s.name, only)) continue;
        for (const t of tablesOf(s)) {
          const qualified = qualify && !implicit.includes(s.name) && schemasOf(tree).length > 1;
          push({ label: t.name, description: s.name }, t.kind === 'view' ? K.Interface : K.Class, qualified ? `${ident(s.name)}.${ident(t.name)}` : ident(t.name), `${rank}${t.name}`,
            { detail: t.kind === 'view' ? tr('view') : tr('table'), filterText: t.name });
        }
      }
    };

    // `qualifier.` : a schema's tables, or a table's / alias's columns.
    const qualified = rest.match(new RegExp(`(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})\\s*\\.\\s*$`));
    if (qualified) {
      const q = unquote(qualified[2]);
      const outer = qualified[1] && unquote(qualified[1]);
      const ref = !outer && refs.find((r) => r.alias && same(r.alias, q));
      const found = ref ? findTable(tree, ref.parts, implicit) : findTable(tree, outer ? [outer, q] : [q], implicit);
      if (found) columnItems(found, 0);
      else if (!outer && schemasOf(tree).some((s) => same(s.name, q))) tableItems(0, { qualify: false, only: q });
      return { suggestions: items };
    }

    // After FROM / JOIN / UPDATE / INTO (or a comma in a FROM list): tables and views.
    const fromList = rest.match(/\bFROM\s+([^;]*),\s*$/i);
    if (/\b(FROM|JOIN|UPDATE|INTO|TABLE)\s+$/i.test(rest) || (fromList && !CLAUSE.test(fromList[1]))) {
      tableItems(0);
      for (const s of schemasOf(tree)) if (!implicit.includes(s.name) && schemasOf(tree).length > 1) push(s.name, K.Module, ident(s.name), `1${s.name}`, { detail: tr('schema') });
      return { suggestions: items };
    }

    // Elsewhere: columns of the statement's tables first, then aliases, keywords, functions, other tables, types, snippets.
    const seen = new Set();
    for (const r of refs) {
      const found = findTable(tree, r.parts, implicit);
      if (!found || seen.has(found.table)) continue;
      seen.add(found.table);
      columnItems(found, 0);
      if (r.alias) push(r.alias, K.Variable, r.alias, `1${r.alias}`, { detail: `${tr('alias')} · ${found.table.name}` });
    }
    const lists = sqlCompletion(c);
    const upper = /^[a-z]/.test(word) ? (s) => s.toLowerCase() : (s) => s;
    for (const kw of lists.keywords) push(upper(kw), K.Keyword, upper(kw), `2${kw}`, { detail: tr('keyword') });
    for (const f of lists.functions) {
      const call = f.signature?.includes('(');
      push({ label: f.name, detail: call ? f.signature.slice(f.name.length) : '' }, K.Function, call ? `${f.name}($0)` : f.name, `3${f.name}`,
        { detail: f.signature || f.name, documentation: f.doc, insertTextRules: SNIPPET, filterText: f.name, command: call ? { id: 'editor.action.triggerParameterHints' } : undefined });
    }
    tableItems(4);
    for (const t of lists.dataTypes) push(t, K.TypeParameter, t, `5${t}`, { detail: tr('data type') });
    const snippets = [
      ['SELECT … FROM', 'SELECT ${1:*}\nFROM ${2:table}$0', tr('Select rows from a table')],
      ['INSERT INTO … VALUES', 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})$0', tr('Insert a row')],
      ['UPDATE … SET … WHERE', 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition}$0', tr('Update matching rows')],
      ['JOIN … ON', 'JOIN ${1:table} ON ${2:condition}$0', tr('Join another table')],
    ];
    for (const [label, body, doc] of snippets) push(label, K.Snippet, body, `6${label}`, { detail: tr('snippet'), documentation: doc, insertTextRules: SNIPPET, filterText: label.split(' ')[0] });
    return { suggestions: items };
  }

  // Signature help for the function call around the caret, from the merged function lists.
  function sqlSignature(model, position) {
    const c = host.consoleFor(model);
    if (!c || c.ui.language !== 'sql') return null;
    const { before } = statementAround(model, position, c.ui.statementSeparator);
    const clean = scrub(before);
    if (clean.open) return null;
    let depth = 0;
    let commas = 0;
    for (let i = clean.text.length - 1; i >= 0; i--) {
      const ch = clean.text[i];
      if (ch === ')') depth++;
      else if (ch === ',' && depth === 0) commas++;
      else if (ch === '(') {
        if (depth > 0) { depth--; continue; }
        const name = clean.text.slice(0, i).match(/(\w+)\s*$/)?.[1];
        const f = name && sqlCompletion(c).functions.find((x) => same(x.name, name) && x.signature?.includes('('));
        if (!f) return null;
        const open = f.signature.indexOf('(');
        const inner = f.signature.slice(open + 1, f.signature.lastIndexOf(')'));
        const params = [];
        let level = 0;
        let from = 0;
        for (let k = 0; k <= inner.length; k++) {
          if (inner[k] === '[') level++;
          else if (inner[k] === ']') level--;
          if (k === inner.length || (inner[k] === ',' && level === 0)) {
            const seg = inner.slice(from, k);
            const at = open + 1 + from + (seg.length - seg.trimStart().length);
            if (seg.trim()) params.push({ label: [at, at + seg.trim().length] });
            from = k + 1;
          }
        }
        return { value: { signatures: [{ label: f.signature, parameters: params }], activeSignature: 0, activeParameter: Math.min(commas, Math.max(0, params.length - 1)) }, dispose() {} };
      }
    }
    return null;
  }

  monaco.languages.registerCompletionItemProvider('sql', { triggerCharacters: ['.', ' '], provideCompletionItems: provideSql });
  monaco.languages.registerSignatureHelpProvider('sql', { signatureHelpTriggerCharacters: ['(', ','], provideSignatureHelp: sqlSignature });

  // ---------- MongoDB shell ----------
  const MONGO = {
    db: [['getCollection', '(name)', 'getCollection(${1:name})', tr('Use a collection by name')], ['getSiblingDB', '(name)', 'getSiblingDB(${1:name})', tr('Use another database')],
      ['runCommand', '(command)', 'runCommand({${1}})', tr('Run a database command')], ['adminCommand', '(command)', 'adminCommand({${1}})', tr('Run a command on the admin database')],
      ['getCollectionNames', '()', 'getCollectionNames()', tr('List the collection names')], ['createCollection', '(name)', "createCollection('${1}')", tr('Create a collection')],
      ['dropDatabase', '()', 'dropDatabase()', tr('Drop the current database')], ['stats', '()', 'stats()', tr('Statistics of the current database')],
      ['getName', '()', 'getName()', tr('Name of the current database')]],
    collection: [['find', '(filter, projection)', 'find({${1}})', tr('Find the documents matching a filter')], ['findOne', '(filter, projection)', 'findOne({${1}})', tr('Find the first matching document')],
      ['countDocuments', '(filter)', 'countDocuments({${1}})', tr('Count the documents matching a filter')], ['estimatedDocumentCount', '()', 'estimatedDocumentCount()', tr('Estimate the document count from metadata')],
      ['distinct', '(field, filter)', "distinct('${1}')", tr('List the distinct values of a field')], ['aggregate', '(pipeline)', 'aggregate([\n\t{${1}}\n])', tr('Run an aggregation pipeline')],
      ['insertOne', '(document)', 'insertOne({${1}})', tr('Insert one document')], ['insertMany', '(documents)', 'insertMany([{${1}}])', tr('Insert several documents')],
      ['updateOne', '(filter, update)', 'updateOne({${1}}, {\\$set: {${2}}})', tr('Update the first matching document')], ['updateMany', '(filter, update)', 'updateMany({${1}}, {\\$set: {${2}}})', tr('Update every matching document')],
      ['replaceOne', '(filter, replacement)', 'replaceOne({${1}}, {${2}})', tr('Replace the first matching document')], ['deleteOne', '(filter)', 'deleteOne({${1}})', tr('Delete the first matching document')],
      ['deleteMany', '(filter)', 'deleteMany({${1}})', tr('Delete every matching document')], ['createIndex', '(keys, options)', 'createIndex({${1}: 1})', tr('Create an index')],
      ['getIndexes', '()', 'getIndexes()', tr("List the collection's indexes")], ['dropIndex', '(name)', "dropIndex('${1}')", tr('Drop an index')], ['drop', '()', 'drop()', tr('Drop the collection')]],
    cursor: [['sort', '(spec)', 'sort({${1}: 1})', tr('Sort the results')], ['limit', '(n)', 'limit(${1:200})', tr('Return at most n documents')], ['skip', '(n)', 'skip(${1})', tr('Skip the first n documents')],
      ['project', '(spec)', 'project({${1}: 1})', tr('Choose the fields to return')], ['hint', '(index)', 'hint({${1}: 1})', tr('Use a specific index')],
      ['maxTimeMS', '(ms)', 'maxTimeMS(${1:1000})', tr('Stop after a time limit')], ['collation', '(spec)', "collation({locale: '${1:en}'})", tr('Compare strings with a collation')],
      ['toArray', '()', 'toArray()', tr('Return every document')]],
  };
  const QUERY_OPS = list('$eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $exists, $type, $regex, $options, $and, $or, $nor, $not, $elemMatch, $size, $all, $expr, $mod, $text');
  const UPDATE_OPS = list('$set, $unset, $inc, $mul, $rename, $min, $max, $currentDate, $setOnInsert, $push, $pull, $addToSet, $pop, $pullAll');
  const STAGES = list('$match, $group, $project, $sort, $limit, $skip, $unwind, $lookup, $addFields, $set, $unset, $count, $facet, $bucket, $sample, $replaceRoot, $sortByCount, $out, $merge');
  const ACCUMULATORS = list('$sum, $avg, $min, $max, $first, $last, $push, $addToSet, $count');
  const LOOKUP = list('from, localField, foreignField, as, let, pipeline');
  const FILTER_METHODS = new Set(['find', 'findOne', 'countDocuments', 'deleteOne', 'deleteMany']);
  const JS_IDENT = /^[A-Za-z_$][\w$]*$/;

  // Brackets open at the end of `text` (strings skipped): [{ch, method (for '('), arg (comma count), key (for '{': the key
  // being written)}], plus whether the text ends inside a string and that string's content.
  function frames(text) {
    const stack = [];
    let str = null;
    let strStart = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (str) {
        if (ch === '\\') i++;
        else if (ch === str) str = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { str = ch; strStart = i + 1; continue; }
      if (text.startsWith('//', i)) { const e = text.indexOf('\n', i); if (e < 0) break; i = e; continue; }
      const top = stack[stack.length - 1];
      if ('({['.includes(ch)) {
        // An array's elements belong to the key the array is the value of ({$or: [{...}]}).
        stack.push({ ch, method: ch === '(' ? text.slice(0, i).match(/([\w$]+)\s*$/)?.[1] : null, arg: 0, key: null, parentKey: top ? (top.ch === '[' ? top.parentKey : top.key) : null, at: i });
      } else if (')}]'.includes(ch)) stack.pop();
      else if (ch === ',' && top) { top.arg++; top.key = null; } else if (ch === ':' && top?.ch === '{') {
        top.key = text.slice(top.at + 1, i).split(',').pop().trim().replace(/^['"]|['"]$/g, '');
      }
    }
    return { stack, string: str ? text.slice(strStart) : null };
  }

  async function provideMongo(model, position) {
    const c = host.consoleFor(model);
    if (!c || c.ui.language !== 'mongosh') return none;
    const { before } = statementAround(model, position, 'mongo');
    const word = before.match(/[\w$]*$/)[0];
    const range = rangeFor(position, word);
    const items = [];
    const push = (label, kind, insertText, sortText, extra = {}) => items.push({ label, kind, insertText, sortText, range, ...extra });
    const tree = await host.tree(c.id);
    const text = model.getValue().slice(0, model.getOffsetAt(position));
    const used = [...text.matchAll(/^\s*use\s+([^\s;]+)/gm)].pop()?.[1];
    const uriDb = c.source.uri?.match(/^mongodb(?:\+srv)?:\/\/[^/]*\/([^?]+)/i)?.[1];
    const currentDb = used || c.source.database || uriDb || 'test';
    const collectionsOf = (db) => tree.find((d) => d.name === db)?.children?.map((x) => x.name) || [];

    if (/^\s*use\s+[\w$-]*$/.test(before)) {
      for (const d of tree) push(d.name, K.Module, d.name, `0${d.name}`, { detail: tr('database') });
      return { suggestions: items };
    }
    if (/^\s*show\s+\w*$/.test(before)) {
      for (const w of ['dbs', 'collections']) push(w, K.Keyword, w, w);
      return { suggestions: items };
    }
    const method = ([name, sig, body, doc], rank) => push({ label: name, detail: sig }, K.Method, body, `${rank}${name}`, { detail: `${name}${sig}`, documentation: doc, insertTextRules: SNIPPET });
    const dbDot = before.match(/\bdb\s*\.\s*(?:getSiblingDB\((['"])(.+?)\1\)\s*\.\s*)?([\w$]*)$/);
    if (dbDot) {
      for (const name of collectionsOf(dbDot[2] || currentDb)) {
        push(name, K.Field, JS_IDENT.test(name) ? name : `getCollection('${name}')`, `0${name}`, { detail: tr('collection'), filterText: name });
      }
      MONGO.db.forEach((m) => method(m, 1));
      return { suggestions: items };
    }
    const collDot = before.match(/\bdb\s*\.\s*(?:getSiblingDB\((['"])(.+?)\1\)\s*\.\s*)?(?:([\w$]+)|getCollection\((['"])(.+?)\4\))\s*\.\s*([\w$]*)$/);
    if (collDot) {
      MONGO.collection.forEach((m) => method(m, 0));
      return { suggestions: items };
    }
    if (/\)\s*\.\s*[\w$]*$/.test(before)) {
      MONGO.cursor.forEach((m) => method(m, 0));
      return { suggestions: items };
    }

    const { stack, string } = frames(before);
    if (!stack.length) {
      if (string !== null) return none;
      push('db', K.Variable, 'db', '0db', { detail: tr('database') });
      push('use', K.Keyword, 'use ', '1use');
      push('show dbs', K.Keyword, 'show dbs', '1show dbs');
      push('show collections', K.Keyword, 'show collections', '1show collections');
      return { suggestions: items };
    }
    // Inside a call on a collection: the method, its argument, and the object nesting decide what fits.
    const callIndex = stack.map((f) => f.ch).lastIndexOf('(');
    const call = stack[callIndex];
    if (!call) return none;
    const callText = before.slice(0, call.at);
    const target = callText.match(/\bdb\s*\.\s*(?:getSiblingDB\((['"])(.+?)\1\)\s*\.\s*)?(?:([\w$]+)|getCollection\((['"])(.+?)\4\))\s*\.\s*[\w$]+\s*$/);
    const chained = !target && callText.match(/\bdb\s*\.\s*(?:getSiblingDB\((['"])(.+?)\1\)\s*\.\s*)?(?:([\w$]+)|getCollection\((['"])(.+?)\4\))\s*\.\s*[\w$]+\s*\(/);
    const t = target || chained;
    const fields = [];
    if (t) {
      const sampled = await host.children(c.id, [t[2] || currentDb, t[3] || t[5]]);
      const walk = (nodes, prefix) => { for (const n of nodes) { fields.push({ path: `${prefix}${n.name}`, type: n.detail }); if (n.children) walk(n.children, `${prefix}${n.name}.`); } };
      walk(sampled, '');
    }
    const top = stack[stack.length - 1];
    const inner = stack.slice(callIndex + 1);
    const fieldItems = (rank) => {
      for (const [i, f] of fields.entries()) push({ label: f.path, description: f.type }, K.Field, JS_IDENT.test(f.path) ? f.path : `'${f.path}'`, `${rank}${String(i).padStart(4, '0')}`, { detail: `${tr('field')} · ${f.type}`, filterText: f.path });
    };
    const ops = (names, detail, rank) => { for (const n of names) push(n, K.Operator, n, `${rank}${n}`, { detail }); };
    // A filter object: fields and query operators, or only operators inside a field's condition ({age: {$gt: 1}}).
    const filter = () => {
      if (top.parentKey && !top.parentKey.startsWith('$')) ops(QUERY_OPS, tr('query operator'), 0);
      else { fieldItems(0); ops(QUERY_OPS, tr('query operator'), 1); }
    };

    // A '$field' path inside a string in a pipeline.
    if (string !== null) {
      if (call.method === 'aggregate' && string.startsWith('$')) {
        const r = rangeFor(position, string);
        for (const f of fields) items.push({ label: `$${f.path}`, kind: K.Field, insertText: `$${f.path}`, range: r, sortText: `0${f.path}`, detail: `${tr('field')} · ${f.type}` });
        return { suggestions: items };
      }
      return none;
    }
    if (top.ch !== '{') return none;
    const keyPosition = /[{,]\s*['"]?[\w$.]*$/.test(before.slice(top.at));
    if (!keyPosition) return none;
    const depth = inner.filter((f) => f.ch === '{').length;
    const updateArg = /^(updateOne|updateMany)$/.test(call.method) && call.arg === 1;
    if (call.method === 'aggregate' && call.arg === 0) {
      const stage = inner.length >= 3 ? inner[2].parentKey : null;
      if (inner.length === 2 && inner[0].ch === '[') ops(STAGES, tr('aggregation stage'), 0);
      else if (stage === '$match') filter();
      else if (stage === '$group' && inner.length >= 4) ops(ACCUMULATORS, tr('accumulator'), 0);
      else if (stage === '$lookup') for (const k of LOOKUP) push(k, K.Property, k, `0${k}`, { detail: '$lookup' });
      else if (stage === '$group') push('_id', K.Field, '_id', '0_id', { detail: tr('field') });
      else fieldItems(0);
    } else if (updateArg && depth === 1) ops(UPDATE_OPS, tr('update operator'), 0);
    else if (updateArg) fieldItems(0);
    else if (FILTER_METHODS.has(call.method) || (/^(updateOne|updateMany|replaceOne|distinct)$/.test(call.method) && call.arg === (call.method === 'distinct' ? 1 : 0))) {
      if (call.arg === 1 && /^(find|findOne)$/.test(call.method)) fieldItems(0);
      else filter();
    } else fieldItems(0);
    return { suggestions: items };
  }

  monaco.languages.registerCompletionItemProvider('mongosh', { triggerCharacters: ['.', '$', '{', ',', ' ', "'", '"'], provideCompletionItems: provideMongo });

  // ---------- Redis ----------
  // [name, arguments, documentation, which arguments are keys: 1 (the first), 'all', or 0]
  const REDIS = [
    ['GET', 'key', tr('Get the value of a key'), 1], ['SET', 'key value [NX | XX] [EX seconds | PX milliseconds]', tr('Set the string value of a key'), 1],
    ['MGET', 'key [key ...]', tr('Get the values of several keys'), 'all'], ['MSET', 'key value [key value ...]', tr('Set several keys at once'), 0],
    ['INCR', 'key', tr('Increment the integer value of a key by one'), 1], ['INCRBY', 'key increment', tr('Increment the integer value of a key'), 1],
    ['DECR', 'key', tr('Decrement the integer value of a key by one'), 1], ['APPEND', 'key value', tr('Append a value to a string'), 1],
    ['STRLEN', 'key', tr('Get the length of a string'), 1], ['GETDEL', 'key', tr('Get the value of a key and delete it'), 1],
    ['DEL', 'key [key ...]', tr('Delete keys'), 'all'], ['EXISTS', 'key [key ...]', tr('Count how many of the keys exist'), 'all'],
    ['TYPE', 'key', tr('Get the type of the value at a key'), 1], ['TTL', 'key', tr('Get the time to live of a key in seconds'), 1],
    ['EXPIRE', 'key seconds', tr('Set the time to live of a key in seconds'), 1], ['PERSIST', 'key', tr('Remove the time to live of a key'), 1],
    ['RENAME', 'key newkey', tr('Rename a key'), 1], ['SCAN', 'cursor [MATCH pattern] [COUNT count] [TYPE type]', tr('Iterate over the keys'), 0],
    ['KEYS', 'pattern', tr('Find all keys matching a pattern (blocks the server; prefer SCAN)'), 0],
    ['HGET', 'key field', tr('Get the value of a hash field'), 1], ['HSET', 'key field value [field value ...]', tr('Set hash fields'), 1],
    ['HGETALL', 'key', tr('Get all fields and values of a hash'), 1], ['HDEL', 'key field [field ...]', tr('Delete hash fields'), 1],
    ['HKEYS', 'key', tr('Get the field names of a hash'), 1], ['HVALS', 'key', tr('Get the values of a hash'), 1], ['HLEN', 'key', tr('Count the fields of a hash'), 1],
    ['HEXISTS', 'key field', tr('Check whether a hash field exists'), 1], ['HINCRBY', 'key field increment', tr('Increment a hash field'), 1],
    ['HSCAN', 'key cursor [MATCH pattern] [COUNT count]', tr('Iterate over the fields of a hash'), 1],
    ['LPUSH', 'key element [element ...]', tr('Prepend elements to a list'), 1], ['RPUSH', 'key element [element ...]', tr('Append elements to a list'), 1],
    ['LPOP', 'key [count]', tr('Remove and return the first elements of a list'), 1], ['RPOP', 'key [count]', tr('Remove and return the last elements of a list'), 1],
    ['LRANGE', 'key start stop', tr('Get a range of list elements'), 1], ['LLEN', 'key', tr('Get the length of a list'), 1], ['LINDEX', 'key index', tr('Get a list element by index'), 1],
    ['SADD', 'key member [member ...]', tr('Add members to a set'), 1], ['SREM', 'key member [member ...]', tr('Remove members from a set'), 1],
    ['SMEMBERS', 'key', tr('Get all members of a set'), 1], ['SISMEMBER', 'key member', tr('Check whether a value is a set member'), 1], ['SCARD', 'key', tr('Count the members of a set'), 1],
    ['SINTER', 'key [key ...]', tr('Intersect sets'), 'all'], ['SUNION', 'key [key ...]', tr('Union of sets'), 'all'],
    ['SSCAN', 'key cursor [MATCH pattern] [COUNT count]', tr('Iterate over the members of a set'), 1],
    ['ZADD', 'key [NX | XX] score member [score member ...]', tr('Add members with scores to a sorted set'), 1],
    ['ZRANGE', 'key start stop [BYSCORE | BYLEX] [REV] [WITHSCORES]', tr('Get a range of sorted set members'), 1],
    ['ZREVRANGE', 'key start stop [WITHSCORES]', tr('Get sorted set members from high to low score'), 1],
    ['ZRANGEBYSCORE', 'key min max [WITHSCORES] [LIMIT offset count]', tr('Get sorted set members within a score range'), 1],
    ['ZSCORE', 'key member', tr('Get the score of a sorted set member'), 1], ['ZINCRBY', 'key increment member', tr('Increment the score of a sorted set member'), 1],
    ['ZREM', 'key member [member ...]', tr('Remove members from a sorted set'), 1], ['ZCARD', 'key', tr('Count the members of a sorted set'), 1],
    ['ZRANK', 'key member', tr('Get the rank of a sorted set member'), 1],
    ['XADD', 'key [MAXLEN [~] count] id | * field value [field value ...]', tr('Append an entry to a stream'), 1],
    ['XRANGE', 'key start end [COUNT count]', tr('Get stream entries in an ID range'), 1], ['XREVRANGE', 'key end start [COUNT count]', tr('Get stream entries in reverse order'), 1],
    ['XLEN', 'key', tr('Count the entries of a stream'), 1], ['XREAD', '[COUNT count] [BLOCK milliseconds] STREAMS key [key ...] id [id ...]', tr('Read entries from streams'), 0],
    ['PING', '[message]', tr('Check that the server answers'), 0], ['ECHO', 'message', tr('Return the message'), 0], ['SELECT', 'index', tr('Switch to another database'), 0],
    ['DBSIZE', '', tr('Count the keys in the current database'), 0], ['INFO', '[section]', tr('Get server information and statistics'), 0],
    ['CONFIG GET', 'parameter', tr('Read a configuration parameter'), 0], ['CLIENT LIST', '', tr('List the client connections'), 0], ['TIME', '', tr('Get the server time'), 0],
    ['PUBLISH', 'channel message', tr('Post a message to a channel'), 0], ['FLUSHDB', '[ASYNC | SYNC]', tr('Delete every key in the current database'), 0],
  ];
  const quoteArg = (s) => (/^[^\s"'\\]+$/.test(s) ? s : `"${s.replace(/[\\"]/g, '\\$&')}"`);
  const glob = (s) => s.replace(/[*?[\]\\]/g, '\\$&');
  let keyRequest = 0;

  async function provideRedis(model, position, _ctx, token) {
    const c = host.consoleFor(model);
    if (!c || c.ui.statementSeparator !== 'lines') return none;
    const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    if (/^\s*#/.test(line)) return none;
    const words = line.trimStart().split(/\s+/);
    const word = words[words.length - 1];
    const range = rangeFor(position, word);
    if (words.length === 1) {
      return {
        suggestions: REDIS.map(([name, args, doc]) => ({
          label: { label: name, detail: args ? ` ${args}` : '' }, kind: K.Function, insertText: args ? `${name} ` : name, range, filterText: name,
          sortText: name, detail: `${name} ${args}`.trim(), documentation: doc, command: args ? { id: 'editor.action.triggerSuggest' } : undefined,
        })),
      };
    }
    const cmd = REDIS.find(([name]) => same(name, words[0]) || same(name, `${words[0]} ${words[1] || ''}`.trim()));
    if (!cmd || !cmd[3] || (cmd[3] === 1 && words.length !== 2) || /^["']/.test(word)) return none;
    // Keys starting with what is typed, found with SCAN MATCH (debounced: a newer keystroke cancels this one).
    const mine = ++keyRequest;
    await new Promise((r) => setTimeout(r, 150));
    if (mine !== keyRequest || token.isCancellationRequested) return none;
    const keys = new Set();
    let cursor = '0';
    for (let i = 0; i < 5 && keys.size < 100; i++) {
      const r = await host.query(c.id, `SCAN ${cursor} MATCH ${quoteArg(`${glob(word)}*`)} COUNT 500`);
      if (!r.ok) break;
      for (const [k] of r.rows) keys.add(k);
      cursor = String(r.message || '').replace(/^cursor /, '') || '0';
      if (cursor === '0') break;
    }
    if (mine !== keyRequest) return none;
    return { suggestions: [...keys].sort().map((k) => ({ label: k, kind: K.Value, insertText: quoteArg(k), range, sortText: k, detail: tr('key'), filterText: k })) };
  }

  monaco.languages.registerCompletionItemProvider('plaintext', { triggerCharacters: [' '], provideCompletionItems: provideRedis });

  ide.database.completion = { tableRefs, scrub };
})();
