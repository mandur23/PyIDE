package dev.nanostudio.bridge;

import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneId;
import org.bukkit.plugin.java.JavaPlugin;

/** Nano Studio's Players tab reads .nano/bridge/<yyyy-mm-dd>.jsonl in the server folder. Nothing here opens a connection. */
public final class NanoBridge extends JavaPlugin {
    private static final long WINDOW_MS = 3000;
    private static final long FLUSH_TICKS = 40;
    private static final int QUEUE_SIZE = 16384;
    private static final long STOP_WAIT_MS = 2000;

    private LineWriter writer;
    private Coalescer bursts;

    @Override
    public void onEnable() {
        Path server = getDataFolder().toPath().toAbsolutePath().getParent().getParent();
        writer = new LineWriter(server.resolve(".nano").resolve("bridge"), QUEUE_SIZE, System::currentTimeMillis, ZoneId.systemDefault());
        writer.start();
        bursts = new Coalescer(WINDOW_MS, writer::offer);
        Recorder recorder = new Recorder(bursts, writer::offer, System::currentTimeMillis);
        getServer().getPluginManager().registerEvents(recorder, this);
        getServer().getScheduler().runTaskTimer(this, recorder::tick, FLUSH_TICKS, FLUSH_TICKS);
        writer.offer(new Json().number("v", 1).text("time", Instant.now().toString()).text("type", "hello").text("plugin", getDescription().getVersion()).text("server", getServer().getVersion()).line());
    }

    @Override
    public void onDisable() {
        if (bursts != null) bursts.flush(Long.MAX_VALUE);
        if (writer != null) writer.stop(STOP_WAIT_MS);
    }
}
