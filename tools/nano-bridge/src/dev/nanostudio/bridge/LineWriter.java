package dev.nanostudio.bridge;

import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;

/**
 * The file side: offer() is all the server thread ever calls, and it never waits. One daemon thread owns the file. A full
 * queue or a refusing disk loses lines, and each lost line is counted and reported in the file as a "dropped" record.
 */
final class LineWriter {
    private static final int BATCH = 512;

    private final Path folder;
    private final LongSupplier clock;
    private final ZoneId zone;
    private final ArrayBlockingQueue<String> queue;
    private final AtomicLong dropped = new AtomicLong();
    private volatile boolean stopping;
    private Thread thread;
    private LocalDate day;
    private OutputStream file;

    LineWriter(Path folder, int capacity, LongSupplier clock, ZoneId zone) {
        this.folder = folder;
        this.queue = new ArrayBlockingQueue<>(capacity);
        this.clock = clock;
        this.zone = zone;
    }

    void offer(String line) {
        if (!queue.offer(line)) dropped.incrementAndGet();
    }

    long droppedSoFar() {
        return dropped.get();
    }

    void start() {
        thread = new Thread(this::run, "NanoBridge writer");
        thread.setDaemon(true);
        thread.start();
    }

    /** Whatever is queued goes to the file, within waitMs: at a server's stop the thread must not hold the shutdown up. */
    void stop(long waitMs) {
        stopping = true;
        if (thread == null) return;
        thread.interrupt();
        try {
            thread.join(waitMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void run() {
        List<String> batch = new ArrayList<>(BATCH);
        while (true) {
            try {
                String first = stopping ? queue.poll() : queue.poll(500, TimeUnit.MILLISECONDS);
                if (first != null) {
                    batch.add(first);
                    queue.drainTo(batch, BATCH - 1);
                }
            } catch (InterruptedException e) {
                if (!stopping) continue;
            }
            write(batch);
            batch.clear();
            if (stopping && queue.isEmpty()) break;
        }
        close();
    }

    private void write(List<String> batch) {
        long lost = dropped.getAndSet(0);
        if (batch.isEmpty() && lost == 0) {
            if (file != null && !today().equals(day)) close();
            return;
        }
        StringBuilder text = new StringBuilder();
        for (String line : batch) text.append(line).append('\n');
        if (lost > 0) text.append(new Json().number("v", 1).text("time", Instant.ofEpochMilli(clock.getAsLong()).toString()).text("type", "dropped").number("n", lost).line()).append('\n');
        try {
            open();
            file.write(text.toString().getBytes(StandardCharsets.UTF_8));
            file.flush();
        } catch (IOException e) {
            dropped.addAndGet(batch.size() + lost);
            close();
        }
    }

    private LocalDate today() {
        return Instant.ofEpochMilli(clock.getAsLong()).atZone(zone).toLocalDate();
    }

    private void open() throws IOException {
        LocalDate now = today();
        if (file != null && now.equals(day)) return;
        close();
        Files.createDirectories(folder);
        Path path = folder.resolve(now + ".jsonl");
        boolean torn = endsMidLine(path);
        file = Files.newOutputStream(path, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        day = now;
        if (torn) file.write('\n');
    }

    /** A crash can leave half a line, which the next record must not run into. */
    private static boolean endsMidLine(Path path) throws IOException {
        if (!Files.exists(path) || Files.size(path) == 0) return false;
        try (RandomAccessFile f = new RandomAccessFile(path.toFile(), "r")) {
            f.seek(f.length() - 1);
            return f.read() != '\n';
        }
    }

    private void close() {
        if (file == null) return;
        try {
            file.close();
        } catch (IOException ignored) {
            // The bytes are gone either way, and there is nowhere to report it.
        }
        file = null;
    }
}
