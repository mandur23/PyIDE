package dev.nanostudio.bridge;

import java.time.Instant;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.LongSupplier;
import org.bukkit.Keyed;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.block.Block;
import org.bukkit.entity.Entity;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.block.SignChangeEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDeathEvent;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.event.inventory.InventoryCloseEvent;
import org.bukkit.event.inventory.InventoryOpenEvent;
import org.bukkit.event.player.PlayerBucketEmptyEvent;
import org.bukkit.event.player.PlayerBucketFillEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;

/**
 * Bukkit's events -> records. Every handler runs on the server thread at MONITOR, so it sees what really happened and
 * only reads. Chat is never listened to. A command is recorded by its first word alone: what follows it can be a whisper
 * or a password.
 */
public final class Recorder implements Listener {
    private static final int MAX_SIGN = 400;

    private record Opened(String id, String world, int x, int y, int z, Map<String, Integer> counts) {}

    private final Coalescer bursts;
    private final Consumer<String> sink;
    private final LongSupplier clock;
    private final Map<UUID, Opened> opened = new HashMap<>();

    Recorder(Coalescer bursts, Consumer<String> sink, LongSupplier clock) {
        this.bursts = bursts;
        this.sink = sink;
        this.clock = clock;
    }

    private static String idOf(Keyed thing) {
        return thing.getKey().toString();
    }

    private static String worldOf(Location at) {
        return at.getWorld() == null ? "" : at.getWorld().getName();
    }

    private void burst(Player player, String type, String id, String other, Location at, int count, double amount, String weapon, boolean spot) {
        Coalescer.Key key = new Coalescer.Key(player.getUniqueId().toString(), type, id, other, worldOf(at), null);
        bursts.add(key, at.getBlockX(), at.getBlockY(), at.getBlockZ(), count, amount, weapon, spot, clock.getAsLong());
    }

    private void single(Player player, String type, Location at, Consumer<Json> fields) {
        Json json = new Json().number("v", 1).text("time", Instant.ofEpochMilli(clock.getAsLong()).toString()).text("uuid", player.getUniqueId().toString()).text("type", type)
            .text("world", worldOf(at)).number("x", at.getBlockX()).number("y", at.getBlockY()).number("z", at.getBlockZ());
        fields.accept(json);
        sink.accept(json.line());
    }

    private static String held(Player player) {
        ItemStack hand = player.getInventory().getItemInMainHand();
        return hand == null || hand.getType() == Material.AIR ? null : idOf(hand.getType());
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onBreak(BlockBreakEvent event) {
        Block block = event.getBlock();
        burst(event.getPlayer(), "break", idOf(block.getType()), null, block.getLocation(), 1, 0, null, true);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onPlace(BlockPlaceEvent event) {
        Block block = event.getBlockPlaced();
        burst(event.getPlayer(), "place", idOf(block.getType()), null, block.getLocation(), 1, 0, null, true);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onPickup(EntityPickupItemEvent event) {
        if (!(event.getEntity() instanceof Player player)) return;
        ItemStack stack = event.getItem().getItemStack();
        burst(player, "pickup", idOf(stack.getType()), null, event.getItem().getLocation(), stack.getAmount(), 0, null, false);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onDrop(PlayerDropItemEvent event) {
        ItemStack stack = event.getItemDrop().getItemStack();
        burst(event.getPlayer(), "drop", idOf(stack.getType()), null, event.getPlayer().getLocation(), stack.getAmount(), 0, null, false);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onDamage(EntityDamageByEntityEvent event) {
        Entity damager = event.getDamager();
        Entity target = event.getEntity();
        Projectile shot = damager instanceof Projectile p ? p : null;
        Player attacker = damager instanceof Player p ? p : shot != null && shot.getShooter() instanceof Player p ? p : null;
        String weapon = shot != null ? idOf(shot.getType()) : attacker != null ? held(attacker) : null;
        double amount = event.getFinalDamage();
        if (attacker != null) burst(attacker, "hit", null, nameOf(target), target.getLocation(), 1, amount, weapon, false);
        if (target instanceof Player victim) {
            Entity source = shot != null && shot.getShooter() instanceof Entity e ? e : damager;
            burst(victim, "hurt", null, nameOf(source), victim.getLocation(), 1, amount, weapon, false);
        }
    }

    private static String nameOf(Entity entity) {
        return entity instanceof Player player ? player.getName() : idOf(entity.getType());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onDeath(EntityDeathEvent event) {
        LivingEntity dead = event.getEntity();
        Player killer = dead.getKiller();
        if (killer == null) return;
        single(killer, dead instanceof Player ? "pvp" : "kill", dead.getLocation(), (json) -> json.text("other", nameOf(dead)).text("weapon", held(killer)));
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onCommand(PlayerCommandPreprocessEvent event) {
        String word = event.getMessage().trim().split("\\s", 2)[0].toLowerCase(Locale.ROOT);
        if (!word.startsWith("/") || word.length() < 2) return;
        String root = word.length() > 64 ? word.substring(0, 64) : word;
        single(event.getPlayer(), "cmd", event.getPlayer().getLocation(), (json) -> json.text("text", root));
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onSign(SignChangeEvent event) {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < 4; i++) {
            String line = event.getLine(i);
            if (line == null || line.isBlank()) continue;
            text.append(text.length() > 0 ? " | " : "").append(line.strip());
        }
        if (text.length() == 0) return;
        String all = text.length() > MAX_SIGN ? text.substring(0, MAX_SIGN) : text.toString();
        Block block = event.getBlock();
        single(event.getPlayer(), "sign", block.getLocation(), (json) -> json.text("id", idOf(block.getType())).text("text", all));
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onInteract(PlayerInteractEvent event) {
        if (event.getAction() != Action.RIGHT_CLICK_BLOCK || event.getMaterial() != Material.FLINT_AND_STEEL) return;
        Block block = event.getClickedBlock();
        if (block != null) burst(event.getPlayer(), "ignite", idOf(block.getType()), null, block.getLocation(), 1, 0, null, true);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onBucketEmpty(PlayerBucketEmptyEvent event) {
        burst(event.getPlayer(), "bucket", idOf(event.getBucket()), "empty", event.getBlockClicked().getLocation(), 1, 0, null, true);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onBucketFill(PlayerBucketFillEvent event) {
        burst(event.getPlayer(), "bucket", idOf(event.getBucket()), "fill", event.getBlockClicked().getLocation(), 1, 0, null, true);
    }

    private static Map<String, Integer> countsOf(Inventory inventory) {
        Map<String, Integer> counts = new HashMap<>();
        for (ItemStack stack : inventory.getContents()) {
            if (stack != null && stack.getType() != Material.AIR) counts.merge(idOf(stack.getType()), stack.getAmount(), Integer::sum);
        }
        return counts;
    }

    /** A plugin's menu has no place in the world, so it is no container. */
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onOpen(InventoryOpenEvent event) {
        Inventory top = event.getInventory();
        Location at = top.getLocation();
        if (at == null || !(event.getPlayer() instanceof Player player)) return;
        String id = idOf(at.getBlock().getType());
        opened.put(player.getUniqueId(), new Opened(id, worldOf(at), at.getBlockX(), at.getBlockY(), at.getBlockZ(), countsOf(top)));
        single(player, "open", at, (json) -> json.text("id", id));
    }

    /** What changed between opening and closing is what was taken and put, however the clicks went. */
    @EventHandler(priority = EventPriority.MONITOR)
    public void onClose(InventoryCloseEvent event) {
        if (!(event.getPlayer() instanceof Player player)) return;
        Opened was = opened.remove(player.getUniqueId());
        if (was == null) return;
        Map<String, Integer> now = countsOf(event.getInventory());
        Map<String, Integer> change = new HashMap<>(now);
        was.counts.forEach((id, count) -> change.merge(id, -count, Integer::sum));
        change.forEach((id, delta) -> {
            if (delta == 0) return;
            String where = was.x + "," + was.y + "," + was.z;
            Coalescer.Key key = new Coalescer.Key(player.getUniqueId().toString(), delta > 0 ? "put" : "take", id, was.id, was.world, where);
            bursts.add(key, was.x, was.y, was.z, Math.abs(delta), 0, null, false, clock.getAsLong());
        });
    }

    void tick() {
        bursts.flush(clock.getAsLong());
    }
}
