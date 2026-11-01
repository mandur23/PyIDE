package dev.nanostudio.bridge;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Turns bursts into single records: same player, same type, same thing, within the window. Touched only on the server
 * thread, so it needs no lock. A record of blocks keeps every position it covers, which is what lets a search answer who
 * broke one block; when its list is full the record ends and the next one starts, so nothing is lost to the cap.
 */
final class Coalescer {
    static final int MAX_SPOTS = 64;
    /** Many players doing many different things must not grow this without bound. */
    static final int MAX_OPEN = 4096;

    /** where: set for a container, whose exact position is part of what makes two records the same. */
    record Key(String uuid, String type, String id, String other, String world, String where) {}

    static final class Burst {
        final Key key;
        final long start;
        final int x;
        final int y;
        final int z;
        final String weapon;
        int count;
        double amount;
        final List<int[]> spots = new ArrayList<>();

        Burst(Key key, long start, int x, int y, int z, String weapon) {
            this.key = key;
            this.start = start;
            this.x = x;
            this.y = y;
            this.z = z;
            this.weapon = weapon;
        }

        String line() {
            Json json = new Json().number("v", 1).text("time", java.time.Instant.ofEpochMilli(start).toString()).text("uuid", key.uuid).text("type", key.type)
                .text("world", key.world).number("x", x).number("y", y).number("z", z).number("n", count).text("id", key.id).text("other", key.other).text("weapon", weapon);
            if (amount > 0) json.tenths("amount", amount);
            if (!spots.isEmpty()) {
                StringBuilder at = new StringBuilder("[");
                for (int[] s : spots) at.append(at.length() > 1 ? "," : "").append('[').append(s[0]).append(',').append(s[1]).append(',').append(s[2]).append(']');
                json.raw("at", at.append(']').toString());
            }
            return json.line();
        }
    }

    interface Sink {
        void accept(String line);
    }

    private final long windowMs;
    private final Sink sink;
    private final Map<Key, Burst> open = new LinkedHashMap<>();

    Coalescer(long windowMs, Sink sink) {
        this.windowMs = windowMs;
        this.sink = sink;
    }

    /** count: how many things this one event is, such as the size of a stack picked up. spot: keep this exact position. */
    void add(Key key, int x, int y, int z, int count, double amount, String weapon, boolean spot, long now) {
        Burst burst = open.get(key);
        if (burst != null && now - burst.start >= windowMs) {
            sink.accept(open.remove(key).line());
            burst = null;
        }
        if (burst == null) {
            if (open.size() >= MAX_OPEN) flush(Long.MAX_VALUE);
            burst = new Burst(key, now, x, y, z, weapon);
            open.put(key, burst);
        }
        burst.count += count;
        burst.amount += amount;
        if (spot) burst.spots.add(new int[] {x, y, z});
        if (burst.spots.size() >= MAX_SPOTS) sink.accept(open.remove(key).line());
    }

    /** Writes every record older than the window, or all of them for a now of Long.MAX_VALUE. */
    void flush(long now) {
        for (Iterator<Burst> it = open.values().iterator(); it.hasNext(); ) {
            Burst burst = it.next();
            if (now != Long.MAX_VALUE && now - burst.start < windowMs) continue;
            it.remove();
            sink.accept(burst.line());
        }
    }

    int openCount() {
        return open.size();
    }
}
