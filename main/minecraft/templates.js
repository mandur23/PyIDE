// What the minecraft plugin writes into a project: plugin sources (Paper and Velocity), the Eclipse project files
// that give the Java language server a plugin's classpath, the renaming of a mod template, a resource pack's
// pack.mcmeta, and a Velocity proxy's wiring to the project's servers.
const fs = require('fs');
const path = require('path');

// ---------- plugins ----------
const PAPER_MAIN = (pkg, name) => `package ${pkg};

import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.java.JavaPlugin;

public final class ${name} extends JavaPlugin implements Listener {
    @Override
    public void onEnable() {
        getServer().getPluginManager().registerEvents(this, this);
        getLogger().info("${name} enabled");
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        event.getPlayer().sendMessage("Welcome! This server runs ${name}.");
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        sender.sendMessage("Hello from ${name}!");
        return true;
    }
}
`;
// api-version as major.minor (1.21, 26.3): every Paper version accepts that form.
const PAPER_YML = (pkg, name, mc) => `name: ${name}\nversion: '1.0'\nmain: ${pkg}.${name}\napi-version: '${mc.split('.').slice(0, 2).join('.')}'\ncommands:\n  hello:\n    description: Says hello\n`;

const VELOCITY_MAIN = (pkg, name, id) => `package ${pkg};

import com.google.inject.Inject;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.connection.PostLoginEvent;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.proxy.ProxyServer;
import net.kyori.adventure.text.Component;
import org.slf4j.Logger;

@Plugin(id = "${id}", name = "${name}", version = "1.0")
public final class ${name} {
    private final ProxyServer server;
    private final Logger logger;

    @Inject
    public ${name}(ProxyServer server, Logger logger) {
        this.server = server;
        this.logger = logger;
    }

    @Subscribe
    public void onInitialize(ProxyInitializeEvent event) {
        logger.info("${name} enabled on {} servers", server.getAllServers().size());
    }

    @Subscribe
    public void onLogin(PostLoginEvent event) {
        event.getPlayer().sendMessage(Component.text("Welcome! This network runs ${name}."));
    }
}
`;
// Velocity reads velocity-plugin.json, which its annotation processor would write; it is written here instead, so a
// build needs no processor (javac of JDK 23 and later runs none unless asked).
const VELOCITY_JSON = (pkg, name, id) => `${JSON.stringify({ id, name, version: '1.0', main: `${pkg}.${name}`, authors: [], dependencies: [] }, null, 2)}\n`;

// Writes a plugin project's sources for its server's plugin API; -> the main class's path.
function writePlugin(dir, { api, pkg, name, mc }) {
  const javaDir = path.join(dir, 'src', 'main', 'java', ...pkg.split('.'));
  const resDir = path.join(dir, 'src', 'main', 'resources');
  fs.mkdirSync(javaDir, { recursive: true });
  fs.mkdirSync(resDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'libs'), { recursive: true });
  const main = path.join(javaDir, `${name}.java`);
  const id = name.toLowerCase();
  if (api === 'velocity') {
    fs.writeFileSync(main, VELOCITY_MAIN(pkg, name, id));
    fs.writeFileSync(path.join(resDir, 'velocity-plugin.json'), VELOCITY_JSON(pkg, name, id));
  } else {
    fs.writeFileSync(main, PAPER_MAIN(pkg, name));
    fs.writeFileSync(path.join(resDir, 'plugin.yml'), PAPER_YML(pkg, name, mc));
  }
  fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
  return main;
}

// A plugin.yml list key (depend, softdepend) with `name` added; the file is left as it is when it lists it already.
function addToYamlList(file, key, name) {
  let text = fs.readFileSync(file, 'utf8');
  const inline = new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, 'm');
  const block = new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s*.*\\n?)*)`, 'm');
  if (inline.test(text)) {
    const items = inline.exec(text)[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    if (!items.includes(name)) text = text.replace(inline, () => `${key}: [${[...items, name].join(', ')}]`);
  } else if (block.test(text)) {
    const items = [...block.exec(text)[1].matchAll(/-\s*['"]?([^'"\n]+)/g)].map((m) => m[1].trim());
    if (!items.includes(name)) text = text.replace(block, (m) => `${m.replace(/\n?$/, '\n')}  - ${name}\n`);
  } else {
    text = `${text.replace(/\n?$/, '\n')}${key}: [${name}]\n`;
  }
  fs.writeFileSync(file, text);
}

// .project, .classpath and the compiler level, so the Java language server (JDT LS imports Eclipse projects) knows the
// plugin's sources, the server's API and the plugin's libs/ jars: completion and errors in the editor.
function writeEclipseProject(dir, { name, java, jars }) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  // Unchanged files are left alone: the language server re-imports the project when they change.
  const writeFileSync = (file, text) => { try { if (fs.readFileSync(file, 'utf8') === text) return; } catch {} fs.writeFileSync(file, text); };
  writeFileSync(path.join(dir, '.project'), `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
  <name>${esc(name)}</name>
  <comment>Written by Nano Studio for the Java language server</comment>
  <projects/>
  <buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec>
  <natures><nature>org.eclipse.jdt.core.javanature</nature></natures>
</projectDescription>
`);
  writeFileSync(path.join(dir, '.classpath'), `<?xml version="1.0" encoding="UTF-8"?>
<classpath>
  <classpathentry kind="src" path="src/main/java"/>
  <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>
${jars.map((j) => `  <classpathentry kind="lib" path="${esc(j.replace(/\\/g, '/'))}"/>`).join('\n')}
  <classpathentry kind="output" path="build/eclipse"/>
</classpath>
`);
  fs.mkdirSync(path.join(dir, '.settings'), { recursive: true });
  writeFileSync(path.join(dir, '.settings', 'org.eclipse.jdt.core.prefs'), [
    'eclipse.preferences.version=1',
    `org.eclipse.jdt.core.compiler.codegen.targetPlatform=${java}`,
    `org.eclipse.jdt.core.compiler.compliance=${java}`,
    `org.eclipse.jdt.core.compiler.source=${java}`,
    'org.eclipse.jdt.core.compiler.release=enabled',
    '',
  ].join('\n'));
}

// ---------- mods ----------
// The names each template is written with: its package, mod id, main class and display name.
const MOD_TEMPLATE_NAMES = {
  forge: { pkg: 'com.example.examplemod', id: 'examplemod', cls: 'ExampleMod', display: ['Example Mod'] },
  neoforge: { pkg: 'com.example.examplemod', id: 'examplemod', cls: 'ExampleMod', display: ['Example Mod'] },
  fabric: { pkg: 'com.example', id: 'modid', cls: 'ExampleMod', display: ['Example mod', 'Example Mod'] },
};
const TEXT = /\.(java|kt|json|json5|toml|properties|gradle|kts|mcmeta|cfg|txt)$/i;
const filesUnder = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
};
const replaceAll = (text, pairs) => pairs.reduce((t, [a, b]) => t.split(a).join(b), text);

// Gives a mod template the user's mod id, display name, package and class: the texts under src/ and the build files,
// the package folders, and files and folders named after the template's id or class (assets/examplemod,
// modid.mixins.json, ExampleModClient.java).
function renameMod(dir, kind, { id, display, pkg, cls }) {
  const from = MOD_TEMPLATE_NAMES[kind];
  // Longest first: the package holds the id (com.example.examplemod), and the class names hold the class.
  const pairs = [[from.pkg, pkg], [from.pkg.replace(/\./g, '/'), pkg.replace(/\./g, '/')], ...from.display.map((d) => [d, display]),
    [from.cls, cls], [from.id, id]];
  const roots = [path.join(dir, 'src'), ...['gradle.properties', 'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'].map((f) => path.join(dir, f))];
  for (const file of roots.flatMap((r) => (fs.existsSync(r) && fs.statSync(r).isFile() ? [r] : filesUnder(r)))) {
    if (!TEXT.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const next = replaceAll(text, pairs);
    if (next !== text) fs.writeFileSync(file, next);
  }
  // Package folders: src/<set>/java/<old path> moves to <new path>, through a temporary name since the new path may
  // lie inside the old one (com/example -> com/example/mymod).
  for (const set of fs.existsSync(path.join(dir, 'src')) ? fs.readdirSync(path.join(dir, 'src')) : []) {
    const java = path.join(dir, 'src', set, 'java');
    const old = path.join(java, ...from.pkg.split('.'));
    if (!fs.existsSync(old) || from.pkg === pkg) continue;
    const tmp = path.join(java, `.pyide-move-${process.pid}`);
    fs.renameSync(old, tmp);
    for (let d = path.dirname(old); d !== java && fs.existsSync(d) && !fs.readdirSync(d).length; d = path.dirname(d)) fs.rmdirSync(d);
    const target = path.join(java, ...pkg.split('.'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(tmp, target);
  }
  // Files and folders named after the id or the class, deepest first so a parent's rename does not move a child away.
  const named = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); if (e.name.includes(from.id) || e.name.includes(from.cls)) named.push(p); } };
  if (fs.existsSync(path.join(dir, 'src'))) walk(path.join(dir, 'src'));
  for (const p of named.sort((a, b) => b.length - a.length)) {
    const base = replaceAll(path.basename(p), [[from.cls, cls], [from.id, id]]);
    if (base !== path.basename(p)) fs.renameSync(p, path.join(path.dirname(p), base));
  }
}

// A key=value in a .properties file, set (added when missing).
function setProperty(file, key, value) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^${key.replace(/[.]/g, '\\.')}\\s*=.*$`, 'm');
  // A function replacement: a value's $& or $1 is text, not a pattern.
  fs.writeFileSync(file, re.test(text) ? text.replace(re, () => `${key}=${value}`) :`${text.replace(/\n?$/, '\n')}${key}=${value}\n`);
}

// ---------- resource pack ----------
// version.json's pack_version is {resource, data} up to 1.21.8 and {resource_major, resource_minor, ...} after; packs
// for format 65 and later declare min_format/max_format instead of pack_format.
function packMcmeta(packVersion, description) {
  const major = packVersion?.resource_major ?? packVersion?.resource ?? packVersion;
  const minor = packVersion?.resource_minor ?? 0;
  const pack = major >= 65
    ? { description, min_format: major, max_format: minor ? [major, minor] : major }
    : { description, pack_format: major };
  return `${JSON.stringify({ pack }, null, 2)}\n`;
}

// ---------- Velocity ----------
// velocity.toml for players on `port`, sending them on to `backends` ([{name, port}]) with modern forwarding.
// Velocity takes its defaults for every key not written here.
function velocityToml(port, backends) {
  const servers = backends.map((b) => `${JSON.stringify(b.name)} = "127.0.0.1:${b.port}"`).join('\n');
  return `# Written by Nano Studio: the [servers] table lists the project's Paper and Purpur servers each time the proxy starts.
config-version = "2.9"
bind = "0.0.0.0:${port}"
online-mode = true
player-info-forwarding-mode = "MODERN"
forwarding-secret-file = "forwarding.secret"

[servers]
${servers}
try = [${backends.map((b) => JSON.stringify(b.name)).join(', ')}]

[forced-hosts]
`;
}
// The [servers] table of an existing velocity.toml replaced by the project's backends.
function setVelocityServers(text, backends) {
  const table = `[servers]\n${backends.map((b) => `${JSON.stringify(b.name)} = "127.0.0.1:${b.port}"`).join('\n')}\ntry = [${backends.map((b) => JSON.stringify(b.name)).join(', ')}]\n\n`;
  return /^\[servers\][\s\S]*?(?=^\[)/m.test(text) ? text.replace(/^\[servers\][\s\S]*?(?=^\[)/m, () => table) : `${text.replace(/\n?$/, '\n\n')}${table}`;
}
// A Paper backend behind Velocity: modern forwarding with the proxy's secret in config/paper-global.yml (the
// proxies.velocity block), and online-mode off in server.properties since the proxy checks the players' accounts.
function setPaperVelocity(serverDir, secret) {
  const file = path.join(serverDir, 'config', 'paper-global.yml');
  const block = `  velocity:\n    enabled: true\n    online-mode: true\n    secret: '${secret}'\n`;
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^ {2}velocity:\n(?: {4}.*\n)*/m.test(text)) text = text.replace(/^ {2}velocity:\n(?: {4}.*\n)*/m, () => block);
  else if (/^proxies:\n/m.test(text)) text = text.replace(/^proxies:\n/m, () => `proxies:\n${block}`);
  else text = `${text.replace(/\n?$/, text ? '\n' : '')}proxies:\n${block}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  setProperty(path.join(serverDir, 'server.properties'), 'online-mode', 'false');
}

module.exports = { writePlugin, addToYamlList, writeEclipseProject, renameMod, setProperty, packMcmeta, velocityToml, setVelocityServers, setPaperVelocity, MOD_TEMPLATE_NAMES };
