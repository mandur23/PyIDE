// Caption files for Nano Studio Cut: SubRip (.srt) and WebVTT (.vtt) in and out, and the text encoding of a caption
// file's bytes (UTF-8 with or without BOM, UTF-16 by BOM or by its zero bytes, else CP949, which Korean Windows tools
// still write). Items are { start, end, text } in ticks; the text keeps its line breaks.
// The parsers take what real files contain: a missing or wrong cue number, '.' for ',', no hours, one to three
// fraction digits, position settings after the times, CRLF or CR, blank lines with spaces, a BOM.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).srt = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const time = NODE ? require('./time.js') : globalThis.Cut.time;
  const MS = time.TICKS / 1000;
  const BOM = new RegExp('^' + String.fromCharCode(0xfeff));
  const VTT_HEAD = new RegExp('^' + String.fromCharCode(0xfeff) + '?WEBVTT');

  // [h:]mm:ss[,.]fff -> ticks, or null. A fraction of fewer than three digits is a decimal fraction (",5" = 500 ms).
  const STAMP = /(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,9}))?/;
  function stamp(m) {
    const h = Number(m[1] || 0);
    const mm = Number(m[2]);
    const ss = Number(m[3]);
    const frac = m[4] ? Math.round(Number(`0.${m[4]}`) * 1000) : 0;
    return ((h * 3600 + mm * 60 + ss) * 1000 + frac) * MS;
  }
  const TIMING = new RegExp(`^\\s*${STAMP.source}\\s*-+>\\s*${STAMP.source}`);

  const lines = (text) => String(text).replace(BOM, '').split(/\r\n|\r|\n/);
  const blank = (s) => /^\s*$/.test(s);
  // Cue markup players read and do not show: <i>, <b>, <font ...>, ASS overrides ({\an8}) and VTT's <c>, <v Name> and
  // <00:00:01.500>. Kept, it was drawn as text and burned into exports. A "<" before a non-letter ("a < b") stays.
  const TAG = /<\/?[a-z][^<>]*>|<\d{1,2}:\d{2}(:\d{2})?[.,]\d{1,3}>/gi;
  const ASS = /\{\\[^{}]*\}/g;
  const plain = (s) => s.replace(TAG, '').replace(ASS, '');

  function parse(text) {
    const items = [];
    const all = lines(text);
    let i = 0;
    while (i < all.length) {
      while (i < all.length && blank(all[i])) i++;
      if (i >= all.length) break;
      // The timing line is the block's first or second line (after a cue number, which is not checked).
      let m = TIMING.exec(all[i]);
      if (!m && i + 1 < all.length) {
        m = TIMING.exec(all[i + 1]);
        if (m) i++;
      }
      if (!m) {
        while (i < all.length && !blank(all[i])) i++;
        continue;
      }
      i++;
      const body = [];
      while (i < all.length && !blank(all[i])) {
        // A timing line without the blank line before it starts the next cue.
        if (TIMING.exec(all[i]) || (i + 1 < all.length && /^\s*\d+\s*$/.test(all[i]) && TIMING.exec(all[i + 1]))) break;
        body.push(all[i]);
        i++;
      }
      items.push({ start: stamp(m.slice(0, 5)), end: stamp([m[0], m[5], m[6], m[7], m[8]]), text: plain(body.join('\n')).replace(/\s+$/, '') });
    }
    return items;
  }

  function fmt(ticks, sep, hours = true) {
    const total = Math.max(0, Math.round(ticks / MS));
    const ms = total % 1000;
    const s = Math.floor(total / 1000);
    const p2 = (n) => String(n).padStart(2, '0');
    const head = hours || s >= 3600 ? `${p2(Math.floor(s / 3600))}:` : '';
    return `${head}${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}${sep}${String(ms).padStart(3, '0')}`;
  }

  // A blank line inside a caption would end it early in every player, so it collapses.
  const body = (text) => String(text ?? '').replace(/\r\n|\r/g, '\n').replace(/\n\s*\n/g, '\n').replace(/^\n+|\s+$/g, '');

  function write(items) {
    return items.map((it, n) => `${n + 1}\r\n${fmt(it.start, ',')} --> ${fmt(it.end, ',')}\r\n${body(it.text).replace(/\n/g, '\r\n')}\r\n`).join('\r\n');
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', nbsp: String.fromCharCode(0xa0), lrm: String.fromCharCode(0x200e), rlm: String.fromCharCode(0x200f), quot: '"', apos: "'" };
  const unescape = (s) => s.replace(/&(amp|lt|gt|nbsp|lrm|rlm|quot|apos);/g, (_, n) => ENTITIES[n]);
  const escape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function parseVtt(text) {
    const all = lines(text);
    const items = [];
    let i = 0;
    if (/^WEBVTT/.test(all[0] || '')) {
      i = 1;
      while (i < all.length && !blank(all[i])) i++;
    }
    while (i < all.length) {
      while (i < all.length && blank(all[i])) i++;
      if (i >= all.length) break;
      // NOTE, STYLE and REGION blocks carry no cue.
      if (/^(NOTE|STYLE|REGION)(\s|$)/.test(all[i])) {
        while (i < all.length && !blank(all[i])) i++;
        continue;
      }
      let m = TIMING.exec(all[i]);
      if (!m && i + 1 < all.length) {
        m = TIMING.exec(all[i + 1]);
        if (m) i++;
      }
      if (!m) {
        while (i < all.length && !blank(all[i])) i++;
        continue;
      }
      i++;
      const text = [];
      while (i < all.length && !blank(all[i])) text.push(all[i++]);
      items.push({ start: stamp(m.slice(0, 5)), end: stamp([m[0], m[5], m[6], m[7], m[8]]), text: unescape(plain(text.join('\n'))).replace(/\s+$/, '') });
    }
    return items;
  }

  function writeVtt(items) {
    const cues = items.map((it) => `${fmt(it.start, '.', false)} --> ${fmt(it.end, '.', false)}\n${escape(body(it.text))}\n`);
    return `WEBVTT\n\n${cues.join('\n')}`;
  }

  // CP949 is EUC-KR (KS X 1001) plus the UHC extension: the 8,822 Hangul syllables KS X 1001 lacks, in Unicode order,
  // at leads 0x81-0xC6 with trails 0x41-0x5A, 0x61-0x7A and 0x81-0xFE (0x81-0xA0 from lead 0xA1). Chromium's
  // 'euc-kr' decoder has them; Node's does not (it drops the lead byte), so the extension is built here when missing.
  let uhc;
  function uhcTable(dec) {
    if (uhc) return uhc;
    const ksx = new Set();
    for (let l = 0xb0; l <= 0xc8; l++) {
      for (let t = 0xa1; t <= 0xfe; t++) {
        const ch = dec.decode(Uint8Array.of(l, t));
        if (ch.length === 1) ksx.add(ch.charCodeAt(0));
      }
    }
    uhc = new Map();
    let u = 0xac00;
    for (let l = 0x81; l <= 0xc6 && u <= 0xd7a3; l++) {
      const last = l <= 0xa0 ? 0xfe : 0xa0;
      for (let t = 0x41; t <= last && u <= 0xd7a3; t++) {
        if ((t > 0x5a && t < 0x61) || (t > 0x7a && t < 0x81)) continue;
        while (u <= 0xd7a3 && ksx.has(u)) u++;
        if (u <= 0xd7a3) uhc.set((l << 8) | t, String.fromCharCode(u++));
      }
    }
    return uhc;
  }
  function decodeCp949(b) {
    const dec = new TextDecoder('euc-kr');
    if (dec.decode(Uint8Array.of(0x81, 0x41)).length === 1) return dec.decode(b);
    const table = uhcTable(dec);
    let out = '';
    let from = 0;
    for (let i = 0; i < b.length; i++) {
      if (b[i] < 0x80 || i + 1 >= b.length) continue;
      const ch = table.get((b[i] << 8) | b[i + 1]);
      if (ch) {
        out += dec.decode(b.subarray(from, i)) + ch;
        from = i + 2;
      }
      i++;
    }
    return out + dec.decode(b.subarray(from));
  }

  // Bytes of a caption file -> text.
  function decode(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b);
    if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
    // UTF-16 without a BOM: the digits and arrows of the timing lines have a zero in every other byte (a few
    // syllables such as U+AC00 put a zero on the other side).
    if (b.length >= 4) {
      let even = 0;
      let odd = 0;
      const pairs = Math.min(b.length, 4096) >> 1;
      for (let i = 0; i < pairs * 2; i += 2) {
        if (b[i] === 0) even++;
        if (b[i + 1] === 0) odd++;
      }
      if (odd > pairs * 0.3 && even < pairs * 0.05) return new TextDecoder('utf-16le').decode(b.subarray(0, b.length & ~1));
      if (even > pairs * 0.3 && odd < pairs * 0.05) return new TextDecoder('utf-16be').decode(b.subarray(0, b.length & ~1));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch {
      return decodeCp949(b);
    }
  }

  // Which parser a file needs, by its content (a VTT file starts with WEBVTT) or its name.
  const isVtt = (text, name = '') => VTT_HEAD.test(text) || /\.vtt$/i.test(name);
  const parseAny = (text, name) => (isVtt(text, name) ? parseVtt(text) : parse(text));

  return { parse, write, parseVtt, writeVtt, decode, parseAny, isVtt, formatTime: fmt };
});
