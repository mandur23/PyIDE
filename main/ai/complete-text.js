// What a code completion may contain at a caret, and how a raw model continuation is cut down to it.
// The model stops early on the same rules (main/ai/complete_server.py); this is the authoritative cut.

// Text after the caret on its line that still allows a multi-line suggestion: nothing, or only closing characters.
const CLOSERS_ONLY = /^[\s)\]}'"`:;,]*$/;
const MAX_LINES = 20;
const indentOf = (line) => line.length - line.trimStart().length;

// The block being written: lines indented less than `indent` end it, and after a blank line so do lines indented
// less than `blankIndent` (a new paragraph at the caret's own level). Single-line plans have indent null.
function plan({ prefix, suffix, multiline }) {
  const linePrefix = prefix.slice(prefix.lastIndexOf('\n') + 1);
  const lineSuffix = suffix.split('\n', 1)[0];
  if (!multiline || !CLOSERS_ONLY.test(lineSuffix)) return { maxTokens: 48, stop: ['\n'], indent: null, blankIndent: null };
  const base = indentOf(linePrefix);
  // At the start of a statement the suggestion may add siblings; after text it may only add that line's body.
  const indent = linePrefix.trim() ? base + 1 : base;
  return { maxTokens: 128, stop: [], indent, blankIndent: base + 1 };
}

const balance = (s) => {
  let score = 0;
  for (const [open, close] of ['()', '[]', '{}']) score += Math.abs(s.split(open).length - s.split(close).length);
  for (const q of ['"', "'"]) score += (s.split(q).length - 1) % 2;
  return score;
};

function cutBlock(text, { indent, blankIndent }) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim());
  if (start < 0) return '';
  if (indent === null) return lines.slice(0, start + 1).join('\n');
  const keep = lines.slice(0, start + 1);
  let afterBlank = false;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) { afterBlank = true; keep.push(line); continue; }
    const n = indentOf(line);
    if (n < indent || (afterBlank && n < blankIndent) || keep.length >= MAX_LINES) break;
    afterBlank = false;
    keep.push(line);
  }
  return keep.join('\n');
}

const isSubsequence = (needle, hay) => {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length;
};

// -> {text, replace}: the suggestion to insert at the caret, replacing the `replace` characters after it ('' for none).
// When only closing characters follow the caret (usually auto-closed brackets and quotes) and the suggestion writes
// them itself, it replaces them, so `add(` + `)` with `1, 2)` or `(a` + `)` with ` + b) if ok else 0` come out right.
function trimCompletion(raw, { prefix, suffix, ...cut }) {
  const text = trimText(raw, { prefix, suffix, ...cut });
  if (!text) return { text: '', replace: 0 };
  const linePrefix = prefix.slice(prefix.lastIndexOf('\n') + 1);
  const lineSuffix = suffix.split('\n', 1)[0];
  const closers = lineSuffix.trimEnd();
  if (closers && CLOSERS_ONLY.test(closers) && isSubsequence(closers.replace(/\s/g, ''), text)
    && balance(linePrefix + text + lineSuffix.slice(closers.length)) < balance(linePrefix + text + lineSuffix)) {
    return { text, replace: closers.length };
  }
  return { text, replace: 0 };
}

function trimText(raw, { prefix, suffix, ...cut }) {
  let text = cutBlock(raw, cut).trimEnd();
  const linePrefix = prefix.slice(prefix.lastIndexOf('\n') + 1);
  const [lineSuffix, ...after] = suffix.split('\n');
  // The model repeating the line that already follows the caret's line.
  const next = after.find((l) => l.trim())?.trim();
  if (next) {
    const lines = text.split('\n');
    const dup = lines.findIndex((l, i) => i > 0 && l.trim() === next);
    if (dup > 0) text = lines.slice(0, dup).join('\n').trimEnd();
  }
  // The model writing characters that already follow the caret, typically an auto-closed bracket or quote.
  const tail = lineSuffix.trimEnd();
  for (let k = Math.min(tail.length, text.length); k > 0; k--) {
    if (!text.endsWith(tail.slice(0, k))) continue;
    const without = text.slice(0, -k);
    if (balance(linePrefix + without + lineSuffix) < balance(linePrefix + text + lineSuffix)) text = without;
    break;
  }
  if (!text.trim() || suffix.startsWith(text)) return '';
  return text;
}

module.exports = { plan, trimCompletion };
