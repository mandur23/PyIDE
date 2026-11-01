package dev.nanostudio.bridge;

/** One JSON object on one line. A line break or a quote in a player's text must not be able to start a second record. */
final class Json {
    private final StringBuilder out = new StringBuilder(192).append('{');

    private StringBuilder key(String name) {
        if (out.length() > 1) out.append(',');
        quote(out, name);
        return out.append(':');
    }

    Json text(String name, String value) {
        if (value != null) quote(key(name), value);
        return this;
    }

    Json number(String name, long value) {
        key(name).append(value);
        return this;
    }

    /** One decimal: half a heart is the smallest amount that matters, and a double's tail only grows the file. */
    Json tenths(String name, double value) {
        key(name).append(Math.round(value * 10) / 10.0);
        return this;
    }

    Json raw(String name, String json) {
        key(name).append(json);
        return this;
    }

    String line() {
        return out.append('}').toString();
    }

    static void quote(StringBuilder to, String value) {
        to.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') to.append('\\').append(c);
            else if (c < 0x20 || c == 0x7f || c == 0x2028 || c == 0x2029) to.append(String.format("\\u%04x", (int) c));
            else if (Character.isHighSurrogate(c) && i + 1 < value.length() && Character.isLowSurrogate(value.charAt(i + 1))) to.append(c).append(value.charAt(++i));
            else if (Character.isSurrogate(c)) to.append('\ufffd');
            else to.append(c);
        }
        to.append('"');
    }
}
