// Export Data (PyCharm's data extractors): writes rows that a cursor pages out of a data source to a file as CSV/TSV,
// JSON (array of objects or JSON Lines), SQL INSERT statements, a Markdown table or an Excel workbook (.xlsx). Rows
// arrive a batch at a time and leave for the file at once, so exporting a million-row table never holds it in memory.
// The file is written next to the target as `<name>.pyide-export` and renamed at the end; a cancelled or failed export
// removes it and leaves an existing file alone. Pure Node: verify/db-export.mjs drives it through the IDE.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- values ----------
// A cell from any kind: null, {$number: 'exact text'} (a number as the database prints it: SQLite REAL 2.0, integers
// past 2^53, NUMERIC/DECIMAL digits), bigint, number, boolean, string, Uint8Array/Buffer (full blob), Date, or another
// object (JSON). Values reach the file exactly: numbers unquoted in JSON and SQL (unless they are not numbers there,
// like NaN), and binary data whole in every format:
//   CSV, TSV, Markdown, Excel: 0x followed by the bytes in hex (0x for an empty value)
//   JSON:                      {"$base64": "<the bytes in base64>"} (the MongoDB Extended JSON idea, one key)
//   SQL INSERT:                the data source's own blob literal (options.dialect, below)
function cellOf(v) {
  if (v === null || v === undefined) return { t: 'null', s: '' };
  if (typeof v === 'object' && typeof v.$number === 'string') return { t: 'num', s: v.$number };
  if (typeof v === 'bigint') return { t: 'num', s: v.toString() };
  if (typeof v === 'number') return Number.isFinite(v) ? { t: 'num', s: String(v) } : { t: 'str', s: String(v) };
  if (typeof v === 'boolean') return { t: 'bool', s: v ? 'true' : 'false', b: v };
  if (v instanceof Uint8Array) {
    const bytes = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    const hex = bytes.toString('hex');
    return { t: 'blob', s: `0x${hex}`, hex, b64: bytes.toString('base64') };
  }
  if (v instanceof Date) return { t: 'str', s: Number.isNaN(v.getTime()) ? String(v) : v.toISOString() };
  if (typeof v === 'object') { try { return { t: 'str', s: JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) }; } catch { return { t: 'str', s: String(v) }; } }
  return { t: 'str', s: String(v) };
}
// A number's text as JSON accepts it (Infinity/NaN cannot be JSON numbers; SQLite prints them as Inf).
const jsonNumber = (s) => (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s) ? s : JSON.stringify(s));

// ---------- text formats ----------
// Each returns {head(columns) -> text, row(cells) -> text, tail() -> text}.
function csvFormat(o) {
  const sep = o.delimiter ?? ',';
  const eol = o.lineSeparator === 'lf' ? '\n' : '\r\n';
  const quote = o.quote || 'needed'; // needed | always | never
  const nullText = o.nullText ?? '';
  const special = new RegExp(`["\\r\\n${sep.replace(/[\\\]^-]/g, '\\$&')}]`);
  const text = (s, isNull) => {
    if (isNull) return nullText;
    if (quote === 'never') return s;
    if (quote === 'always' || special.test(s) || /^\s|\s$/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return {
    head: (cols) => (o.header === false ? '' : cols.map((c) => text(c.name, false)).join(sep) + eol),
    row: (cells) => cells.map((c) => text(c.s, c.t === 'null')).join(sep) + eol,
    tail: () => '',
  };
}

function jsonFormat(o) {
  const lines = o.style === 'lines';
  let names = [];
  let n = 0;
  const value = (c) => (c.t === 'null' ? 'null' : c.t === 'num' ? jsonNumber(c.s) : c.t === 'bool' ? c.s
    : c.t === 'blob' ? `{"$base64": ${JSON.stringify(c.b64)}}` : JSON.stringify(c.s));
  const object = (cells) => `{${cells.map((c, i) => `${names[i]}: ${value(c)}`).join(', ')}}`;
  return {
    head: (cols) => { names = cols.map((c) => JSON.stringify(c.name)); return lines ? '' : '['; },
    row: (cells) => (lines ? `${object(cells)}\n` : `${n++ ? ',' : ''}\n  ${object(cells)}`),
    tail: () => (lines ? '' : n ? '\n]\n' : ']\n'),
  };
}

// SQL literals per dialect (a kind's sqlDialect): binary data, booleans and the string escapes each database reads.
const hexBytes = (hex) => hex.toUpperCase();
const SQL_DIALECTS = {
  standard: { blob: (hex) => `X'${hexBytes(hex)}'` }, // SQLite and most others
  mysql: { blob: (hex) => `X'${hexBytes(hex)}'`, backslash: true }, // MySQL, MariaDB: \ is an escape in strings
  clickhouse: { blob: (hex) => `unhex('${hexBytes(hex)}')`, backslash: true },
  postgres: { blob: (hex) => `'\\x${hex}'::bytea` }, // PostgreSQL, CockroachDB (bytea hex input)
  duckdb: { blob: (hex) => `'${hexBytes(hex).replace(/../g, '\\x$&')}'::BLOB` },
  mssql: { blob: (hex) => `0x${hexBytes(hex)}`, bool: (b) => (b ? '1' : '0'), unicode: true },
  oracle: { blob: (hex) => `HEXTORAW('${hexBytes(hex)}')`, bool: (b) => (b ? '1' : '0') },
};

function sqlFormat(o) {
  const q = o.quote || '"';
  const d = SQL_DIALECTS[o.dialect] || SQL_DIALECTS.standard;
  const str = (s) => `${d.unicode ? 'N' : ''}'${(d.backslash ? s.replace(/\\/g, '\\\\') : s).replace(/'/g, "''")}'`;
  const ident = (name) => `${q}${String(name).split(q).join(q + q)}${q}`;
  // A qualified name (schema.table) is given as parts; a typed name is used as the user wrote it.
  const table = Array.isArray(o.table) ? o.table.map(ident).join('.') : (String(o.table || '').trim() || 'MY_TABLE');
  let head = '';
  const value = (c) => {
    if (c.t === 'null') return 'NULL';
    if (c.t === 'num') return /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(c.s) ? c.s : str(c.s);
    if (c.t === 'bool') return d.bool ? d.bool(c.b) : c.b ? 'TRUE' : 'FALSE';
    if (c.t === 'blob') return d.blob(c.hex);
    return str(c.s);
  };
  return {
    head: (cols) => { head = `INSERT INTO ${table} (${cols.map((c) => ident(c.name)).join(', ')}) VALUES (`; return ''; },
    row: (cells) => `${head}${cells.map(value).join(', ')});\n`,
    tail: () => '',
  };
}

function markdownFormat(o) {
  const nullText = o.nullText ?? '';
  const text = (s) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
  return {
    head: (cols) => `| ${cols.map((c) => text(c.name)).join(' | ')} |\n|${cols.map(() => ' --- ').join('|')}|\n`,
    row: (cells) => `| ${cells.map((c) => (c.t === 'null' ? nullText : text(c.s))).join(' | ')} |\n`,
    tail: () => '',
  };
}

const TEXT_FORMATS = { csv: csvFormat, tsv: (o) => csvFormat({ ...o, delimiter: '\t' }), json: jsonFormat, sql: sqlFormat, markdown: markdownFormat };
const EXTENSIONS = { csv: 'csv', tsv: 'tsv', json: 'json', sql: 'sql', markdown: 'md', xlsx: 'xlsx' };

// Buffered text output in the chosen encoding: utf8, utf8bom (Excel recognises UTF-8 CSV by its BOM) or utf16le (with BOM).
function textSink(fh, encoding) {
  let buf = '';
  let bytes = 0;
  const enc = encoding === 'utf16le' ? 'utf16le' : 'utf8';
  const flush = async () => {
    if (!buf) return;
    const data = Buffer.from(buf, enc);
    buf = '';
    bytes += data.length;
    await fh.write(data);
  };
  return {
    async start() {
      const bom = encoding === 'utf8bom' ? Buffer.from([0xef, 0xbb, 0xbf]) : encoding === 'utf16le' ? Buffer.from([0xff, 0xfe]) : null;
      if (bom) { bytes += bom.length; await fh.write(bom); }
    },
    async write(s) { buf += s; if (buf.length >= 1 << 20) await flush(); },
    flush,
    get bytes() { return bytes + Buffer.byteLength(buf, enc); },
  };
}

// ---------- xlsx ----------
// A ZIP written front to back: small parts deflated in memory, the sheet deflated as it streams with a data descriptor
// (general purpose bit 3) after it, since its size is known only at the end. No ZIP64: a workbook stays under 4 GB.
function dosDateTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
function zipWriter(fh, now = new Date()) {
  const { time, date } = dosDateTime(now);
  const central = [];
  let offset = 0;
  const put = async (buf) => { await fh.write(buf); offset += buf.length; };
  const local = (nameBuf, flags, crc, csize, size) => {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(flags, 6);
    h.writeUInt16LE(8, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(csize, 18);
    h.writeUInt32LE(size, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    return h;
  };
  const record = (nameBuf, flags, crc, csize, size, at) => {
    const e = Buffer.alloc(46);
    e.writeUInt32LE(0x02014b50, 0);
    e.writeUInt16LE(20, 4);
    e.writeUInt16LE(20, 6);
    e.writeUInt16LE(flags, 8);
    e.writeUInt16LE(8, 10);
    e.writeUInt16LE(time, 12);
    e.writeUInt16LE(date, 14);
    e.writeUInt32LE(crc, 16);
    e.writeUInt32LE(csize, 20);
    e.writeUInt32LE(size, 24);
    e.writeUInt16LE(nameBuf.length, 28);
    e.writeUInt32LE(at, 42);
    central.push(e, nameBuf);
  };
  return {
    async add(name, text) {
      const raw = Buffer.from(text, 'utf8');
      const nameBuf = Buffer.from(name, 'utf8');
      const packed = zlib.deflateRawSync(raw);
      const crc = zlib.crc32(raw);
      const at = offset;
      await put(local(nameBuf, 0x0800, crc, packed.length, raw.length));
      await put(nameBuf);
      await put(packed);
      record(nameBuf, 0x0800, crc, packed.length, raw.length, at);
    },
    // -> {write(text), end()}: deflates as text arrives; writes go out in order.
    async stream(name) {
      const nameBuf = Buffer.from(name, 'utf8');
      const at = offset;
      const flags = 0x0808;
      await put(local(nameBuf, flags, 0, 0, 0));
      await put(nameBuf);
      const deflate = zlib.createDeflateRaw({ level: 6 });
      let crc = 0;
      let size = 0;
      let csize = 0;
      let chain = Promise.resolve();
      let failed = null;
      deflate.on('data', (chunk) => { csize += chunk.length; chain = chain.then(() => put(chunk)).catch((err) => { failed = err; }); });
      const drained = () => new Promise((resolve) => (deflate.writableNeedDrain ? deflate.once('drain', resolve) : resolve()));
      return {
        async write(text) {
          if (failed) throw failed;
          const raw = Buffer.from(text, 'utf8');
          crc = zlib.crc32(raw, crc);
          size += raw.length;
          if (!deflate.write(raw)) await drained();
          await chain;
        },
        async end() {
          await new Promise((resolve, reject) => { deflate.once('end', resolve); deflate.once('error', reject); deflate.end(); });
          await chain;
          if (failed) throw failed;
          if (size >= 0xffffffff || offset >= 0xffffffff) throw new Error('The workbook is larger than 4 GB');
          const dd = Buffer.alloc(16);
          dd.writeUInt32LE(0x08074b50, 0);
          dd.writeUInt32LE(crc >>> 0, 4);
          dd.writeUInt32LE(csize, 8);
          dd.writeUInt32LE(size, 12);
          await put(dd);
          record(nameBuf, flags, crc >>> 0, csize, size, at);
        },
      };
    },
    async finish() {
      const at = offset;
      const dir = Buffer.concat(central);
      await put(dir);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(central.length / 2, 8);
      end.writeUInt16LE(central.length / 2, 10);
      end.writeUInt32LE(dir.length, 12);
      end.writeUInt32LE(at, 16);
      await put(end);
    },
    get bytes() { return offset; },
  };
}

const XLSX_MAX_ROWS = 1048576;
const XLSX_MAX_TEXT = 32767;
// Characters XML 1.0 cannot hold are dropped (a NUL in a TEXT value would make Excel refuse the file).
const xml = (s) => s.replace(/[^\t\n\r\x20-퟿-�\uD800-􏰀-\uDFFF]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
// A sheet name: at most 31 characters, none of []:*?/\ .
const sheetName = (s) => (String(s || '').replace(/[[\]:*?/\\]/g, '_').slice(0, 31).trim() || 'Result');

function xlsxParts(sheet) {
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  return {
    '[Content_Types].xml': `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${head}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="${xml(sheetName(sheet))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `${head}<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  };
}

// A cell of the sheet: numbers that Excel keeps exactly (15 significant digits) as numbers, everything else as an inline
// string (no shared string table to build, so rows stream). Booleans are Excel booleans; NULL is an empty cell.
function xlsxCell(c, ref, style = '') {
  if (c.t === 'null') return '';
  if (c.t === 'num' && /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(c.s) && c.s.replace(/^-|\.|e.*$/gi, '').replace(/^0+/, '').length <= 15) return `<c r="${ref}"${style}><v>${c.s}</v></c>`;
  if (c.t === 'bool') return `<c r="${ref}"${style} t="b"><v>${c.b ? 1 : 0}</v></c>`;
  const s = c.s.length > XLSX_MAX_TEXT ? c.s.slice(0, XLSX_MAX_TEXT) : c.s;
  const space = /^\s|\s$/.test(s) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${style} t="inlineStr"><is><t${space}>${xml(s)}</t></is></c>`;
}

// ---------- the export ----------
// cursor: {columns: [{name}], next(n) -> rows | null at the end, close()}. Resolves {rows, bytes, batches, truncated}.
// next() is awaited before each batch is written, so the cursor's source waits while the file catches up.
// onProgress(rows) is called after each batch; isCancelled() is checked around each fetch (a cancelled export rejects
// with err.cancelled and removes the partial file).
async function exportCursor(cursor, { format, options = {}, file, batch = 1000, onProgress = () => {}, isCancelled = () => false }) {
  if (!TEXT_FORMATS[format] && format !== 'xlsx') throw new Error(`Unknown export format ${format}`);
  const part = path.join(path.dirname(file), `${path.basename(file)}.pyide-export`);
  const fh = await fs.promises.open(part, 'w');
  let rows = 0;
  let batches = 0;
  let truncated = false;
  let closed = false;
  const cancelled = () => { const err = new Error('Export cancelled'); err.cancelled = true; return err; };
  try {
    const columns = cursor.columns;
    let bytes;
    if (format === 'xlsx') {
      const zip = zipWriter(fh);
      for (const [name, text] of Object.entries(xlsxParts(options.sheet))) await zip.add(name, text);
      const sheet = await zip.stream('xl/worksheets/sheet1.xml');
      await sheet.write('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>');
      let r = 0;
      if (options.header !== false) {
        r++;
        await sheet.write(`<row r="1">${columns.map((c, i) => xlsxCell({ t: 'str', s: String(c.name) }, `${colName(i)}1`, ' s="1"')).join('')}</row>`);
      }
      const refs = columns.map((_c, i) => colName(i));
      for (;;) {
        if (isCancelled()) throw cancelled();
        const got = await cursor.next(batch);
        if (isCancelled()) throw cancelled();
        if (!got) break;
        batches++;
        let text = '';
        for (const row of got) {
          if (r >= XLSX_MAX_ROWS) { truncated = true; break; }
          r++;
          text += `<row r="${r}">${row.map((v, i) => xlsxCell(cellOf(v), `${refs[i]}${r}`)).join('')}</row>`;
          rows++;
        }
        await sheet.write(text);
        onProgress(rows);
        if (truncated) break;
      }
      await sheet.write('</sheetData></worksheet>');
      await sheet.end();
      await zip.finish();
      bytes = zip.bytes;
    } else {
      const fmt = TEXT_FORMATS[format](options);
      const out = textSink(fh, options.encoding);
      await out.start();
      await out.write(fmt.head(columns));
      for (;;) {
        if (isCancelled()) throw cancelled();
        const got = await cursor.next(batch);
        if (isCancelled()) throw cancelled();
        if (!got) break;
        batches++;
        let text = '';
        for (const row of got) text += fmt.row(row.map(cellOf));
        rows += got.length;
        await out.write(text);
        onProgress(rows);
      }
      await out.write(fmt.tail());
      await out.flush();
      bytes = out.bytes;
    }
    closed = true;
    await cursor.close();
    await fh.close();
    await fs.promises.rename(part, file);
    return { rows, bytes, batches, truncated };
  } catch (err) {
    if (!closed) await Promise.resolve(cursor.close()).catch(() => {});
    await fh.close().catch(() => {});
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw err;
  }
}

// Rows already in memory (a result grid whose statement must not run again) as a cursor.
function arrayCursor(columns, rows) {
  let at = 0;
  return { columns, next: async (n) => { if (at >= rows.length) return null; const out = rows.slice(at, at + n); at += n; return out; }, close: async () => {} };
}

module.exports = { exportCursor, arrayCursor, cellOf, SQL_DIALECTS, EXTENSIONS, FORMATS: [...Object.keys(TEXT_FORMATS), 'xlsx'], colName, sheetName };
