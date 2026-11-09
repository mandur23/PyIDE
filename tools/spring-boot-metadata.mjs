// Builds main/spring/boot-metadata.json, the Spring Boot configuration metadata the editor uses when a project's own
// jars are not in the Maven or Gradle cache (main/features/spring-config.js). It reads the metadata of the Spring Boot
// jars already in the local Maven repository (node tools/spring-boot-metadata.mjs [version], the newest one by
// default; nothing is downloaded), puts enum types' values in as hints, and adds the common properties of modules
// that are not there (JDBC, JPA, SQL init, H2, Thymeleaf, Security, Redis, Flyway, Liquibase, Actuator, DevTools, Mail,
// Kafka), written by hand from the Spring Boot reference. Those added ones are marked partial and have no group, so the
// editor never takes them for a complete list.
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { readZipEntries, enumConstants, elementType, META_FILES } = require(path.join(root, 'main', 'features', 'spring-config.js'));
const repo = path.join(os.homedir(), '.m2', 'repository', 'org', 'springframework', 'boot');

const versionKey = (v) => v.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? +x : -1));
const newer = (a, b) => { const x = versionKey(a), y = versionKey(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };
const version = process.argv[2] || fs.readdirSync(path.join(repo, 'spring-boot')).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(newer).pop();
const jars = fs.readdirSync(repo).filter((a) => !/test/.test(a)).map((a) => path.join(repo, a, version, `${a}-${version}.jar`)).filter((f) => fs.existsSync(f));

const docs = [];
for (const jar of jars) {
  const found = await readZipEntries(jar, (n) => META_FILES.includes(n));
  for (const n of META_FILES) if (found.has(n)) docs.push(JSON.parse(found.get(n).toString('utf8')));
}
const props = new Map();
const groups = new Map();
const hints = new Map();
for (const d of docs) {
  for (const g of d.groups || []) if (!groups.has(g.name)) groups.set(g.name, { name: g.name });
  for (const p of d.properties || []) {
    if (props.has(p.name)) continue;
    const { name, type, description, defaultValue, deprecated, deprecation } = p;
    props.set(name, { name, type, description, defaultValue, deprecated, deprecation });
  }
  for (const h of d.hints || []) if (!hints.has(h.name) && h.values?.length) hints.set(h.name, { name: h.name, values: h.values.map(({ value, description }) => ({ value, description })) });
}
// Enum types from the class files of the same jars.
const wanted = new Map();
for (const p of props.values()) {
  const t = elementType(p.type);
  if (t && /^(org|com|io)\./.test(t)) wanted.set(`${t.replace(/\./g, '/')}.class`, t);
}
const enums = new Map();
for (const jar of jars) {
  const found = await readZipEntries(jar, (n) => wanted.has(n) && !enums.has(wanted.get(n)));
  for (const [n, buf] of found) { const v = enumConstants(buf); if (v) enums.set(wanted.get(n), v); }
}
for (const p of props.values()) {
  const values = enums.get(elementType(p.type));
  const name = /^[\w.$]*Map</.test(p.type || '') ? `${p.name}.values` : p.name;
  if (values && !hints.has(name)) hints.set(name, { name, values: values.map((c) => ({ value: c.toLowerCase().replace(/_/g, '-') })) });
}

// ---------- common properties of modules not in the cache ----------
const S = 'java.lang.String', B = 'java.lang.Boolean', I = 'java.lang.Integer', L = 'java.lang.Long', D = 'java.time.Duration';
const LIST = 'java.util.List<java.lang.String>', MAP = 'java.util.Map<java.lang.String,java.lang.String>';
const extra = [
  ['spring.datasource.url', S, 'JDBC URL of the database.'],
  ['spring.datasource.username', S, 'Login username of the database.'],
  ['spring.datasource.password', S, 'Login password of the database.'],
  ['spring.datasource.driver-class-name', S, 'Fully qualified name of the JDBC driver. Auto-detected based on the URL by default.'],
  ['spring.datasource.name', S, 'Datasource name to use if "generate-unique-name" is false. Defaults to "testdb" when using an embedded database, otherwise null.'],
  ['spring.datasource.generate-unique-name', B, 'Whether to generate a random datasource name.', true],
  ['spring.datasource.type', 'java.lang.Class<? extends javax.sql.DataSource>', 'Fully qualified name of the connection pool implementation to use. By default, it is auto-detected from the classpath.'],
  ['spring.datasource.hikari.maximum-pool-size', I, 'Maximum size of the Hikari connection pool, idle and in-use connections together.', 10],
  ['spring.datasource.hikari.minimum-idle', I, 'Minimum number of idle connections Hikari tries to keep in the pool.'],
  ['spring.datasource.hikari.connection-timeout', L, 'Maximum number of milliseconds to wait for a connection from the pool.', 30000],
  ['spring.datasource.hikari.idle-timeout', L, 'Maximum number of milliseconds a connection may sit idle in the pool.', 600000],
  ['spring.datasource.hikari.max-lifetime', L, 'Maximum lifetime of a connection in the pool, in milliseconds.', 1800000],
  ['spring.datasource.hikari.pool-name', S, 'Name of the connection pool, shown in logs and JMX.'],
  ['spring.jpa.show-sql', B, 'Whether to enable logging of SQL statements.', false],
  ['spring.jpa.open-in-view', B, 'Register OpenEntityManagerInViewInterceptor. Binds a JPA EntityManager to the thread for the entire processing of the request.', true],
  ['spring.jpa.generate-ddl', B, 'Whether to initialize the schema on startup.', false],
  ['spring.jpa.database-platform', S, 'Name of the target database to operate on, auto-detected by default. Can be alternatively set using the "Database" enum.'],
  ['spring.jpa.database', 'org.springframework.orm.jpa.vendor.Database', 'Target database to operate on, auto-detected by default. Can be alternatively set using the "databasePlatform" property.', null,
    ['default', 'db2', 'derby', 'h2', 'hana', 'hsql', 'informix', 'mysql', 'oracle', 'postgresql', 'sql-server', 'sybase']],
  ['spring.jpa.defer-datasource-initialization', B, 'Whether to defer DataSource initialization until after any EntityManagerFactory beans have been created and initialized.', false],
  ['spring.jpa.properties', MAP, 'Additional native properties to set on the JPA provider.'],
  ['spring.jpa.hibernate.ddl-auto', S, 'DDL mode. This is actually a shortcut for the "hibernate.hbm2ddl.auto" property. Defaults to "create-drop" when using an embedded database and no schema manager was detected. Otherwise, defaults to "none".', null,
    [['none', 'Disable DDL handling.'], ['validate', 'Validate the schema, make no changes to the database.'], ['update', 'Update the schema if necessary.'],
      ['create', 'Create the schema and destroy previous data.'], ['create-drop', 'Create and then destroy the schema at the end of the session.']]],
  ['spring.jpa.hibernate.naming.physical-strategy', S, 'Fully qualified name of the physical naming strategy.'],
  ['spring.jpa.hibernate.naming.implicit-strategy', S, 'Fully qualified name of the implicit naming strategy.'],
  ['spring.sql.init.mode', 'org.springframework.boot.sql.init.DatabaseInitializationMode', 'Mode to apply when determining whether initialization should be performed.', 'embedded',
    [['always', 'Always initialize the database.'], ['embedded', 'Only initialize an embedded database.'], ['never', 'Never initialize the database.']]],
  ['spring.sql.init.schema-locations', LIST, 'Locations of the schema (DDL) scripts to apply to the database.'],
  ['spring.sql.init.data-locations', LIST, 'Locations of the data (DML) scripts to apply to the database.'],
  ['spring.sql.init.platform', S, 'Platform to use in the default schema or data script locations, schema-${platform}.sql and data-${platform}.sql.', 'all'],
  ['spring.sql.init.continue-on-error', B, 'Whether initialization should continue when an error occurs.', false],
  ['spring.h2.console.enabled', B, 'Whether to enable the console.', false],
  ['spring.h2.console.path', S, 'Path at which the console is available.', '/h2-console'],
  ['spring.thymeleaf.cache', B, 'Whether to enable template caching.', true],
  ['spring.thymeleaf.enabled', B, 'Whether to enable Thymeleaf view resolution for Web frameworks.', true],
  ['spring.thymeleaf.prefix', S, 'Prefix that gets prepended to view names when building a URL.', 'classpath:/templates/'],
  ['spring.thymeleaf.suffix', S, 'Suffix that gets appended to view names when building a URL.', '.html'],
  ['spring.thymeleaf.mode', S, 'Template mode to be applied to templates. See also Thymeleaf\'s TemplateMode enum.', 'HTML'],
  ['spring.thymeleaf.encoding', 'java.nio.charset.Charset', 'Template files encoding.', 'UTF-8'],
  ['spring.thymeleaf.check-template-location', B, 'Whether to check that the templates location exists.', true],
  ['spring.security.user.name', S, 'Default user name.', 'user'],
  ['spring.security.user.password', S, 'Password for the default user name.'],
  ['spring.security.user.roles', LIST, 'Granted roles for the default user name.'],
  ['spring.data.redis.host', S, 'Redis server host.', 'localhost'],
  ['spring.data.redis.port', I, 'Redis server port.', 6379],
  ['spring.data.redis.username', S, 'Login username of the redis server.'],
  ['spring.data.redis.password', S, 'Login password of the redis server.'],
  ['spring.data.redis.database', I, 'Database index used by the connection factory.', 0],
  ['spring.data.redis.url', S, 'Connection URL. Overrides host, port, username, password, and database. Example: redis://user:password@example.com:6379/0'],
  ['spring.data.redis.timeout', D, 'Read timeout.'],
  ['spring.flyway.enabled', B, 'Whether to enable flyway.', true],
  ['spring.flyway.locations', LIST, 'Locations of migrations scripts. Can contain the special "{vendor}" placeholder to use vendor-specific locations.', 'classpath:db/migration'],
  ['spring.flyway.baseline-on-migrate', B, 'Whether to automatically call baseline when migrating a non-empty schema.', false],
  ['spring.liquibase.enabled', B, 'Whether to enable Liquibase support.', true],
  ['spring.liquibase.change-log', S, 'Change log configuration path.', 'classpath:/db/changelog/db.changelog-master.yaml'],
  ['management.endpoints.web.exposure.include', 'java.util.Set<java.lang.String>', 'Endpoint IDs that should be included or \'*\' for all.', 'health'],
  ['management.endpoints.web.exposure.exclude', 'java.util.Set<java.lang.String>', 'Endpoint IDs that should be excluded or \'*\' for all.'],
  ['management.endpoints.web.base-path', S, 'Base path for Web endpoints. Relative to the servlet context path (server.servlet.context-path) when the management server is sharing the main server port.', '/actuator'],
  ['management.endpoint.health.show-details', 'org.springframework.boot.actuate.endpoint.Show', 'When to show full health details.', 'never',
    [['never', 'Never show details.'], ['when-authorized', 'Show details only to authorized users.'], ['always', 'Always show details.']]],
  ['management.endpoint.health.show-components', 'org.springframework.boot.actuate.endpoint.Show', 'When to show components. If not specified the \'show-details\' setting will be used.', null,
    [['never', 'Never show components.'], ['when-authorized', 'Show components only to authorized users.'], ['always', 'Always show components.']]],
  ['spring.devtools.restart.enabled', B, 'Whether to enable automatic restart.', true],
  ['spring.devtools.livereload.enabled', B, 'Whether to enable a livereload.com-compatible server.', true],
  ['spring.mail.host', S, 'SMTP server host. For instance, \'smtp.example.com\'.'],
  ['spring.mail.port', I, 'SMTP server port.'],
  ['spring.mail.username', S, 'Login user of the SMTP server.'],
  ['spring.mail.password', S, 'Login password of the SMTP server.'],
  ['spring.kafka.bootstrap-servers', LIST, 'Comma-delimited list of host:port pairs to use for establishing the initial connections to the Kafka cluster. Applies to all components unless overridden.'],
  ['spring.kafka.consumer.group-id', S, 'Unique string that identifies the consumer group to which this consumer belongs.'],
];
for (const [name, type, description, defaultValue, values] of extra) {
  if (props.has(name)) continue;
  // partial: a module listed only in part, whose other keys must not be taken for unknown ones.
  props.set(name, { name, type, description, ...(defaultValue !== undefined && defaultValue !== null && { defaultValue }), partial: true });
  if (values) hints.set(name, { name, values: values.map((v) => (Array.isArray(v) ? { value: v[0], description: v[1] } : { value: v })) });
}

const out = {
  version,
  groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)),
  properties: [...props.values()].sort((a, b) => a.name.localeCompare(b.name)),
  hints: [...hints.values()].sort((a, b) => a.name.localeCompare(b.name)),
};
const file = path.join(root, 'main', 'spring', 'boot-metadata.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(out)}\n`);
console.log(`${path.relative(root, file)}: Spring Boot ${version}, ${jars.length} jars, ${out.properties.length} properties, ${out.hints.length} hints, ${enums.size} enum types, ${fs.statSync(file).size} bytes`);
