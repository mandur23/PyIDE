// Compact schemas for well-known JSON files: package.json, tsconfig.json / jsconfig.json, .prettierrc and .eslintrc.
// The main keys with their types, values and defaults, not every key the tools know: package.json and the option
// objects stay open to keys not listed here, so nothing valid is reported.
(() => {
  const df = ide.dataFormats;
  const { ANY, str, int, bool, en, obj, map, arr, strs, any, ci } = df.schema;
  const STRING = { type: 'string' };
  const strOrList = (d) => any(d, STRING, arr(null, STRING));

  // ---------- package.json ----------
  const person = any(null, STRING, obj(null, { name: str(tr('Name')), email: str(tr('Email address')), url: str(tr('Web address')) }));
  const deps = (d) => map(d, STRING);
  const pkg = obj(null, {
    name: str(tr('The package name: lowercase, at most 214 characters, optionally with a scope (@scope/name).'),
      { maxLength: 214, pattern: '^(?:@[a-z0-9-*~][a-z0-9-*._~]*/)?[a-z0-9-~][a-z0-9-._~]*$' }),
    version: str(tr('The package version, which node-semver can parse (for example 1.0.0).')),
    description: str(tr('A short description of the package, shown in npm search.')),
    keywords: strs(tr('Keywords that help people find the package in npm search.')),
    homepage: str(tr('The URL of the project home page.')),
    bugs: any(tr('Where to report issues: a URL, or an object with url and email.'), STRING, obj(null, { url: str(tr('Web address')), email: str(tr('Email address')) })),
    license: str(tr('The license: an SPDX identifier such as MIT or ISC, or UNLICENSED.'), { examples: ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', 'GPL-3.0-only', 'UNLICENSED'] }),
    author: { ...person, description: tr('The author: "Name <email> (url)" or an object with name, email and url.') },
    contributors: arr(tr('People who contributed to the package.'), person),
    funding: any(tr('Where people can support the development of the package.'), STRING, obj(null, { type: STRING, url: STRING }), arr(null, ANY)),
    files: strs(tr('Files and folders (glob patterns) included when the package is published.')),
    main: str(tr('The entry point when the package is required (CommonJS).'), { default: 'index.js' }),
    module: str(tr('The ES module entry point that bundlers use.')),
    browser: any(tr('The entry point for browsers, used by bundlers instead of main.'), STRING, map(null, ANY)),
    types: str(tr('The TypeScript declaration file of the package.')),
    typings: str(tr('The TypeScript declaration file of the package.')),
    bin: any(tr('Commands the package installs: a path, or a map of command names to paths.'), STRING, map(null, STRING)),
    repository: any(tr('Where the source code is: a URL, or an object with type, url and directory.'), STRING,
      obj(null, { type: str(null, { examples: ['git'] }), url: STRING, directory: str(tr('The folder of the package in a monorepo.')) })),
    scripts: map(tr('Commands that npm run <name> runs; some names run at lifecycle events (install, publish, test).'), STRING, {
      properties: {
        start: str(tr('Run by npm start (node server.js when not set).')),
        test: str(tr('Run by npm test.')),
        build: str(tr('Builds the package (npm run build).')),
        dev: str(tr('Starts a development server or watcher (npm run dev).')),
        lint: str(tr('Checks the code with a linter (npm run lint).')),
        format: str(tr('Formats the code (npm run format).')),
        prepare: str(tr('Runs before the package is packed or published, and after a local npm install.')),
        preinstall: str(tr('Runs before the package is installed.')),
        postinstall: str(tr('Runs after the package is installed.')),
        prepublishOnly: str(tr('Runs before the package is published with npm publish.')),
      },
    }),
    config: obj(tr('Values that scripts read as npm_package_config_* environment variables.'), {}),
    dependencies: deps(tr('Packages the package needs at run time: names and version ranges.')),
    devDependencies: deps(tr('Packages needed only for development and tests.')),
    peerDependencies: deps(tr('Packages the project that installs this one must provide, in compatible versions.')),
    peerDependenciesMeta: map(tr('More about peer dependencies.'), obj(null, { optional: bool(tr('Whether the peer dependency may be missing.'), false) })),
    optionalDependencies: deps(tr('Dependencies whose installation may fail without failing the install.')),
    bundleDependencies: any(tr('Dependencies bundled into the published package.'), { type: 'boolean' }, arr(null, STRING)),
    overrides: obj(tr('Versions that replace those of packages anywhere in the dependency tree (npm).'), {}),
    engines: map(tr('Versions of Node.js and of package managers the package works with.'), STRING, {
      properties: { node: str(tr('The Node.js versions (a semver range).')), npm: str(tr('The npm versions (a semver range).')) },
    }),
    os: strs(tr('Operating systems the package runs on (for example "linux" or "!win32").')),
    cpu: strs(tr('CPU architectures the package runs on (for example "x64" or "arm64").')),
    private: bool(tr('true keeps npm from publishing the package.'), false),
    publishConfig: obj(tr('Settings used when the package is published.'), {
      access: en(tr('Whether a scoped package is published as public or restricted.'), ['public', 'restricted']),
      registry: str(tr('The registry the package is published to.')),
      tag: str(tr('The dist-tag the package is published under.'), { default: 'latest' }),
    }),
    workspaces: any(tr('Folders (glob patterns) of the packages of this monorepo.'), arr(null, STRING), obj(null, { packages: arr(null, STRING), nohoist: arr(null, STRING) })),
    type: en(tr('How .js files are loaded: "commonjs" (require) or "module" (ES modules).'), ['commonjs', 'module'], { default: 'commonjs' }),
    exports: any(tr('The entry points of the package by subpath and condition (import, require, types, default).'), STRING, obj(null, {}), arr(null, ANY)),
    imports: obj(tr('Private import mappings, starting with #, for use inside the package.'), {}),
    packageManager: str(tr('The package manager and version the project uses (Corepack), such as pnpm@9.0.0.'), { pattern: '^(npm|pnpm|yarn|bun)@.+' }),
    sideEffects: any(tr('false, or the files with side effects, so that bundlers can drop unused modules.'), { type: 'boolean' }, arr(null, STRING)),
  });

  // ---------- tsconfig.json / jsconfig.json ----------
  const TARGETS = ['ES3', 'ES5', 'ES6', 'ES2015', 'ES2016', 'ES2017', 'ES2018', 'ES2019', 'ES2020', 'ES2021', 'ES2022', 'ES2023', 'ES2024', 'ESNext'];
  const MODULES = ['None', 'CommonJS', 'AMD', 'UMD', 'System', 'ES6', 'ES2015', 'ES2020', 'ES2022', 'ESNext', 'Node16', 'Node18', 'NodeNext', 'Preserve'];
  const LIBS = ['ES5', 'ES6', 'ES2015', 'ES2016', 'ES2017', 'ES2018', 'ES2019', 'ES2020', 'ES2021', 'ES2022', 'ES2023', 'ES2024', 'ESNext',
    'DOM', 'DOM.Iterable', 'DOM.AsyncIterable', 'WebWorker', 'WebWorker.ImportScripts', 'WebWorker.Iterable', 'ScriptHost', 'Decorators', 'Decorators.Legacy'];
  const b = (d, dflt) => bool(d, dflt);
  const compilerOptions = obj(tr('Options of the TypeScript compiler.'), {
    target: ci(tr('The JavaScript version the compiler emits, and the library features it assumes.'), TARGETS, { default: 'ES5' }),
    module: ci(tr('The module system of the emitted code.'), MODULES),
    moduleResolution: ci(tr('How module names in imports are looked up.'), ['Classic', 'Node', 'Node10', 'Node16', 'NodeNext', 'Bundler']),
    jsx: en(tr('How JSX is emitted.'), ['preserve', 'react', 'react-jsx', 'react-jsxdev', 'react-native']),
    lib: arr(tr('The declaration files of built-in APIs to include (ES versions, DOM…).'), {
      anyOf: [{ enum: LIBS }, { type: 'string', pattern: '^(?:[Ee][Ss](?:[56]|20\\d\\d|[Nn][Ee][Xx][Tt])|[Dd][Oo][Mm]|[Ww][Ee][Bb][Ww][Oo][Rr][Kk][Ee][Rr]|[Ss][Cc][Rr][Ii][Pp][Tt][Hh][Oo][Ss][Tt]|[Dd][Ee][Cc][Oo][Rr][Aa][Tt][Oo][Rr][Ss])(?:\\.[A-Za-z0-9]+)*$' }],
    }),
    strict: b(tr('Turns on all strict type-checking options.'), false),
    noImplicitAny: b(tr('Reports expressions and declarations with an implied any type.')),
    strictNullChecks: b(tr('null and undefined are types of their own, not part of every type.')),
    strictFunctionTypes: b(tr('Checks function parameters contravariantly.')),
    strictBindCallApply: b(tr('Checks the arguments of bind, call and apply.')),
    strictPropertyInitialization: b(tr('Reports class properties that the constructor does not initialize.')),
    noImplicitThis: b(tr('Reports this with an implied any type.')),
    useUnknownInCatchVariables: b(tr('Catch clause variables are unknown instead of any.')),
    alwaysStrict: b(tr('Parses in strict mode and emits "use strict".')),
    exactOptionalPropertyTypes: b(tr('Optional properties cannot be set to undefined unless their type says so.'), false),
    noUnusedLocals: b(tr('Reports unused local variables.'), false),
    noUnusedParameters: b(tr('Reports unused parameters.'), false),
    noImplicitReturns: b(tr('Reports code paths of a function that do not return a value.'), false),
    noFallthroughCasesInSwitch: b(tr('Reports switch cases that fall through to the next one.'), false),
    noUncheckedIndexedAccess: b(tr('Adds undefined to the type of index signature accesses.'), false),
    noImplicitOverride: b(tr('Members that override a base class member must say override.'), false),
    noPropertyAccessFromIndexSignature: b(tr('Keys of index signatures must be read with brackets.'), false),
    allowUnreachableCode: b(tr('Whether unreachable code is allowed (not set: a suggestion).')),
    allowUnusedLabels: b(tr('Whether unused labels are allowed (not set: a suggestion).')),
    baseUrl: str(tr('The folder that non-relative module names are resolved from.')),
    paths: map(tr('Module name patterns mapped to locations, relative to baseUrl (or the tsconfig file).'), arr(null, STRING)),
    rootDir: str(tr('The root folder of the source files.')),
    rootDirs: strs(tr('Folders whose contents are merged into one at run time.')),
    outDir: str(tr('The folder for the emitted files.')),
    outFile: str(tr('Concatenates the output into one file.')),
    declaration: b(tr('Emits .d.ts declaration files.'), false),
    declarationDir: str(tr('The folder for the emitted declaration files.')),
    declarationMap: b(tr('Emits source maps for the declaration files.'), false),
    emitDeclarationOnly: b(tr('Emits only declaration files, no JavaScript.'), false),
    sourceMap: b(tr('Emits .map source map files.'), false),
    inlineSourceMap: b(tr('Puts the source maps into the emitted JavaScript.'), false),
    inlineSources: b(tr('Puts the source code into the source maps.'), false),
    sourceRoot: str(tr('Where the debugger finds the TypeScript sources.')),
    mapRoot: str(tr('Where the debugger finds the map files.')),
    noEmit: b(tr('Checks only: emits no files.'), false),
    noEmitOnError: b(tr('Emits no files when there are errors.'), false),
    removeComments: b(tr('Leaves comments out of the output.'), false),
    importHelpers: b(tr('Imports helper functions from tslib instead of emitting them in each file.'), false),
    downlevelIteration: b(tr('Emits exact iteration (for…of, spread) for older targets.'), false),
    preserveConstEnums: b(tr('Keeps const enum declarations in the output.'), false),
    newLine: en(tr('The line ending of emitted files.'), ['crlf', 'lf']),
    esModuleInterop: b(tr('Emits helpers so that CommonJS modules can be imported like ES modules.'), false),
    allowSyntheticDefaultImports: b(tr('Allows default imports from modules without a default export.')),
    allowJs: b(tr('Compiles JavaScript files too.'), false),
    checkJs: b(tr('Reports errors in JavaScript files.'), false),
    maxNodeModuleJsDepth: int(tr('How deep to look into JavaScript files in node_modules.'), { default: 0 }),
    resolveJsonModule: b(tr('Allows importing .json files.'), false),
    isolatedModules: b(tr('Reports code that a compiler working one file at a time cannot emit correctly.'), false),
    verbatimModuleSyntax: b(tr('Imports and exports are emitted as written, except type-only ones.'), false),
    allowImportingTsExtensions: b(tr('Allows imports with .ts and .tsx extensions (needs noEmit or emitDeclarationOnly).'), false),
    moduleDetection: en(tr('How files are recognized as modules.'), ['auto', 'legacy', 'force'], { default: 'auto' }),
    forceConsistentCasingInFileNames: b(tr('Reports imports whose file name case differs from the file on disk.'), true),
    skipLibCheck: b(tr('Skips type checking of declaration files.'), false),
    types: strs(tr('The @types packages to include (all when not set).')),
    typeRoots: strs(tr('Folders to take type declarations from (node_modules/@types when not set).')),
    experimentalDecorators: b(tr('Enables legacy experimental decorators.'), false),
    emitDecoratorMetadata: b(tr('Emits design-type metadata for decorated declarations.'), false),
    useDefineForClassFields: b(tr('Emits class fields with ECMAScript semantics (Object.defineProperty).')),
    jsxFactory: str(tr('The function that creates JSX elements (React.createElement when not set).')),
    jsxFragmentFactory: str(tr('The JSX fragment factory (React.Fragment when not set).')),
    jsxImportSource: str(tr('The module that the JSX runtime functions are imported from.'), { default: 'react' }),
    incremental: b(tr('Saves information from the last compilation to speed up the next one.')),
    composite: b(tr('Lets the project be referenced by other projects (references).'), false),
    tsBuildInfoFile: str(tr('Where the incremental compilation information is saved.')),
    plugins: arr(tr('Language service plugins.'), obj(null, { name: str(tr('The plugin package name.')) })),
    listFiles: b(tr('Prints the names of the files in the compilation.'), false),
    traceResolution: b(tr('Prints how module names are resolved.'), false),
    pretty: b(tr('Colors and formats error messages.'), true),
  });
  const tsconfig = obj(null, {
    compilerOptions,
    extends: strOrList(tr('Configuration files whose settings this one inherits.')),
    include: strs(tr('Files and folders (glob patterns) of the project.'), { default: ['**/*'] }),
    exclude: strs(tr('Files and folders (glob patterns) left out of include.')),
    files: strs(tr('Files of the project, listed one by one.')),
    references: arr(tr('Projects this project depends on (project references).'), obj(null, { path: str(tr('The folder or tsconfig file of the referenced project.')), prepend: { type: 'boolean' } })),
    compileOnSave: b(tr('Lets editors compile files when they are saved.'), false),
    typeAcquisition: obj(tr('Automatic type acquisition for JavaScript projects.'), { enable: { type: 'boolean' }, include: arr(null, STRING), exclude: arr(null, STRING) }),
    watchOptions: obj(tr('How files and folders are watched in watch mode.'), {
      watchFile: en(null, ['fixedPollingInterval', 'priorityPollingInterval', 'dynamicPriorityPolling', 'fixedChunkSizePolling', 'useFsEvents', 'useFsEventsOnParentDirectory']),
      watchDirectory: en(null, ['useFsEvents', 'fixedPollingInterval', 'dynamicPriorityPolling', 'fixedChunkSizePolling']),
      excludeDirectories: arr(null, STRING),
      excludeFiles: arr(null, STRING),
    }),
  }, { allowComments: true, allowTrailingCommas: true });

  // ---------- .prettierrc ----------
  const prettierOptions = {
    printWidth: int(tr('The line length Prettier wraps at.'), { default: 80 }),
    tabWidth: int(tr('The number of spaces per indentation level.'), { default: 2 }),
    useTabs: bool(tr('Indents with tabs instead of spaces.'), false),
    semi: bool(tr('Puts semicolons at the ends of statements.'), true),
    singleQuote: bool(tr('Uses single quotes instead of double quotes.'), false),
    jsxSingleQuote: bool(tr('Uses single quotes in JSX.'), false),
    quoteProps: en(tr('When object property names are quoted.'), ['as-needed', 'consistent', 'preserve'], { default: 'as-needed' }),
    trailingComma: en(tr('Where trailing commas are printed in multi-line lists.'), ['all', 'es5', 'none'], { default: 'all' }),
    bracketSpacing: bool(tr('Puts spaces inside the braces of object literals.'), true),
    bracketSameLine: bool(tr('Puts the > of a multi-line HTML or JSX tag at the end of the last line.'), false),
    objectWrap: en(tr('Whether objects written on several lines stay so.'), ['preserve', 'collapse'], { default: 'preserve' }),
    arrowParens: en(tr('Whether the single parameter of an arrow function gets parentheses.'), ['always', 'avoid'], { default: 'always' }),
    proseWrap: en(tr('How Markdown text is wrapped.'), ['always', 'never', 'preserve'], { default: 'preserve' }),
    htmlWhitespaceSensitivity: en(tr('How whitespace in HTML is treated.'), ['css', 'strict', 'ignore'], { default: 'css' }),
    endOfLine: en(tr('The line ending Prettier writes.'), ['lf', 'crlf', 'cr', 'auto'], { default: 'lf' }),
    embeddedLanguageFormatting: en(tr('Whether code embedded in other files (CSS in HTML, code blocks) is formatted.'), ['auto', 'off'], { default: 'auto' }),
    singleAttributePerLine: bool(tr('Puts each HTML, Vue or JSX attribute on its own line.'), false),
    vueIndentScriptAndStyle: bool(tr('Indents the code in the script and style tags of Vue files.'), false),
    experimentalTernaries: bool(tr('Formats nested ternaries in the newer style.'), false),
    parser: str(tr('The parser to use, instead of the one for the file extension.'), { examples: ['babel', 'typescript', 'css', 'scss', 'json', 'json5', 'markdown', 'yaml', 'html', 'vue', 'graphql'] }),
    plugins: strs(tr('Prettier plugins to load.')),
    requirePragma: bool(tr('Formats only files with a @format or @prettier comment at the top.'), false),
    insertPragma: bool(tr('Adds a @format comment to the files it formats.'), false),
  };
  const prettier = obj(null, {
    ...prettierOptions,
    overrides: arr(tr('Other options for some files.'), obj(null, {
      files: strOrList(tr('The files (glob patterns) the options are for.')),
      excludeFiles: strOrList(tr('Files (glob patterns) left out.')),
      options: obj(tr('The options for these files.'), prettierOptions),
    })),
  }, { allowComments: true, allowTrailingCommas: true });

  // ---------- .eslintrc ----------
  const LEVEL = [0, 1, 2, 'off', 'warn', 'error'];
  const eslintBase = {
    env: map(tr('Environments whose global variables are defined (browser, node, es2022…).'), { type: 'boolean' }, {
      properties: Object.fromEntries(['browser', 'node', 'commonjs', 'es6', 'es2017', 'es2020', 'es2021', 'es2022', 'es2024', 'worker', 'jest', 'mocha', 'jquery'].map((k) => [k, { type: 'boolean' }])),
    }),
    extends: strOrList(tr('Configurations whose settings this one inherits.')),
    parser: str(tr('The parser module (for example @typescript-eslint/parser).')),
    parserOptions: obj(tr('Options passed to the parser.'), {
      ecmaVersion: any(tr('The ECMAScript version of the code.'), { type: 'number' }, { enum: ['latest'] }),
      sourceType: en(tr('Whether the code is scripts or ES modules.'), ['script', 'module', 'commonjs'], { default: 'script' }),
      ecmaFeatures: obj(null, { jsx: { type: 'boolean' }, globalReturn: { type: 'boolean' }, impliedStrict: { type: 'boolean' } }),
      project: strOrList(tr('The tsconfig files typed linting uses.')),
    }),
    plugins: strs(tr('Plugins that provide more rules.')),
    rules: map(tr('Rules and their levels: "off", "warn" or "error" (0, 1, 2), or [level, options…].'),
      any(null, { enum: LEVEL }, arr(null, ANY, { minItems: 1 }))),
    globals: map(tr('Global variables, and whether code may assign to them.'), { enum: ['readonly', 'writable', 'off', 'readable', 'writeable', true, false] }),
    settings: obj(tr('Shared settings that every rule can read.'), {}),
    ignorePatterns: strOrList(tr('Files and folders (glob patterns) ESLint leaves out.')),
    noInlineConfig: bool(tr('Ignores configuration comments in the code (/* eslint … */).'), false),
    reportUnusedDisableDirectives: bool(tr('Reports eslint-disable comments that disable nothing.'), false),
  };
  const eslint = obj(null, {
    root: bool(tr('Stops ESLint from looking for configuration files in parent folders.'), false),
    ...eslintBase,
    overrides: arr(tr('Other settings for some files.'), obj(null, {
      files: strOrList(tr('The files (glob patterns) the settings are for.')),
      excludedFiles: strOrList(tr('Files (glob patterns) left out.')),
      ...eslintBase,
    })),
  }, { allowComments: true, allowTrailingCommas: true });

  const BASE = 'inmemory://pyide/schemas/';
  df.addJsonSchemas([
    { uri: `${BASE}package.json`, fileMatch: ['package.json'], schema: pkg },
    { uri: `${BASE}tsconfig.json`, fileMatch: ['tsconfig.json', 'tsconfig.*.json', 'jsconfig.json', 'jsconfig.*.json'], schema: tsconfig },
    { uri: `${BASE}prettierrc.json`, fileMatch: ['.prettierrc', '.prettierrc.json'], schema: prettier },
    { uri: `${BASE}eslintrc.json`, fileMatch: ['.eslintrc', '.eslintrc.json'], schema: eslint },
  ]);
  // YAML forms of the last two (.prettierrc.yaml, or .prettierrc / .eslintrc written in YAML).
  const named = (re) => (p) => re.test(p.split('/').pop());
  df.addYamlSchema?.(named(/^\.prettierrc(\.ya?ml)?$/i), prettier);
  df.addYamlSchema?.(named(/^\.eslintrc(\.ya?ml)?$/i), eslint);
})();
