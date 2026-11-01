package dev.nanostudio.bridge;

import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.lang.invoke.MethodType;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BiFunction;
import java.util.jar.JarFile;
import org.bukkit.Keyed;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Server;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.entity.EntityType;
import org.bukkit.entity.Item;
import org.bukkit.entity.Player;
import org.bukkit.entity.Zombie;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.SignChangeEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.inventory.InventoryCloseEvent;
import org.bukkit.event.inventory.InventoryEvent;
import org.bukkit.event.inventory.InventoryOpenEvent;
import org.bukkit.event.inventory.InventoryType;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.plugin.PluginDescriptionFile;

/**
 * What can run without a server: the core classes as they are, and the event handlers with Bukkit's real event classes
 * around proxies of its interfaces. A proxy is what this test says a server would answer, not what one does. Run with the
 * oldest API this compiled against and with the newest, which shows that the classes link against both.
 */
public final class BridgeTest {
    private static int passed;
    private static int failed;

    private static void check(boolean ok, String what) {
        if (ok) passed++;
        else {
            failed++;
            System.out.println("FAIL " + what);
        }
    }

    private static void same(Object got, Object want, String what) {
        check(want.equals(got), what + ": got " + got + ", want " + want);
    }

    private static final UUID STEVE = UUID.fromString("069a79f4-44e9-4726-a5be-fca90e38aaf5");

    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<T> type, BiFunction<String, Object[], Object> answer) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, (self, method, args) -> {
            if (method.getName().equals("hashCode")) return System.identityHashCode(self);
            if (method.getName().equals("equals")) return self == args[0];
            if (method.getName().equals("toString")) return type.getSimpleName();
            Object r = answer.apply(method.getName(), args);
            if (r != null || !method.getReturnType().isPrimitive()) return r;
            if (method.getReturnType() == boolean.class) return false;
            return method.getReturnType() == double.class ? 0.0 : method.getReturnType() == float.class ? (Object) 0f : (Object) 0;
        });
    }

    private static final World WORLD = proxy(World.class, (name, a) -> name.equals("getName") ? "world" : null);

    /** The newer API's ItemStack constructors ask the server's registries, and here there is no server. */
    private static ItemStack stack(Material type, int amount) {
        return new ItemStack() {
            @Override public Material getType() {
                return type;
            }

            @Override public int getAmount() {
                return amount;
            }
        };
    }

    private static Location at(int x, int y, int z) {
        return new Location(WORLD, x + 0.5, y, z + 0.5);
    }

    private static Player player(String name, UUID id) {
        return proxy(Player.class, (method, a) -> switch (method) {
            case "getUniqueId" -> id;
            case "getName" -> name;
            case "getLocation" -> at(1, 2, 3);
            case "getInventory" -> proxy(PlayerInventory.class, (m, b) -> m.equals("getItemInMainHand") ? stack(Material.DIAMOND_SWORD, 1) : null);
            case "getType" -> EntityType.PLAYER;
            case "getServer" -> proxy(Server.class, (m, b) -> m.equals("getOnlinePlayers") ? List.of() : null);
            default -> null;
        });
    }

    private static Block block(Material type, Location where) {
        return proxy(Block.class, (method, a) -> switch (method) {
            case "getType" -> type;
            case "getLocation" -> where;
            default -> null;
        });
    }

    private static void json() {
        Json j = new Json().text("text", "a\"b\\c\nd\r{\"type\":\"chat\"}\u2028e\u0000\ud800f");
        String line = j.line();
        check(!line.contains("\n") && !line.contains("\r") && !line.contains("\u2028") && !line.contains("\u0000"), "no raw line break or control character");
        same(line, "{\"text\":\"a\\\"b\\\\c\\u000ad\\u000d{\\\"type\\\":\\\"chat\\\"}\\u2028e\\u0000\ufffdf\"}", "text cannot leave its string");
        same(new Json().text("t", "😀").line(), "{\"t\":\"😀\"}", "a whole emoji stays");
        same(new Json().tenths("a", 2.449999).line(), "{\"a\":2.4}", "amounts are in tenths");
        same(new Json().text("skip", null).number("n", 1).line(), "{\"n\":1}", "a missing field is left out");
    }

    private static Coalescer.Key key(String type, String id) {
        return new Coalescer.Key(STEVE.toString(), type, id, null, "world", null);
    }

    private static void coalescing() {
        List<String> lines = new ArrayList<>();
        Coalescer c = new Coalescer(3000, lines::add);
        for (int i = 0; i < 12; i++) c.add(key("break", "minecraft:stone"), i, 64, 0, 1, 0, null, true, 1000 + i * 100);
        c.add(key("break", "minecraft:dirt"), 0, 63, 0, 1, 0, null, true, 1500);
        check(lines.isEmpty(), "nothing is written inside the window");
        same(c.openCount(), 2, "one open record per thing");
        c.flush(3999);
        same(lines.size(), 0, "not before the window ends");
        c.flush(4000);
        same(lines.size(), 1, "the older record goes when its window ends");
        check(lines.get(0).contains("\"n\":12") && lines.get(0).contains("\"id\":\"minecraft:stone\""), "twelve stone in one record: " + lines.get(0));
        check(lines.get(0).contains("\"x\":0,\"y\":64,\"z\":0") && lines.get(0).contains("[11,64,0]]"), "the record has its first place and every position");
        c.add(key("break", "minecraft:dirt"), 1, 63, 0, 1, 0, null, true, 4600);
        same(lines.size(), 2, "an event after the window ends the old record");
        c.flush(Long.MAX_VALUE);
        same(lines.size(), 3, "a server stop writes the rest");

        lines.clear();
        for (int i = 0; i < Coalescer.MAX_SPOTS * 2 + 5; i++) c.add(key("place", "minecraft:stone"), i, 0, 0, 1, 0, null, true, 0);
        same(lines.size(), 2, "a full position list ends its record");
        c.flush(Long.MAX_VALUE);
        same(lines.size(), 3, "and the next one takes over, so no position is lost");
        int spots = 0;
        for (String l : lines) spots += l.split("\\[", -1).length - 2;
        same(spots, Coalescer.MAX_SPOTS * 2 + 5, "every position is on a record");

        lines.clear();
        for (int i = 0; i < Coalescer.MAX_OPEN + 1; i++) c.add(key("drop", "minecraft:x" + i), 0, 0, 0, 1, 0, null, false, 0);
        check(c.openCount() <= Coalescer.MAX_OPEN, "open records are bounded");
        c.flush(Long.MAX_VALUE);
        same(lines.size(), Coalescer.MAX_OPEN + 1, "and none is lost");

        lines.clear();
        c.add(key("hit", null), 0, 0, 0, 1, 2.5, "minecraft:bow", false, 0);
        c.add(key("hit", null), 0, 0, 0, 1, 2.5, "minecraft:bow", false, 10);
        c.flush(Long.MAX_VALUE);
        check(lines.get(0).contains("\"amount\":5.0") && lines.get(0).contains("\"weapon\":\"minecraft:bow\"") && !lines.get(0).contains("\"at\""), "amounts add up: " + lines.get(0));
    }

    private static void writer(Path dir) throws Exception {
        AtomicLong clock = new AtomicLong(Instant.parse("2026-11-01T23:59:59Z").toEpochMilli());
        Path folder = dir.resolve("bridge");
        Files.createDirectories(folder);
        Files.writeString(folder.resolve("2026-11-01.jsonl"), "{\"torn");
        LineWriter w = new LineWriter(folder, 8, clock::get, ZoneOffset.UTC);
        for (int i = 0; i < 1000; i++) w.offer("{\"i\":" + i + "}");
        same(w.droppedSoFar(), 992L, "a full queue counts what it drops");
        long start = System.nanoTime();
        for (int i = 0; i < 2_000_000; i++) w.offer("x");
        double ms = (System.nanoTime() - start) / 1e6;
        check(ms < 2000, "two million offers on a full queue took " + ms + " ms: it never waits");
        w.start();
        Thread.sleep(800);
        w.offer("{\"more\":1}");
        Thread.sleep(800);
        clock.addAndGet(2000);
        w.offer("{\"next\":\"day\"}");
        w.stop(3000);
        List<String> first = Files.readAllLines(folder.resolve("2026-11-01.jsonl"));
        same(first.get(0), "{\"torn", "the torn line stays alone on its line");
        same(first.get(1), "{\"i\":0}", "the next record starts on a line of its own");
        check(first.stream().anyMatch((l) -> l.contains("\"type\":\"dropped\"") && l.contains("\"n\":2000992")), "the file says how many were dropped");
        check(first.contains("{\"more\":1}"), "a line offered later reaches the file");
        same(Files.readAllLines(folder.resolve("2026-11-02.jsonl")).get(0), "{\"next\":\"day\"}", "a new day is a new file");
    }

    private static Recorder recorder(List<String> lines, AtomicLong clock) {
        return new Recorder(new Coalescer(3000, lines::add), lines::add, clock::get);
    }

    private static void events() {
        List<String> lines = new ArrayList<>();
        AtomicLong clock = new AtomicLong(1000);
        Recorder r = recorder(lines, clock);
        Player steve = player("Steve", STEVE);
        for (int i = 0; i < 12; i++) r.onBreak(new BlockBreakEvent(block(Material.STONE, at(i, 64, 0)), steve));
        same(lines.size(), 0, "breaking is held");
        clock.set(5000);
        r.tick();
        same(lines.size(), 1, "twelve breaks are one record");
        check(lines.get(0).contains("\"type\":\"break\"") && lines.get(0).contains("\"uuid\":\"" + STEVE + "\"") && lines.get(0).contains("\"world\":\"world\"") && lines.get(0).contains("\"n\":12") && lines.get(0).contains("\"id\":\"minecraft:stone\""), "the record: " + lines.get(0));

        lines.clear();
        r.onCommand(new PlayerCommandPreprocessEvent(steve, "/msg Alex my password is hunter2"));
        check(lines.size() == 1 && lines.get(0).contains("\"text\":\"/msg\"") && !lines.get(0).contains("hunter2"), "a command is its first word alone: " + lines);

        lines.clear();
        r.onSign(new SignChangeEvent(block(Material.OAK_SIGN, at(5, 70, 5)), steve, new String[] {"hello", "\"},{\"type\":\"chat\"", "", "line\nbreak"}));
        check(lines.size() == 1 && lines.get(0).split("\n").length == 1 && lines.get(0).contains("hello | \\\"},{\\\"type\\\":\\\"chat\\\" | line\\u000abreak"), "a sign's text stays inside its field: " + lines);

        lines.clear();
        ItemStack stack = stack(Material.DIRT, 5);
        Item drop = proxy(Item.class, (m, a) -> switch (m) {
            case "getItemStack" -> stack;
            case "getLocation" -> at(7, 7, 7);
            default -> null;
        });
        r.onDrop(new PlayerDropItemEvent(steve, drop));
        r.onPickup(new EntityPickupItemEvent(steve, drop, 0));
        r.onPickup(new EntityPickupItemEvent(proxy(Zombie.class, (m, a) -> null), drop, 0));
        clock.set(9000);
        r.tick();
        same(lines.size(), 2, "a zombie's pickup is no player's");
        check(lines.stream().anyMatch((l) -> l.contains("\"type\":\"drop\"") && l.contains("\"n\":5")) && lines.stream().anyMatch((l) -> l.contains("\"type\":\"pickup\"") && l.contains("\"x\":7")), "drop and pickup: " + lines);

        lines.clear();
        r.onInteract(new PlayerInteractEvent(steve, Action.RIGHT_CLICK_BLOCK, stack(Material.FLINT_AND_STEEL, 1), block(Material.TNT, at(8, 8, 8)), BlockFace.UP));
        r.onInteract(new PlayerInteractEvent(steve, Action.RIGHT_CLICK_BLOCK, stack(Material.DIRT, 1), block(Material.TNT, at(8, 8, 8)), BlockFace.UP));
        clock.set(13000);
        r.tick();
        check(lines.size() == 1 && lines.get(0).contains("\"type\":\"ignite\"") && lines.get(0).contains("\"id\":\"minecraft:tnt\""), "flint on a block, and only flint: " + lines);

        lines.clear();
        ItemStack[][] chest = {{stack(Material.DIAMOND, 10), null, stack(Material.DIRT, 1)}};
        Inventory top = proxy(Inventory.class, (m, a) -> switch (m) {
            case "getContents" -> chest[0];
            case "getLocation" -> new Location(WORLD, 9, 9, 9) {
                @Override public Block getBlock() {
                    return block(Material.CHEST, this);
                }
            };
            case "getType" -> InventoryType.CHEST;
            default -> null;
        });
        r.onOpen(open(top, steve));
        check(lines.size() == 1 && lines.get(0).contains("\"type\":\"open\"") && lines.get(0).contains("\"id\":\"minecraft:chest\"") && lines.get(0).contains("\"x\":9"), "a container's opening: " + lines);
        chest[0] = new ItemStack[] {stack(Material.DIAMOND, 3), stack(Material.STONE, 4), null};
        r.onClose(close(top, steve));
        clock.set(17000);
        r.tick();
        check(lines.stream().anyMatch((l) -> l.contains("\"type\":\"take\"") && l.contains("minecraft:diamond") && l.contains("\"n\":7") && l.contains("\"x\":9,\"y\":9,\"z\":9")), "taken, with what and where: " + lines);
        check(lines.stream().anyMatch((l) -> l.contains("\"type\":\"take\"") && l.contains("minecraft:dirt") && l.contains("\"n\":1")), "what is gone was taken: " + lines);
        check(lines.stream().anyMatch((l) -> l.contains("\"type\":\"put\"") && l.contains("minecraft:stone") && l.contains("\"n\":4")), "what is new was put: " + lines);

        lines.clear();
        Inventory menu = proxy(Inventory.class, (m, a) -> null);
        r.onOpen(open(menu, steve));
        r.onClose(close(menu, steve));
        same(lines.size(), 0, "a plugin's menu is no container");
    }

    /** The events' constructors take an InventoryView, a class in 1.20.1 and an interface later, so they are found by arity. */
    private static InventoryOpenEvent open(Inventory top, Player who) {
        return (InventoryOpenEvent) event(InventoryOpenEvent.class, top, who);
    }

    private static InventoryCloseEvent close(Inventory top, Player who) {
        return (InventoryCloseEvent) event(InventoryCloseEvent.class, top, who);
    }

    private static InventoryEvent event(Class<? extends InventoryEvent> type, Inventory top, Player who) {
        try {
            Constructor<?> c = type.getConstructors()[0];
            Class<?> view = c.getParameterTypes()[0];
            Object transaction = view.isInterface() ? Proxy.newProxyInstance(view.getClassLoader(), new Class<?>[] {view}, (self, m, a) -> switch (m.getName()) {
                case "getTopInventory" -> top;
                case "getPlayer" -> who;
                case "hashCode" -> 1;
                default -> null;
            }) : viewClass(view, top, who);
            Object[] args = new Object[c.getParameterCount()];
            args[0] = transaction;
            return (InventoryEvent) c.newInstance(args);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    private static Object viewClass(Class<?> view, Inventory top, Player who) {
        try {
            return new org.bukkit.inventory.InventoryView() {
                @Override public Inventory getTopInventory() {
                    return top;
                }

                @Override public Inventory getBottomInventory() {
                    return null;
                }

                @Override public org.bukkit.entity.HumanEntity getPlayer() {
                    return who;
                }

                @Override public InventoryType getType() {
                    return InventoryType.CHEST;
                }

                @Override public String getTitle() {
                    return "";
                }

                @Override public String getOriginalTitle() {
                    return "";
                }

                @Override public void setTitle(String title) {
                }
            };
        } catch (LinkageError e) {
            throw new IllegalStateException(e);
        }
    }

    /** Every Bukkit method the plugin's classes call, read from their constant pools, with its exact types. */
    private static List<String[]> bukkitCalls(String resource) throws Exception {
        try (DataInputStream in = new DataInputStream(BridgeTest.class.getClassLoader().getResourceAsStream(resource))) {
            in.readInt();
            in.readInt();
            int size = in.readUnsignedShort();
            Object[] pool = new Object[size];
            int[] tags = new int[size];
            int[][] refs = new int[size][];
            for (int i = 1; i < size; i++) {
                int tag = in.readUnsignedByte();
                tags[i] = tag;
                switch (tag) {
                    case 1 -> pool[i] = in.readUTF();
                    case 3, 4 -> in.readInt();
                    case 5, 6 -> {
                        in.readLong();
                        i++;
                    }
                    case 7, 8, 16, 19, 20 -> refs[i] = new int[] {in.readUnsignedShort()};
                    case 9, 10, 11, 12, 17, 18 -> refs[i] = new int[] {in.readUnsignedShort(), in.readUnsignedShort()};
                    case 15 -> {
                        in.readUnsignedByte();
                        in.readUnsignedShort();
                    }
                    default -> throw new IllegalStateException("constant tag " + tag);
                }
            }
            List<String[]> calls = new ArrayList<>();
            for (int i = 1; i < size; i++) {
                if (tags[i] != 10 && tags[i] != 11) continue;
                String owner = (String) pool[refs[refs[i][0]][0]];
                int[] nameType = refs[refs[i][1]];
                if (owner.startsWith("org/bukkit/")) calls.add(new String[] {owner, (String) pool[nameType[0]], (String) pool[nameType[1]]});
            }
            return calls;
        }
    }

    private static boolean declares(Class<?> type, String name, String descriptor) {
        if (type == null) return false;
        for (Method m : type.getDeclaredMethods()) {
            if (m.getName().equals(name) && MethodType.methodType(m.getReturnType(), m.getParameterTypes()).toMethodDescriptorString().equals(descriptor)) return true;
        }
        for (Constructor<?> c : type.getDeclaredConstructors()) {
            if (name.equals("<init>") && MethodType.methodType(void.class, c.getParameterTypes()).toMethodDescriptorString().equals(descriptor)) return true;
        }
        if (declares(type.getSuperclass(), name, descriptor)) return true;
        for (Class<?> up : type.getInterfaces()) if (declares(up, name, descriptor)) return true;
        return false;
    }

    private static void links() throws Exception {
        int calls = 0;
        for (String file : List.of("Recorder", "NanoBridge")) {
            for (String[] call : bukkitCalls("dev/nanostudio/bridge/" + file + ".class")) {
                calls++;
                check(declares(Class.forName(call[0].replace('/', '.'), false, BridgeTest.class.getClassLoader()), call[1], call[2]), "this API has " + String.join(" ", call));
            }
        }
        check(calls > 40, "the check saw the plugin's calls: " + calls);
        check(Keyed.class.isAssignableFrom(Material.class) && Keyed.class.isAssignableFrom(EntityType.class), "materials and entity types have keys");
        check(Arrays.stream(PlayerDeathEvent.class.getDeclaredMethods()).noneMatch((m) -> m.getName().equals("getHandlerList")), "a player's death reaches the EntityDeathEvent handler");
        check(Arrays.stream(EntityDamageByEntityEvent.class.getDeclaredMethods()).noneMatch((m) -> m.getName().equals("getHandlerList")), "and damage by an entity shares its parent's handlers");
    }

    private static void descriptor() throws Exception {
        byte[] yaml = BridgeTest.class.getClassLoader().getResourceAsStream("plugin.yml").readAllBytes();
        PluginDescriptionFile d = new PluginDescriptionFile(new ByteArrayInputStream(yaml));
        same(d.getName(), "NanoBridge", "Bukkit reads plugin.yml");
        same(d.getMain(), NanoBridge.class.getName(), "its main class is this one");
        same(d.getAPIVersion(), "1.20", "and the API version");
        check(new String(yaml, StandardCharsets.UTF_8).contains("version: 1.0.0"), "a plugin version");
    }

    /** The two ways a server opens a plugin: the class loader's JarFile, and the zip file system Paper's remapper uses. */
    private static void jar(Path jar) throws Exception {
        try (JarFile file = new JarFile(jar.toFile())) {
            check(file.getEntry("plugin.yml") != null, "the jar has plugin.yml at its root");
            check(file.getEntry("dev/nanostudio/bridge/NanoBridge.class") != null, "and its main class");
            check(file.stream().noneMatch((e) -> e.getName().startsWith("org/") || e.getName().startsWith("net/") || e.getName().startsWith("com/")), "and nothing shaded");
            try (DataInputStream in = new DataInputStream(file.getInputStream(file.getEntry("dev/nanostudio/bridge/Recorder.class")))) {
                in.readInt();
                in.readUnsignedShort();
                same(in.readUnsignedShort(), 61, "class files are for Java 17");
            }
        }
        try (FileSystem zip = FileSystems.newFileSystem(jar)) {
            check(Files.getLastModifiedTime(zip.getPath("plugin.yml")).toMillis() > 0 && Files.size(zip.getPath("plugin.yml")) > 0, "the zip file system reads it");
        }
    }

    public static void main(String[] args) throws Exception {
        Path dir = Path.of(args[0]);
        Files.createDirectories(dir);
        json();
        coalescing();
        writer(dir);
        events();
        descriptor();
        links();
        jar(Path.of(args[1]));
        System.out.println(passed + "/" + (passed + failed) + " passed");
        if (failed > 0) System.exit(1);
    }
}
