// Turns a graph into readable Python. Exec nodes become one statement each, following the run-order wires from
// Start (under `def main():`) and from each Define Function; pure nodes are inlined as expressions with only the
// parentheses Python needs. `map[line]` is the node that produced each generated line, so a traceback finds its node.
// VS.compile(graph, {fileName, tr, symbols, language}) -> {code, map, errors, pinExpr, nodeLines}; `symbols` (default
// VS.symbols) tells project and package nodes whether their function still exists. language 'java' (a .jflow file)
// writes a Java class instead: each node type's `java` hooks in place of `compile`, script variables as static fields,
// functions as static methods, and values as Object with the class Rt (javaRuntime below) doing what Python does with
// them, so the same graph prints the same in both languages.
//
// Set Variable names are script variables, as Blueprint's graph variables are: every function that sets one declares
// it `global`, and any function reads it. A value wired from a step (a generated local such as answer_n3, a loop
// index, a function parameter) is only usable where that step has always run before, in the same function.
//
// The context `c` a node's compile hook gets:
//   c.node, c.pins, c.P (precedences), c.tr, c.inLoop, c.inFunction
//   c.prop(key), c.input(pin) -> {code, prec, type, literal, value}, c.arg(pin, minPrec = 0) -> code
//   c.linked(pin), c.execLinked(pin), c.used(outPin), c.local(outPin)
//   c.line(text), c.rawLine(text) (no indent added), c.block(execPin, {loop, fn}), c.fail(message, prop) -> null
//   c.ident(prop), c.identValue(value, prop), c.variable(prop), c.assign(name), c.dotted(name), c.functionExists(name)
//   c.literal(value, type), c.formatText(template), c.pythonExpression(code, names), c.import(module)
//   c.dedent(code) -> [{text, raw}] (raw: the line starts inside a string, so it is kept exactly)
//   c.symbol(module, name) -> the name to call it by (its import added), c.symbols, c.warn(message)
(function (root) {
  'use strict';
  const VS = root.PyideVisualScript || (root.PyideVisualScript = {});

  const P = { TUPLE: -1, LOW: 0, OR: 1, AND: 2, NOT: 3, CMP: 4, BOR: 5, BXOR: 6, BAND: 7, SHIFT: 8, ADD: 9, MUL: 10, UNARY: 11, POW: 12, ATOM: 14 };
  VS.PREC = P;

  const KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
    'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
    'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
  // Names the generated code itself calls; a variable or function with one of them would break it.
  const BUILTINS_USED = ['print', 'input', 'str', 'int', 'float', 'len', 'range', 'RuntimeError', 'main'];
  const NAME = /[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*/uy;
  const IDENT = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*$/u;
  VS.isIdentifier = (s) => typeof s === 'string' && IDENT.test(s) && !KEYWORDS.has(s);

  // ---------- Python literals ----------
  const pyStr = (s) => {
    const quote = s.includes('"') && !s.includes("'") ? "'" : '"';
    let out = '';
    for (const ch of s) {
      const code = ch.codePointAt(0);
      if (ch === '\\') out += '\\\\';
      else if (ch === quote) out += `\\${quote}`;
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
      else out += ch;
    }
    return quote + out + quote;
  };
  VS.pyString = pyStr;

  const pyNumber = (n) => {
    if (Number.isNaN(n)) return { code: 'float("nan")', prec: P.ATOM };
    if (!Number.isFinite(n)) return { code: n > 0 ? 'float("inf")' : '-float("inf")', prec: n > 0 ? P.ATOM : P.UNARY };
    const code = Object.is(n, -0) ? '0' : String(n);
    return { code, prec: n < 0 ? P.UNARY : P.ATOM };
  };

  // ---------- Java ----------
  const JAVA_KEYWORDS = new Set(['abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
    'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if',
    'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected',
    'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
    'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null', 'var', 'yield', 'record', 'sealed', 'permits', '_']);
  // Names the generated class uses; a variable or function with one of them would break it.
  const JAVA_USED = ['main', 'args', 'Rt', 'Object', 'String', 'System', 'Math', 'java'];
  const javaStr = (s) => {
    let out = '';
    for (const ch of s) {
      const code = ch.codePointAt(0);
      if (ch === '\\') out += '\\\\';
      else if (ch === '"') out += '\\"';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
      else out += ch;
    }
    return `"${out}"`;
  };
  VS.javaString = javaStr;
  const javaNumber = (n, big) => {
    if (big !== undefined) return { code: `Rt.big(${javaStr(big)})`, prec: P.ATOM };
    if (Number.isNaN(n)) return { code: 'Double.NaN', prec: P.ATOM };
    if (!Number.isFinite(n)) return { code: n > 0 ? 'Double.POSITIVE_INFINITY' : 'Double.NEGATIVE_INFINITY', prec: P.ATOM };
    if (Number.isInteger(n) && Number.isSafeInteger(n)) return { code: `${Object.is(n, -0) ? 0 : n}L`, prec: n < 0 ? P.UNARY : P.ATOM };
    const t = String(n);
    return { code: /[.eE]/.test(t) ? t : `${t}.0`, prec: n < 0 ? P.UNARY : P.ATOM };
  };
  // The class name of a script: its file name made a Java identifier, first letter upper case.
  VS.javaClassName = (fileName) => {
    let n = String(fileName || 'Script').replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{Nd}_$]/gu, '_');
    if (!n || /^\p{Nd}/u.test(n)) n = `Script_${n}`;
    n = n[0].toUpperCase() + n.slice(1);
    return JAVA_KEYWORDS.has(n) || JAVA_USED.includes(n) ? `${n}Script` : n;
  };
  // Java Expression: the names of its inputs are replaced by the values wired in (strings, chars and comments kept).
  function javaTokens(code) {
    const toks = [];
    let i = 0;
    while (i < code.length) {
      const ch = code[i];
      if (/\s/.test(ch)) { let j = i; while (j < code.length && /\s/.test(code[j])) j++; toks.push({ kind: 'space', text: code.slice(i, j) }); i = j; continue; }
      if (code.startsWith('//', i)) { let j = code.indexOf('\n', i); if (j < 0) j = code.length; toks.push({ kind: 'comment', text: code.slice(i, j) }); i = j; continue; }
      if (code.startsWith('/*', i)) { let j = code.indexOf('*/', i + 2); j = j < 0 ? code.length : j + 2; toks.push({ kind: 'comment', text: code.slice(i, j) }); i = j; continue; }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < code.length && code[j] !== ch && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
        j = Math.min(code.length, j + 1);
        toks.push({ kind: 'string', text: code.slice(i, j) }); i = j; continue;
      }
      const m = /[\p{L}_$][\p{L}\p{Nd}_$]*/uy;
      m.lastIndex = i;
      const name = m.exec(code);
      if (name) { toks.push({ kind: 'name', text: name[0] }); i += name[0].length; continue; }
      toks.push({ kind: 'op', text: ch }); i++;
    }
    return toks;
  }
  // The runtime every generated class ends with: Python's rules for the values a graph handles (int as Long, float as
  // Double, str, bool, None as null, list as ArrayList), so a .jflow behaves like the same graph in a .pyflow.
  VS.javaRuntime = `// Nano Studio visual script runtime: values behave as in the Python version of the graph.
static final class Rt {
    static final java.util.Scanner IN = new java.util.Scanner(System.in, java.nio.charset.StandardCharsets.UTF_8);
    static RuntimeException error(String type, String message) { return new RuntimeException(type + ": " + message); }
    static String typeName(Object v) {
        if (v == null) return "NoneType";
        if (v instanceof Boolean) return "bool";
        if (v instanceof Long || v instanceof java.math.BigInteger) return "int";
        if (v instanceof Double) return "float";
        if (v instanceof String) return "str";
        if (v instanceof java.util.List) return "list";
        return v.getClass().getSimpleName();
    }
    static boolean isInt(Object v) { return v instanceof Long || v instanceof Boolean || v instanceof Integer; }
    static boolean isNum(Object v) { return v instanceof Number || v instanceof Boolean; }
    static long asLong(Object v) {
        if (v instanceof Boolean) return ((Boolean) v) ? 1 : 0;
        if (v instanceof Long || v instanceof Integer) return ((Number) v).longValue();
        throw error("TypeError", "'" + typeName(v) + "' object cannot be interpreted as an integer");
    }
    static double asDouble(Object v) {
        if (v instanceof Boolean) return ((Boolean) v) ? 1 : 0;
        if (v instanceof Number) return ((Number) v).doubleValue();
        throw error("TypeError", "must be real number, not " + typeName(v));
    }
    static Object big(String digits) { return Double.parseDouble(digits); }
    static RuntimeException operands(String op, Object a, Object b) {
        return error("TypeError", "unsupported operand type(s) for " + op + ": '" + typeName(a) + "' and '" + typeName(b) + "'");
    }
    static boolean truthy(Object v) {
        if (v == null) return false;
        if (v instanceof Boolean) return (Boolean) v;
        if (v instanceof Number) return ((Number) v).doubleValue() != 0;
        if (v instanceof String) return !((String) v).isEmpty();
        if (v instanceof java.util.List) return !((java.util.List<?>) v).isEmpty();
        return true;
    }
    static Object add(Object a, Object b) {
        if (isInt(a) && isInt(b)) return asLong(a) + asLong(b);
        if (isNum(a) && isNum(b)) return asDouble(a) + asDouble(b);
        if (a instanceof String && b instanceof String) return (String) a + (String) b;
        if (a instanceof java.util.List && b instanceof java.util.List) {
            java.util.List<Object> out = new java.util.ArrayList<>((java.util.List<?>) a);
            out.addAll((java.util.List<?>) b);
            return out;
        }
        throw operands("+", a, b);
    }
    static Object sub(Object a, Object b) {
        if (isInt(a) && isInt(b)) return asLong(a) - asLong(b);
        if (isNum(a) && isNum(b)) return asDouble(a) - asDouble(b);
        throw operands("-", a, b);
    }
    static Object mul(Object a, Object b) {
        if (isInt(a) && isInt(b)) return asLong(a) * asLong(b);
        if (isNum(a) && isNum(b)) return asDouble(a) * asDouble(b);
        if (a instanceof String && isInt(b)) return ((String) a).repeat((int) Math.max(0, asLong(b)));
        if (isInt(a) && b instanceof String) return ((String) b).repeat((int) Math.max(0, asLong(a)));
        throw operands("*", a, b);
    }
    static Object div(Object a, Object b) {
        if (!isNum(a) || !isNum(b)) throw operands("/", a, b);
        if (asDouble(b) == 0) throw error("ZeroDivisionError", "division by zero");
        return asDouble(a) / asDouble(b);
    }
    static Object floordiv(Object a, Object b) {
        if (!isNum(a) || !isNum(b)) throw operands("//", a, b);
        if (asDouble(b) == 0) throw error("ZeroDivisionError", isInt(a) && isInt(b) ? "integer division or modulo by zero" : "float floor division by zero");
        if (isInt(a) && isInt(b)) return Math.floorDiv(asLong(a), asLong(b));
        return Math.floor(asDouble(a) / asDouble(b));
    }
    static Object mod(Object a, Object b) {
        if (!isNum(a) || !isNum(b)) throw operands("%", a, b);
        if (asDouble(b) == 0) throw error("ZeroDivisionError", isInt(a) && isInt(b) ? "integer modulo by zero" : "float modulo");
        if (isInt(a) && isInt(b)) return Math.floorMod(asLong(a), asLong(b));
        double x = asDouble(a), y = asDouble(b);
        return x - Math.floor(x / y) * y;
    }
    static Object pow(Object a, Object b) {
        if (!isNum(a) || !isNum(b)) throw operands("** or pow()", a, b);
        if (isInt(a) && isInt(b) && asLong(b) >= 0) {
            long base = asLong(a), e = asLong(b), r = 1;
            while (e-- > 0) r *= base;
            return r;
        }
        return Math.pow(asDouble(a), asDouble(b));
    }
    static Object neg(Object v) {
        if (isInt(v)) return -asLong(v);
        if (isNum(v)) return -asDouble(v);
        throw error("TypeError", "bad operand type for unary -: '" + typeName(v) + "'");
    }
    static Boolean not(Object v) { return !truthy(v); }
    static boolean equal(Object a, Object b) {
        if (isNum(a) && isNum(b)) return isInt(a) && isInt(b) ? asLong(a) == asLong(b) : asDouble(a) == asDouble(b);
        if (a instanceof java.util.List && b instanceof java.util.List) {
            java.util.List<?> x = (java.util.List<?>) a, y = (java.util.List<?>) b;
            if (x.size() != y.size()) return false;
            for (int i = 0; i < x.size(); i++) if (!equal(x.get(i), y.get(i))) return false;
            return true;
        }
        return java.util.Objects.equals(a, b);
    }
    static Boolean eq(Object a, Object b) { return equal(a, b); }
    static Boolean ne(Object a, Object b) { return !equal(a, b); }
    static int order(String op, Object a, Object b) {
        if (isNum(a) && isNum(b)) return isInt(a) && isInt(b) ? Long.compare(asLong(a), asLong(b)) : Double.compare(asDouble(a), asDouble(b));
        if (a instanceof String && b instanceof String) return ((String) a).compareTo((String) b);
        throw error("TypeError", "'" + op + "' not supported between instances of '" + typeName(a) + "' and '" + typeName(b) + "'");
    }
    static Boolean lt(Object a, Object b) { return order("<", a, b) < 0; }
    static Boolean le(Object a, Object b) { return order("<=", a, b) <= 0; }
    static Boolean gt(Object a, Object b) { return order(">", a, b) > 0; }
    static Boolean ge(Object a, Object b) { return order(">=", a, b) >= 0; }
    static String floatText(double d) {
        if (Double.isNaN(d)) return "nan";
        if (Double.isInfinite(d)) return d > 0 ? "inf" : "-inf";
        if (d == 0) return 1 / d < 0 ? "-0.0" : "0.0";
        java.math.BigDecimal x = new java.math.BigDecimal(Double.toString(d)).stripTrailingZeros();
        String digits = x.unscaledValue().abs().toString();
        int exp = digits.length() - 1 - x.scale();
        String sign = d < 0 ? "-" : "";
        if (exp >= -4 && exp < 16) {
            String plain = x.abs().toPlainString();
            return sign + (plain.contains(".") ? plain : plain + ".0");
        }
        String mantissa = digits.length() > 1 ? digits.charAt(0) + "." + digits.substring(1) : digits;
        return sign + mantissa + "e" + (exp < 0 ? "-" : "+") + (Math.abs(exp) < 10 ? "0" : "") + Math.abs(exp);
    }
    static String str(Object v) {
        if (v == null) return "None";
        if (v instanceof Boolean) return ((Boolean) v) ? "True" : "False";
        if (v instanceof Double) return floatText((Double) v);
        if (v instanceof java.util.List) {
            StringBuilder b = new StringBuilder("[");
            for (Object x : (java.util.List<?>) v) { if (b.length() > 1) b.append(", "); b.append(repr(x)); }
            return b.append("]").toString();
        }
        return String.valueOf(v);
    }
    static String repr(Object v) {
        if (!(v instanceof String)) return str(v);
        String s = (String) v;
        char q = s.contains("'") && !s.contains("\\"") ? '"' : '\\'';
        StringBuilder b = new StringBuilder().append(q);
        for (char c : s.toCharArray()) {
            if (c == '\\\\') b.append("\\\\\\\\");
            else if (c == q) b.append('\\\\').append(c);
            else if (c == '\\n') b.append("\\\\n");
            else if (c == '\\r') b.append("\\\\r");
            else if (c == '\\t') b.append("\\\\t");
            else b.append(c);
        }
        return b.append(q).toString();
    }
    static Object print(Object v) { System.out.println(str(v)); return null; }
    static Object input(Object prompt) {
        System.out.print(str(prompt));
        System.out.flush();
        if (!IN.hasNextLine()) throw error("EOFError", "EOF when reading a line");
        return IN.nextLine();
    }
    @SafeVarargs static <T> java.util.List<Object> list(T... items) { return new java.util.ArrayList<>(java.util.Arrays.asList(items)); }
    @SuppressWarnings("unchecked")
    static Object append(Object list, Object item) {
        if (!(list instanceof java.util.List)) throw error("AttributeError", "'" + typeName(list) + "' object has no attribute 'append'");
        ((java.util.List<Object>) list).add(item);
        return null;
    }
    static Object len(Object v) {
        if (v instanceof String) return (long) ((String) v).codePointCount(0, ((String) v).length());
        if (v instanceof java.util.List) return (long) ((java.util.List<?>) v).size();
        throw error("TypeError", "object of type '" + typeName(v) + "' has no len()");
    }
    static Object get(Object v, Object index) {
        long i = asLong(index);
        if (v instanceof java.util.List) {
            java.util.List<?> l = (java.util.List<?>) v;
            long k = i < 0 ? i + l.size() : i;
            if (k < 0 || k >= l.size()) throw error("IndexError", "list index out of range");
            return l.get((int) k);
        }
        if (v instanceof String) {
            int[] cps = ((String) v).codePoints().toArray();
            long k = i < 0 ? i + cps.length : i;
            if (k < 0 || k >= cps.length) throw error("IndexError", "string index out of range");
            return new String(cps, (int) k, 1);
        }
        throw error("TypeError", "'" + typeName(v) + "' object is not subscriptable");
    }
    static Iterable<Object> range(Object start, Object stop, Object step) {
        long a = asLong(start), b = asLong(stop), s = asLong(step);
        if (s == 0) throw error("ValueError", "range() arg 3 must not be zero");
        java.util.List<Object> out = new java.util.ArrayList<>();
        for (long i = a; s > 0 ? i < b : i > b; i += s) out.add(i);
        return out;
    }
    @SuppressWarnings("unchecked")
    static Iterable<Object> iter(Object v) {
        if (v instanceof java.util.List) return new java.util.ArrayList<>((java.util.List<Object>) v);
        if (v instanceof String) {
            java.util.List<Object> out = new java.util.ArrayList<>();
            ((String) v).codePoints().forEach(c -> out.add(new String(Character.toChars(c))));
            return out;
        }
        throw error("TypeError", "'" + typeName(v) + "' object is not iterable");
    }
    static Object toInt(Object v) {
        if (isInt(v)) return asLong(v);
        if (v instanceof Double) return (long) (double) (Double) v;
        if (v instanceof String) {
            try { return Long.parseLong(((String) v).trim().replace("_", "")); } catch (NumberFormatException e) {
                throw error("ValueError", "invalid literal for int() with base 10: " + repr(v));
            }
        }
        throw error("TypeError", "int() argument must be a string or a real number, not '" + typeName(v) + "'");
    }
    static Object toFloat(Object v) {
        if (isNum(v)) return asDouble(v);
        if (v instanceof String) {
            String t = ((String) v).trim().toLowerCase();
            if (t.equals("inf") || t.equals("+inf") || t.equals("infinity")) return Double.POSITIVE_INFINITY;
            if (t.equals("-inf") || t.equals("-infinity")) return Double.NEGATIVE_INFINITY;
            if (t.equals("nan")) return Double.NaN;
            try { return Double.parseDouble(t); } catch (NumberFormatException e) {
                throw error("ValueError", "could not convert string to float: " + repr(v));
            }
        }
        throw error("TypeError", "float() argument must be a string or a real number, not '" + typeName(v) + "'");
    }
    static String join(Object a, Object b) { return str(a) + str(b); }
    // A field of Format Text: conversion r or s, then a format spec (fill, align, width, precision and f, d, %).
    static String fmt(Object v, char conv, String spec) {
        String text = conv == 'r' ? repr(v) : str(v);
        if (spec.isEmpty()) return text;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?:(.)?([<>^]))?([+ -])?(0)?(\\\\d+)?(,)?(?:\\\\.(\\\\d+))?([dfFeE%sg])?").matcher(spec);
        if (!m.matches()) throw error("ValueError", "Invalid format specifier '" + spec + "'");
        String fill = m.group(1) != null ? m.group(1) : (m.group(4) != null ? "0" : " ");
        String align = m.group(2) != null ? m.group(2) : (isNum(v) && conv != 'r' ? ">" : "<");
        String type = m.group(8);
        String body = text;
        if (conv != 'r' && type != null && !type.equals("s")) {
            Integer prec = m.group(7) != null ? Integer.valueOf(m.group(7)) : null;
            String flags = (m.group(3) != null && !m.group(3).equals("-") ? m.group(3) : "") + (m.group(6) != null ? "," : "");
            if (type.equals("d")) body = String.format(java.util.Locale.ROOT, "%" + flags + "d", asLong(v));
            else if (type.equals("%")) body = String.format(java.util.Locale.ROOT, "%" + flags + "." + (prec == null ? 6 : prec) + "f", asDouble(v) * 100) + "%";
            else if (type.equalsIgnoreCase("e")) body = floatSci(asDouble(v), prec == null ? 6 : prec, type.equals("E"));
            else if (type.equals("g")) body = floatText(asDouble(v));
            else body = String.format(java.util.Locale.ROOT, "%" + flags + "." + (prec == null ? 6 : prec) + "f", asDouble(v));
        } else if (m.group(7) != null && !isNum(v)) {
            int n = Integer.parseInt(m.group(7));
            if (body.length() > n) body = body.substring(0, n);
        } else if (m.group(7) != null && conv != 'r') {
            body = String.format(java.util.Locale.ROOT, "%." + m.group(7) + "f", asDouble(v));
        }
        int width = m.group(5) != null ? Integer.parseInt(m.group(5)) : 0;
        int pad = width - body.codePointCount(0, body.length());
        if (pad <= 0) return body;
        if (align.equals(">")) return fill.repeat(pad) + body;
        if (align.equals("^")) return fill.repeat(pad / 2) + body + fill.repeat(pad - pad / 2);
        return body + fill.repeat(pad);
    }
    static String floatSci(double d, int prec, boolean upper) {
        String s = String.format(java.util.Locale.ROOT, "%." + prec + "e", d);
        int e = s.indexOf('e');
        String exp = s.substring(e + 1);
        String sign = exp.startsWith("-") ? "-" : "+";
        String digits = exp.replaceFirst("^[+-]", "").replaceFirst("^0+(?=\\\\d\\\\d)", "");
        String out = s.substring(0, e) + "e" + sign + digits;
        return upper ? out.toUpperCase() : out;
    }
}`;

  // ---------- a small Python tokenizer (enough to find names, strings and top-level operators) ----------
  const OPS = ['**=', '//=', '>>=', '<<=', '...', '**', '//', '==', '!=', '<=', '>=', '->', ':=', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@='];
  function tokenize(code) {
    const toks = [];
    let i = 0;
    while (i < code.length) {
      const ch = code[i];
      if (/\s/.test(ch)) {
        let j = i;
        while (j < code.length && /\s/.test(code[j])) j++;
        toks.push({ kind: 'space', text: code.slice(i, j) });
        i = j;
        continue;
      }
      if (ch === '#') {
        let j = code.indexOf('\n', i);
        if (j < 0) j = code.length;
        toks.push({ kind: 'comment', text: code.slice(i, j) });
        i = j;
        continue;
      }
      NAME.lastIndex = i;
      const name = NAME.exec(code);
      let prefix = '';
      if (name) {
        const after = code[i + name[0].length];
        if (/^[rRbBuUfF]{1,2}$/.test(name[0]) && (after === '"' || after === "'")) prefix = name[0];
        else {
          toks.push({ kind: 'name', text: name[0] });
          i += name[0].length;
          continue;
        }
      }
      const q = code[i + prefix.length];
      if (q === '"' || q === "'") {
        const start = i;
        const triple = code.startsWith(q.repeat(3), i + prefix.length);
        const delim = triple ? q.repeat(3) : q;
        let j = i + prefix.length + delim.length;
        while (j < code.length && !code.startsWith(delim, j)) {
          if (code[j] === '\\') j++;
          else if (!triple && code[j] === '\n') break;
          j++;
        }
        j = Math.min(code.length, j + delim.length);
        toks.push({ kind: 'string', text: code.slice(start, j), prefix });
        i = j;
        continue;
      }
      const num = /(?:\d|\.\d)(?:[eE][+-]\d|[\w.])*/y;
      num.lastIndex = i;
      const m = num.exec(code);
      if (m) {
        toks.push({ kind: 'number', text: m[0] });
        i += m[0].length;
        continue;
      }
      const op = OPS.find((o) => code.startsWith(o, i)) || ch;
      toks.push({ kind: 'op', text: op });
      i += op.length;
    }
    return toks;
  }

  const BIN_PREC = { '|': P.BOR, '^': P.BXOR, '&': P.BAND, '<<': P.SHIFT, '>>': P.SHIFT, '+': P.ADD, '-': P.ADD,
    '*': P.MUL, '/': P.MUL, '//': P.MUL, '%': P.MUL, '@': P.MUL, '**': P.POW,
    '==': P.CMP, '!=': P.CMP, '<': P.CMP, '<=': P.CMP, '>': P.CMP, '>=': P.CMP };
  const WORD_PREC = { or: P.OR, and: P.AND, not: P.NOT, in: P.CMP, is: P.CMP, if: P.LOW, lambda: P.LOW, for: P.TUPLE, yield: P.TUPLE };

  // The loosest operator at the top level of an expression decides where it needs parentheses.
  function expressionPrec(toks) {
    let depth = 0;
    let prec = P.ATOM;
    let prev = null;
    for (const t of toks) {
      if (t.kind === 'space' || t.kind === 'comment') continue;
      if (t.kind === 'op' && '([{'.includes(t.text)) depth++;
      else if (t.kind === 'op' && ')]}'.includes(t.text)) depth--;
      else if (depth === 0) {
        let p = null;
        if (t.kind === 'op' && (t.text === ',' || t.text === ':=')) p = P.TUPLE;
        else if (t.kind === 'op' && t.text === '*' && !prev) p = P.TUPLE;
        else if (t.kind === 'op' && (t.text === '-' || t.text === '+' || t.text === '~')) {
          p = prev && (prev.kind !== 'op' || ')]}'.includes(prev.text)) ? P.ADD : P.UNARY;
        } else if (t.kind === 'op' && t.text in BIN_PREC) p = BIN_PREC[t.text];
        else if (t.kind === 'name' && t.text in WORD_PREC) p = t.text === 'not' && prev && prev.kind === 'name' && prev.text !== 'not' && !(prev.text in WORD_PREC) ? P.CMP : WORD_PREC[t.text];
        if (p !== null && p < prec) prec = p;
      }
      prev = t;
    }
    return prec;
  }

  // Lines (0-based) of `code` that start inside a string: a triple-quoted string's later lines, a line continued with \.
  function stringLines(code) {
    const inside = new Set();
    let line = 0;
    for (const t of tokenize(code)) {
      for (const ch of t.text) {
        if (ch !== '\n') continue;
        line++;
        if (t.kind === 'string') inside.add(line);
      }
    }
    return inside;
  }

  // A string token that ends with its own closing quote(s).
  function closedString(t) {
    const body = t.text.slice(t.prefix.length);
    const q = body[0];
    const delim = body.startsWith(q.repeat(3)) && body.length >= 6 ? q.repeat(3) : q;
    for (let i = delim.length; i < body.length; i++) {
      if (body[i] === '\\') i++;
      else if (body.startsWith(delim, i)) return i + delim.length === body.length;
    }
    return false;
  }
  const PY_NUMBER = /^(?:0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?[jJ]?)$/;
  const PAIRS = { ')': '(', ']': '[', '}': '{' };
  // One Python literal on one line: numbers, strings (not f-strings), True, False, None, ... and lists, tuples, sets and
  // dicts of them. No name other than those three can appear, so nothing in it can call or import anything.
  VS.isPythonLiteral = (text) => {
    const s = String(text ?? '');
    if (!s.trim() || /[\r\n]/.test(s)) return false;
    const open = [];
    for (const t of tokenize(s)) {
      if (t.kind === 'space') continue;
      if (t.kind === 'name') { if (!['True', 'False', 'None'].includes(t.text)) return false; continue; }
      if (t.kind === 'number') { if (!PY_NUMBER.test(t.text)) return false; continue; }
      if (t.kind === 'string') { if (/f/i.test(t.prefix) || !closedString(t)) return false; continue; }
      if (t.kind !== 'op') return false;
      if ('([{'.includes(t.text)) open.push(t.text);
      else if (t.text in PAIRS) { if (open.pop() !== PAIRS[t.text]) return false; }
      else if (t.text === ',') { if (!open.length) return false; }
      else if (t.text === ':') { if (open[open.length - 1] !== '{') return false; }
      else if (!['-', '+', '...'].includes(t.text)) return false;
    }
    return !open.length;
  };

  const wrap = (e, min) => (e.prec < min ? `(${e.code})` : e.code);

  VS.hasErrors = (result) => result.errors.some((e) => !e.warning);
  // A .jflow file is a Java visual script; every other one (.pyflow) Python.
  VS.languageOf = (path) => (/\.jflow$/i.test(String(path || '')) ? 'java' : 'python');

  // ---------- compile ----------
  VS.compile = (graph, opts = {}) => {
    const tr = (text, vars) => (opts.tr || VS.tr)(text, vars);
    const fileName = String(opts.fileName || 'script.pyflow').replace(/[\r\n]+/g, ' ');
    const java = opts.language === 'java';
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    const sorted = [...graph.nodes].sort((a, b) => VS.compareIds(a.id, b.id));
    const defOf = (n) => VS.nodeType(n.type);
    // A node type's code generation for this language. A node only the other language has (Python Code in a .jflow)
    // is a problem at that node and raises at run time, like any node in error.
    const stubs = new Map();
    const hooksOf = (d) => {
      if (!d) return null;
      const own = java ? d.java : d.compile;
      const other = java ? d.compile : d.java;
      if (own || !other) return own || null;
      if (!stubs.has(d.type)) {
        const message = () => tr(java ? '{node} works only in Python visual scripts.' : '{node} works only in Java visual scripts.', { node: tr(d.title) });
        stubs.set(d.type, {
          ...(other.stmt ? { stmt: (c) => { c.fail(message()); return c.pins.execOut.some((p) => p.id === 'next') ? 'next' : null; } } : {}),
          ...(other.expr ? { expr: (c) => { c.fail(message()); return { code: java ? 'null' : 'None', prec: P.ATOM }; } } : {}),
        });
      }
      return stubs.get(d.type);
    };
    const NONE = java ? 'null' : 'None';
    const pinsCache = new Map();
    const pinsOf = (n) => {
      if (!pinsCache.has(n.id)) pinsCache.set(n.id, VS.pinsOf(n, graph));
      return pinsCache.get(n.id);
    };
    const key = (id, pin) => `${id}\u0000${pin}`;
    const isStatement = (n) => !!hooksOf(defOf(n))?.stmt;
    const isPure = (n) => !!hooksOf(defOf(n))?.expr;

    const errors = [];
    const reported = new Set();
    let silent = false; // while pinExpr compiles pure nodes again, their problems are already known
    const report = (node, message, extra = {}) => {
      if (silent) return;
      const k = `${node}\u0000${extra.pin || ''}\u0000${extra.prop || ''}\u0000${message}`;
      if (reported.has(k)) return;
      reported.add(k);
      const e = { node: node || null, message };
      if (extra.pin) e.pin = extra.pin;
      if (extra.prop) e.prop = extra.prop;
      if (extra.warning) e.warning = true;
      errors.push(e);
    };

    for (const n of sorted) if (!defOf(n)) report(n.id, tr('Unknown node type "{type}".', { type: n.type }));

    // ---------- wires ----------
    const dataIn = new Map();
    const execNext = new Map();
    const usedOut = new Set();
    const dataEdges = new Map();
    const links = [...graph.links].sort((a, b) => VS.compareIds(a.from.node, b.from.node)
      || (a.from.pin < b.from.pin ? -1 : a.from.pin > b.from.pin ? 1 : 0)
      || VS.compareIds(a.to.node, b.to.node) || (a.to.pin < b.to.pin ? -1 : a.to.pin > b.to.pin ? 1 : 0));
    for (const l of links) {
      const from = nodes.get(l.from.node);
      const to = nodes.get(l.to.node);
      if (!from || !to || !defOf(from) || !defOf(to)) continue;
      const a = VS.findPin(graph, l.from);
      const b = VS.findPin(graph, l.to);
      if (!a || !b) {
        report(to.id, tr('A wire is connected to a pin that no longer exists. Delete the wire.'), { pin: l.to.pin });
        continue;
      }
      if (a.dir !== 'out' || b.dir !== 'in' || a.kind !== b.kind) {
        report(to.id, tr('This wire joins two pins that cannot be connected.'), { pin: l.to.pin });
        continue;
      }
      if (a.kind === 'data' && !VS.compatible(a.type, b.type)) {
        report(to.id, tr('A {from} value cannot go into a {to} input.', { from: VS.typeLabel(a.type), to: VS.typeLabel(b.type) }), { pin: l.to.pin });
        continue;
      }
      if (a.kind === 'data') {
        if (dataIn.has(key(to.id, b.pin))) {
          report(to.id, tr('This input has more than one wire.'), { pin: b.pin });
          continue;
        }
        dataIn.set(key(to.id, b.pin), { node: from.id, pin: a.pin, type: a.type });
        usedOut.add(key(from.id, a.pin));
        if (!dataEdges.has(from.id)) dataEdges.set(from.id, new Set());
        dataEdges.get(from.id).add(to.id);
      } else {
        if (execNext.has(key(from.id, a.pin))) {
          report(from.id, tr('This run-order output has more than one wire.'), { pin: a.pin });
          continue;
        }
        execNext.set(key(from.id, a.pin), to.id);
      }
    }

    // A value that depends on itself can never be computed.
    {
      const state = new Map();
      const visit = (id, stack) => {
        state.set(id, 1);
        stack.push(id);
        for (const next of dataEdges.get(id) || []) {
          if (state.get(next) === 1) {
            for (const c of stack.slice(stack.indexOf(next))) report(c, tr('This value depends on itself: its wires go in a circle.'));
          } else if (!state.has(next)) visit(next, stack);
        }
        stack.pop();
        state.set(id, 2);
      };
      for (const n of sorted) if (!state.has(n.id)) visit(n.id, []);
    }

    // ---------- names ----------
    const starts = sorted.filter((n) => n.type === 'core.start');
    const defines = sorted.filter((n) => n.type === 'fn.define');
    const functions = new Map();
    for (const d of defines) {
      const name = VS.propOf(d, 'name');
      if (functions.has(name)) report(d.id, tr('Two functions are named "{name}".', { name }), { prop: 'name' });
      else functions.set(name, d);
    }
    const moduleRoots = new Set(sorted.filter((n) => n.type === 'py.call')
      .map((n) => String(VS.propOf(n, 'module') || '').trim().split('.')[0]).filter(Boolean));
    // Every name a node stores a value under: [node, prop, name].
    const named = [];
    for (const n of sorted) {
      if (n.type === 'var.set') named.push([n, 'name', VS.propOf(n, 'name')]);
      if (n.type === 'fn.define') VS.parseNames(VS.propOf(n, 'params')).forEach((p) => named.push([n, 'params', p]));
      if (n.type === 'py.code' || n.type === 'java.code') ['inputs', 'outputs'].forEach((k) => VS.parseNames(VS.propOf(n, k)).forEach((p) => named.push([n, k, p])));
    }
    const variables = new Set(named.map(([, , name]) => name));
    const scriptVariables = new Set(named.filter(([n]) => n.type === 'var.set').map(([, , name]) => name));
    // Calling a function whose name a variable also holds would call the value (or fail before it is set).
    for (const [n, prop, name] of named) {
      if (functions.has(name)) report(n.id, tr('A function is also named "{name}". Give the variable or the function another name.', { name }), { prop });
    }
    for (const [name, d] of functions) {
      if (variables.has(name)) report(d.id, tr('A variable is also named "{name}". Give the variable or the function another name.', { name }), { prop: 'name' });
    }

    // Project and package symbols: `from geo.figures import area` and `area(2)`, unless two modules give the same
    // name or the name is taken by the script itself; then `import geo.figures` and `geo.figures.area(2)`.
    const symbols = opts.symbols !== undefined ? opts.symbols : VS.symbols;
    const symbolNodes = sorted.filter((n) => (VS.SYMBOL_TYPES || []).includes(n.type));
    const providers = new Map();
    for (const n of symbolNodes) {
      const p = n.props || {};
      const name = n.type === 'py.function' ? p.name : p.class;
      if (typeof name !== 'string' || typeof p.module !== 'string') continue;
      if (!providers.has(name)) providers.set(name, new Set());
      providers.get(name).add(p.module);
    }
    const usesAsync = symbolNodes.some((n) => n.type !== 'py.new' && n.props && n.props.async);
    const taken = new Set([...BUILTINS_USED, ...moduleRoots, ...variables, ...functions.keys(), ...(usesAsync ? ['asyncio'] : [])]);
    const symbolRefs = new Map(); // module \0 name -> {module, name, ref, from?, alias?}
    for (const [name, modules] of providers) {
      for (const module of modules) {
        const ref = { module, name };
        if (modules.size === 1 && !taken.has(name)) Object.assign(ref, { from: true, ref: name });
        else if (taken.has(module.split('.')[0])) {
          const alias = `${module.replace(/\./g, '_')}_module`;
          Object.assign(ref, { alias, ref: `${alias}.${name}` });
        }
        else ref.ref = `${module}.${name}`;
        symbolRefs.set(`${module}\u0000${name}`, ref);
      }
    }
    const reserved = new Set(java ? [...JAVA_USED, VS.javaClassName(fileName)] : [...BUILTINS_USED, ...moduleRoots, ...(usesAsync ? ['asyncio'] : [])]);
    for (const r of symbolRefs.values()) reserved.add(r.from ? r.name : r.alias || r.module.split('.')[0]);

    if (!starts.length) report(null, tr('The script has no Start node. Add one to say where it begins.'));
    for (const s of starts.slice(1)) report(s.id, tr('A script can have only one Start node.'));

    // ---------- emission ----------
    let lines = [];
    let indent = 0;
    const emit = (text, node) => lines.push({ text: text ? '    '.repeat(indent) + text : '', node });
    const imports = new Map();
    const fromImports = new Map(); // module -> Map(name -> first node)
    const visited = new Set();
    const path = new Set();
    const evaluating = new Set();

    // Where each step was emitted: {fn: its entry node, path: [[block, index], ...]} from the function's body down to
    // the block it is in. `fn` is the entry being compiled: {id, assigned: names it stores, params}.
    const position = new Map();
    let fn = null;
    let openBlocks = []; // the blocks being emitted, outermost first: {id, n: steps so far, at: the step being compiled}
    let blockSeq = 0;
    const uses = []; // {stmt, pin, producer}: a step reads a value an earlier step (or its entry) made
    function enterBlock() {
      openBlocks.push({ id: ++blockSeq, n: 0, at: -1 });
    }
    function place(id) {
      const top = openBlocks[openBlocks.length - 1];
      position.set(id, { fn: fn.id, path: [...openBlocks.slice(0, -1).map((b) => [b.id, b.at]), [top.id, top.n]] });
      top.at = top.n++;
    }
    // Does `producer` always run before `stmt`? Steps run in their block's order; a loop's outputs exist only inside
    // its body; an entry's (its parameters) everywhere in its function.
    function runsBefore(producer, stmt) {
      const a = position.get(producer);
      const b = position.get(stmt);
      if (!a || !b || a.fn !== b.fn) return false;
      const k = a.path.length - 1;
      if (k < 0) return true;
      const s = b.path;
      if (s.length <= k || s[k][0] !== a.path[k][0]) return false;
      if (defOf(nodes.get(producer)).outputScope === 'body') return s[k][1] === a.path[k][1] && s.length > k + 1;
      return s[k][1] > a.path[k][1];
    }

    function context(node, scope, owner) {
      const def = defOf(node);
      const c = {
        node, P, tr,
        stmt: owner ? owner.stmt : node.id,
        via: null,
        pins: pinsOf(node),
        inLoop: !!scope.loop,
        inFunction: !!scope.fn,
        pending: owner ? owner.pending : [],
        prop: (k) => VS.propOf(node, k),
        linked: (pin) => dataIn.has(key(node.id, pin)),
        execLinked: (pin) => execNext.has(key(node.id, pin)),
        used: (pin) => usedOut.has(key(node.id, pin)),
        local: (pin) => `${pin}_${node.id}`,
        fail(message, prop) {
          report(node.id, message, prop ? { prop } : {});
          c.pending.push({ node: node.id, message });
          return null;
        },
        failPin(message, pin) {
          report(node.id, message, { pin });
          c.pending.push({ node: node.id, message });
        },
        line(text) {
          flush(c);
          emit(text, node.id);
        },
        rawLine(text) {
          flush(c);
          lines.push({ text, node: node.id });
        },
        block(pin, opts = {}) {
          flush(c);
          indent++;
          const before = lines.length;
          const target = execNext.get(key(node.id, pin));
          enterBlock();
          if (target) chain(target, { loop: scope.loop || opts.loop, fn: scope.fn || opts.fn });
          openBlocks.pop();
          if (lines.length === before && !java) emit('pass', node.id);
          indent--;
        },
        assign(name) {
          if (fn) fn.assigned.add(name);
        },
        import(module) {
          if (!imports.has(module)) imports.set(module, node.id);
        },
        symbols,
        warn: (message) => report(node.id, message, { warning: true }),
        // The name that refers to `name` from `module` in the generated code; its import is added.
        symbol(module, name) {
          const r = symbolRefs.get(`${module}\u0000${name}`);
          if (r.from) {
            if (!fromImports.has(module)) fromImports.set(module, new Map());
            if (!fromImports.get(module).has(name)) fromImports.get(module).set(name, node.id);
          } else c.import(r.alias ? `${module} as ${r.alias}` : module);
          return r.ref;
        },
        dotted: (s) => typeof s === 'string' && s.split('.').every(VS.isIdentifier),
        functionExists: (name) => functions.has(name),
        identValue(value, prop) {
          const name = String(value ?? '').trim();
          let message = null;
          if (!name) message = tr('Enter a name.');
          else if (!java && KEYWORDS.has(name)) message = tr('"{name}" is a Python keyword and cannot be used as a name.', { name });
          else if (java && JAVA_KEYWORDS.has(name)) message = tr('"{name}" is a Java keyword and cannot be used as a name.', { name });
          else if (!IDENT.test(name)) message = tr('"{name}" cannot be used as a name. Use letters, digits and _, and do not start with a digit.', { name });
          else if (reserved.has(name)) message = tr('"{name}" is already used by the generated code. Choose another name.', { name });
          if (!message) return name;
          c.fail(message, prop);
          // A replacement that stays valid Python, distinct for each name of a list prop ("a, 1b, 2c").
          const whole = String(c.prop(prop) ?? '').trim();
          return name === whole ? `${prop}_${node.id}` : `${prop}${VS.parseNames(whole).indexOf(name) + 1}_${node.id}`;
        },
        ident: (prop) => c.identValue(c.prop(prop), prop),
        variable(prop) {
          const name = c.ident(prop);
          if (name === `${prop}_${node.id}`) return name;
          if (!variables.has(name)) c.fail(tr('No Set Variable stores a value named "{name}".', { name }), prop);
          return name;
        },
        input(pin) {
          const src = dataIn.get(key(node.id, pin));
          const pinDef = c.pins.inputs.find((p) => p.id === pin);
          if (!src) {
            const v = node.inputs && node.inputs[pin] !== undefined ? node.inputs[pin] : pinDef && pinDef.default;
            if (v === undefined) {
              if (pinDef && !pinDef.optional) {
                c.failPin(tr('"{pin}" needs a value: connect a wire or type one in.', { pin: tr(pinDef.label) }), pin);
              }
              return { code: NONE, prec: P.ATOM, type: 'none', literal: true, value: undefined };
            }
            return { ...c.literal(v, pinDef ? pinDef.type : 'any', pin), literal: true, value: v };
          }
          const from = nodes.get(src.node);
          return { ...valueOf(from, src.pin, c, c.via ?? pin), type: src.type, literal: false };
        },
        arg: (pin, min = 0) => wrap(c.input(pin), min),
        literal(v, type, pin) {
          if (java) return c.javaLiteral(v, type, pin);
          if (v === null) return { code: 'None', prec: P.ATOM, type: 'none' };
          if (typeof v === 'boolean') return { code: v ? 'True' : 'False', prec: P.ATOM, type: 'bool' };
          if (typeof v === 'string' && (type === 'number' || type === 'int')) {
            // An integer a double cannot hold exactly is kept as typed: Python's int has no limit.
            if (/^\s*[+-]?\d+\s*$/.test(v) && !Number.isSafeInteger(Number(v))) {
              const big = BigInt(v.trim());
              return { code: big.toString(), prec: big < 0n ? P.UNARY : P.ATOM, type: 'int' };
            }
            const n = v.trim() === '' ? NaN : Number(v);
            if (!Number.isFinite(n)) {
              const message = tr('"{value}" is not a number.', { value: v });
              if (pin) c.failPin(message, pin);
              else c.fail(message);
              return { code: 'None', prec: P.ATOM, type: 'none' };
            }
            v = n;
          }
          if (typeof v === 'number') return { ...pyNumber(v), type: Number.isInteger(v) ? 'int' : 'number' };
          if (Array.isArray(v)) return { code: `[${v.map((x) => c.literal(x, 'any').code).join(', ')}]`, prec: P.ATOM, type: 'list' };
          if (typeof v === 'object') {
            const items = Object.keys(v).map((k) => `${pyStr(k)}: ${c.literal(v[k], 'any').code}`);
            return { code: `{${items.join(', ')}}`, prec: P.ATOM, type: 'dict' };
          }
          return { code: pyStr(String(v)), prec: P.ATOM, type: 'string' };
        },
        javaLiteral(v, type, pin) {
          if (v === null || v === undefined) return { code: 'null', prec: P.ATOM, type: 'none' };
          if (typeof v === 'boolean') return { code: String(v), prec: P.ATOM, type: 'bool' };
          if (typeof v === 'string' && (type === 'number' || type === 'int')) {
            if (/^\s*[+-]?\d+\s*$/.test(v) && !Number.isSafeInteger(Number(v))) return { ...javaNumber(0, v.trim()), type: 'number' };
            const n = v.trim() === '' ? NaN : Number(v);
            if (!Number.isFinite(n)) {
              const message = tr('"{value}" is not a number.', { value: v });
              if (pin) c.failPin(message, pin);
              else c.fail(message);
              return { code: 'null', prec: P.ATOM, type: 'none' };
            }
            v = n;
          }
          if (typeof v === 'number') return { ...javaNumber(v), type: Number.isInteger(v) ? 'int' : 'number' };
          if (Array.isArray(v)) return { code: `Rt.list(${v.map((x) => c.javaLiteral(x, 'any').code).join(', ')})`, prec: P.ATOM, type: 'list' };
          if (typeof v === 'object') {
            const m = Object.keys(v).map((k) => `${javaStr(k)}, ${c.javaLiteral(v[k], 'any').code}`);
            return { code: `new java.util.LinkedHashMap<Object, Object>(java.util.Map.of(${m.join(', ')}))`, prec: P.ATOM, type: 'dict' };
          }
          return { code: javaStr(String(v)), prec: P.ATOM, type: 'string' };
        },
        // Java's Format Text: the template as a concatenation, each field through Rt.fmt (conversion and spec).
        javaFormat(template) {
          const t = VS.templateFields(template);
          if (t.error) c.fail(tr('The template has a { or } without its partner. Write {{ or }} for a brace that should show.'), 'template');
          for (const f of t.fields) if (!VS.isIdentifier(f)) c.fail(tr('"{name}" in the template is not a valid name. Use names like {name_example}.', { name: f, name_example: '{name}' }), 'template');
          const parts = t.parts.map((part) => (typeof part === 'string' ? javaStr(part)
            : !part.conv && !part.spec ? `Rt.str(${c.arg(part.field)})` : `Rt.fmt(${c.arg(part.field)}, '${part.conv || 's'}', ${javaStr(part.spec)})`));
          if (!parts.length) return { code: '""', prec: P.ATOM };
          return { code: parts.length === 1 && parts[0].startsWith('"') ? parts[0] : `(${['""', ...parts].join(' + ')})`, prec: P.ATOM };
        },
        javaExpression(code, names) {
          const src = String(code ?? '').trim();
          if (!src) {
            c.fail(tr('Enter a Java expression.'), 'code');
            return { code: 'null', prec: P.ATOM };
          }
          if (src.includes('\n')) {
            c.fail(tr('A Java Expression is one line. Use Java Code for several lines.'), 'code');
            return { code: 'null', prec: P.ATOM };
          }
          const valid = names.filter((n) => {
            if (VS.isIdentifier(n) && !JAVA_KEYWORDS.has(n)) return true;
            c.fail(tr('"{name}" cannot be used as a name. Use letters, digits and _, and do not start with a digit.', { name: n }), 'inputs');
            return false;
          });
          const toks = javaTokens(src).filter((t) => t.kind !== 'comment');
          const out = toks.map((t, i) => {
            if (t.kind !== 'name' || !valid.includes(t.text)) return t.text;
            const before = toks.slice(0, i).reverse().find((x) => x.kind !== 'space');
            if (before && before.kind === 'op' && before.text === '.') return t.text;
            return `(${c.arg(t.text)})`;
          });
          return { code: `(${out.join('').trim()})`, prec: P.ATOM };
        },
        // A local the step declares once per function (Java Code outputs).
        declare(name) {
          if (!fn || fn.declared.has(name)) return false;
          fn.declared.add(name);
          return true;
        },
        java,
        formatText(template) {
          if (java) return c.javaFormat(template);
          const t = VS.templateFields(template);
          // A spec like {name:{width}} would be a nested replacement field: code inside the f-string.
          const nested = t.parts.some((p) => typeof p !== 'string' && p.spec.includes('{'));
          if (t.error || nested) c.fail(tr('The template has a { or } without its partner. Write {{ or }} for a brace that should show.'), 'template');
          for (const f of t.fields) if (!VS.isIdentifier(f)) c.fail(tr('"{name}" in the template is not a valid name. Use names like {name_example}.', { name: f, name_example: '{name}' }), 'template');
          let body = '';
          let plain = '';
          let dynamic = false;
          let safe = true;
          for (const part of t.parts) {
            if (typeof part === 'string') {
              body += part.replace(/[{}]/g, '$&$&');
              plain += part;
              continue;
            }
            const inp = c.input(part.field);
            if (inp.literal && typeof inp.value === 'string' && !part.conv && !part.spec) {
              body += inp.value.replace(/[{}]/g, '$&$&');
              plain += inp.value;
              continue;
            }
            const code = wrap(inp, P.LOW);
            if (/['"\\{}#\n!:]/.test(code)) safe = false;
            dynamic = true;
            body += `{${code}${part.conv ? `!${part.conv}` : ''}${part.spec && !part.spec.includes('{') ? `:${part.spec}` : ''}}`;
          }
          if (!dynamic) return { code: pyStr(plain), prec: P.ATOM };
          if (safe) return { code: `f${pyStr(body)}`, prec: P.ATOM };
          const args = t.fields.filter(VS.isIdentifier).map((f) => `${f}=${c.arg(f)}`);
          return { code: `${pyStr(String(template))}.format(${args.join(', ')})`, prec: P.ATOM };
        },
        pythonExpression(code, names) {
          const src = String(code ?? '').trim();
          if (!src) {
            c.fail(tr('Enter a Python expression.'), 'code');
            return { code: 'None', prec: P.ATOM };
          }
          if (src.includes('\n')) {
            c.fail(tr('A Python Expression is one line. Use Python Code for several lines.'), 'code');
            return { code: 'None', prec: P.ATOM };
          }
          const valid = names.filter((n) => {
            if (VS.isIdentifier(n)) return true;
            c.fail(tr('"{name}" cannot be used as a name. Use letters, digits and _, and do not start with a digit.', { name: n }), 'inputs');
            return false;
          });
          const toks = tokenize(src).filter((t) => t.kind !== 'comment');
          const text = toks.map((t) => t.text).join('').trim();
          const prec = expressionPrec(toks);
          if (!valid.length) return { code: text, prec };
          if (valid.includes(text)) return c.input(text);
          if (toks.some((t) => t.kind === 'string' && /f/i.test(t.prefix))) {
            return { code: `(lambda ${valid.join(', ')}: ${prec < P.LOW ? `(${text})` : text})(${valid.map((n) => c.arg(n)).join(', ')})`, prec: P.ATOM };
          }
          const sig = (i, step) => {
            for (let j = i + step; j >= 0 && j < toks.length; j += step) if (toks[j].kind !== 'space') return toks[j];
            return null;
          };
          const out = toks.map((t, i) => {
            if (t.kind !== 'name' || !valid.includes(t.text)) return t.text;
            const before = sig(i, -1);
            const after = sig(i, 1);
            if (before && before.kind === 'op' && before.text === '.') return t.text;
            if (after && after.kind === 'op' && after.text === '=') return t.text;
            return wrap(c.input(t.text), P.ATOM);
          });
          return { code: out.join('').trim(), prec };
        },
        dedent(code) {
          const src = String(code ?? '').replace(/\r\n?/g, '\n');
          const inside = stringLines(src);
          const all = src.split('\n').map((l, i) => (inside.has(i) ? { text: l, raw: true }
            : { text: l.replace(/^[ \t]+/, (m) => m.replace(/\t/g, '    ')), raw: false }));
          const blank = (l) => !l.raw && !l.text.trim();
          while (all.length && blank(all[0])) all.shift();
          while (all.length && blank(all[all.length - 1])) all.pop();
          const widths = all.filter((l) => !l.raw && l.text.trim()).map((l) => l.text.length - l.text.trimStart().length);
          const cut = widths.length ? Math.min(...widths) : 0;
          return all.map((l) => (l.raw ? l : { text: l.text.trim() ? l.text.slice(cut) : '', raw: false }));
        },
      };
      c.def = def;
      c.hooks = hooksOf(def);
      return c;
    }

    // Errors found while compiling a statement are raised right before it, at the node that has the error.
    function flush(c) {
      while (c.pending.length) {
        const { node, message } = c.pending.shift();
        emit(java ? `if (true) throw new RuntimeException(${javaStr(message)});` : `raise RuntimeError(${pyStr(message)})`, node);
      }
    }

    // via: the input pin of the step being compiled that the value reaches it through.
    function valueOf(from, pin, consumer, via) {
      const def = defOf(from);
      if (isPure(from)) {
        if (evaluating.has(from.id)) return { code: 'None', prec: P.ATOM };
        evaluating.add(from.id);
        try {
          const c = context(from, {}, consumer);
          c.via = via;
          return hooksOf(def).expr(c, pin);
        } finally {
          evaluating.delete(from.id);
        }
      }
      if (!silent) uses.push({ stmt: consumer.stmt, pin: via, producer: from.id });
      const hooks = hooksOf(def);
      if (hooks && hooks.output) return hooks.output(context(from, {}, consumer), pin);
      return { code: `${pin}_${from.id}`, prec: P.ATOM };
    }

    function chain(startId, scope) {
      const mine = [];
      let id = startId;
      while (id) {
        const node = nodes.get(id);
        if (!isStatement(node)) break;
        if (path.has(id)) {
          const message = tr('Run-order wires go in a circle here. Use a While or For loop to repeat steps.');
          report(id, message);
          emit(java ? `if (true) throw new RuntimeException(${javaStr(message)});` : `raise RuntimeError(${pyStr(message)})`, id);
          break;
        }
        path.add(id);
        mine.push(id);
        visited.add(id);
        place(id);
        const c = context(node, scope);
        const next = c.hooks.stmt(c);
        flush(c);
        id = next ? execNext.get(key(id, next)) : null;
      }
      for (const m of mine) path.delete(m);
    }

    function entry(node, scope) {
      lines = [];
      fn = { id: node.id, assigned: new Set(), declared: new Set(), params: new Set(node.type === 'fn.define' ? VS.parseNames(VS.propOf(node, 'params')) : []) };
      indent = java ? 1 : 0;
      openBlocks = [];
      enterBlock();
      position.set(node.id, { fn: node.id, path: [] });
      const c = context(node, scope);
      c.hooks.entry(c);
      flush(c);
      if (java) { fn = null; return lines; }
      const globals = [...fn.assigned].filter((n) => scriptVariables.has(n) && !fn.params.has(n)).sort();
      const at = lines.findIndex((l) => /^def /.test(l.text));
      if (globals.length && at >= 0) lines.splice(at + 1, 0, { text: `    global ${globals.join(', ')}`, node: node.id });
      fn = null;
      return lines;
    }

    const blocks = defines.map((d) => entry(d, { fn: true }));
    let main;
    if (starts.length) main = entry(starts[0], {});
    else if (java) main = [{ text: '    public static void main(String[] args) {', node: null }, { text: '    }', node: null }];
    else main = [{ text: 'def main():', node: null }, { text: '    pass', node: null }];

    for (const u of uses) {
      if (u.producer === u.stmt || runsBefore(u.producer, u.stmt)) continue;
      const p = nodes.get(u.producer);
      report(u.stmt, tr('This step uses a value from {node}, which does not always run before it. Wire the value from a step that runs earlier, or store it with Set Variable.',
        { node: `${VS.titleOf(p)} (${p.id})` }), u.pin ? { pin: u.pin } : {});
    }
    for (const n of sorted) {
      if (isStatement(n) && !visited.has(n.id)) {
        report(n.id, tr('This step never runs: nothing connects it to Start or a Define Function.'), { warning: true });
      }
    }

    const out = java
      ? [{ text: `// Generated by Nano Studio from ${fileName}. Edit the .jflow file, not this file.`, node: null }]
      : [{ text: `# Generated by Nano Studio from ${fileName}. Edit the .pyflow file, not this file.`, node: null }];
    const blank = () => out.push({ text: '', node: null });
    let bodyStart;
    if (java) {
      out.push({ text: '', node: null }, { text: 'import java.util.*;', node: null }, { text: '', node: null });
      out.push({ text: `public class ${VS.javaClassName(fileName)} {`, node: null });
      bodyStart = out.length;
      const fields = [...scriptVariables].filter((n) => VS.isIdentifier(n) && !JAVA_KEYWORDS.has(n)).sort();
      for (const name of fields) out.push({ text: `    static Object ${name};`, node: null });
      for (const b of [...blocks, main]) {
        blank();
        out.push(...b);
      }
      blank();
      for (const l of VS.javaRuntime.split('\n')) out.push({ text: l ? `    ${l}` : '', node: null });
      out.push({ text: '}', node: null });
    } else if (imports.size || fromImports.size) {
      blank();
      for (const m of [...imports.keys()].sort()) out.push({ text: `import ${m}`, node: imports.get(m) });
      for (const m of [...fromImports.keys()].sort()) {
        const names = fromImports.get(m);
        out.push({ text: `from ${m} import ${[...names.keys()].sort().join(', ')}`, node: names.values().next().value });
      }
    }
    if (!java) {
      bodyStart = out.length;
      for (const b of [...blocks, main]) {
        blank();
        blank();
        out.push(...b);
      }
      blank();
      blank();
      out.push({ text: 'if __name__ == "__main__":', node: null }, { text: '    main()', node: null });
    }

    // For a debugger: each node's own lines (import lines left out), and the expression that gives each data output's
    // value once its node has run: the generated local of an exec node, the inline expression of a pure node.
    const nodeLines = {};
    for (let i = bodyStart; i < out.length; i++) {
      const id = out[i].node;
      if (id) (nodeLines[id] || (nodeLines[id] = [])).push(i + 1);
    }
    const pinExpr = {};
    silent = true;
    for (const n of sorted) {
      const hooks = hooksOf(defOf(n));
      if (!hooks) continue;
      for (const p of pinsOf(n).outputs) {
        let code = null;
        try {
          if (isPure(n) || hooks.output) code = valueOf(n, p.id, { pending: [] }).code;
          else if (usedOut.has(key(n.id, p.id))) code = `${p.id}_${n.id}`;
        } catch {}
        if (code !== null) (pinExpr[n.id] || (pinExpr[n.id] = {}))[p.id] = code;
      }
    }
    silent = false;
    return {
      code: `${out.map((l) => l.text).join('\n')}\n`,
      map: [null, ...out.map((l) => l.node)],
      errors,
      pinExpr,
      nodeLines,
    };
  };

  if (typeof module === 'object' && module.exports) module.exports = VS;
})(typeof window !== 'undefined' ? window : globalThis);
