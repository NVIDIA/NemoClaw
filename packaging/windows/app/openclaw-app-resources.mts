// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// CI-only composition of the pinned package's prebuilt runtime. No dependency scripts run here.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Plugin, TransformOptions, TransformResult } from "esbuild";
import type ts from "typescript";
import { compilePrivateDirectoryRuntime } from "./sqlite-private-directory-build.mts";
import { compileNativePipeTransport } from "./native-pipe-transport-build.mts";
import {
  compileSqliteCanonicalRuntime,
  registerSqliteCanonicalModule,
} from "./sqlite-canonical-path-build.mts";

type Syntax = typeof ts;
type Transformer = {
  transform(input: string, options: TransformOptions): Promise<TransformResult>;
};
type Entry = { path: string; exports: string[]; sourceSha256: string; processEntry?: boolean };
type Role =
  | "metadata"
  | "control-ui"
  | "plugin-facade"
  | "worker"
  | "native-sidecar"
  | "runtime-sidecar"
  | "license";
export type ResourceFile = { path: string; bytes: number; sha256: string; role: Role };
type PackageMetadata = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
};
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const portablePath = (file: string) => file.split(path.sep).join("/");
function javascriptStringLiteral(value: string) {
  return JSON.stringify(value).replace(
    /[<>/\u2028\u2029]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
function readOpenedResource(file: string) {
  const descriptor = fs.openSync(file, "r");
  try {
    const opened = fs.fstatSync(descriptor);
    const named = fs.lstatSync(file);
    if (
      !opened.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    )
      throw new Error("Runtime resource output is not an ordinary exact file.");
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
function regular(file: string) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("Runtime composition requires ordinary, single-link input files.");
  return stat;
}
function packageName(name: string) {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name))
    throw new Error("Invalid runtime dependency name.");
  return name;
}
function filesBelow(root: string): string[] {
  const result: string[] = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (item.isSymbolicLink())
      throw new Error("Runtime resource links require separate admission.");
    const file = path.join(root, item.name);
    if (item.isDirectory()) result.push(...filesBelow(file));
    else {
      regular(file);
      result.push(file);
    }
  }
  return result.sort();
}
function copyExact(source: string, target: string, transform?: (bytes: Buffer) => Buffer) {
  regular(source);
  const original = fs.readFileSync(source);
  const content = transform ? transform(original) : original;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(target, content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!readOpenedResource(target).equals(content))
      throw new Error("Conflicting runtime resource output.");
  }
}
function exportNames(syntax: Syntax, file: string, text: string) {
  const parsed = syntax.createSourceFile(
    file,
    text,
    syntax.ScriptTarget.Latest,
    true,
    syntax.ScriptKind.JS,
  );
  const names: string[] = [];
  for (const statement of parsed.statements) {
    if (!syntax.isExportDeclaration(statement)) continue;
    if (!statement.exportClause || !syntax.isNamedExports(statement.exportClause))
      throw new Error("A compiled plugin entry requires explicit reviewed exports.");
    for (const entry of statement.exportClause.elements) names.push(entry.name.text);
  }
  return names;
}
export function guardWindowsInstallerUpdate(relative: string, text: string) {
  if (relative !== "dist/update-BxCRjwo_.js") return text;
  if (sha256(text) !== "0034e0fcbb4e77b9d64985e46feba51bfc7afa450d6988ef648d6d12a451148d")
    throw new Error("The reviewed gateway update handler changed.");
  const validation =
    'if (!assertValidParams(params, validateUpdateRunParams, "update.run", respond)) return;';
  if (text.split(validation).length !== 2)
    throw new Error("The gateway update admission seam changed.");
  const refusal =
    'if (process.platform === "win32") { respond(false, void 0, __nemoUpdateErrorShape(__nemoUpdateErrorCodes.UNAVAILABLE, "This Windows application is managed by the NemoClaw installer. Use the NemoClaw installer to update or repair it.")); return; }';
  return (
    'import { d as __nemoUpdateErrorShape } from "./error-codes-Bo8q2D1o.js";\n' +
    'import { t as __nemoUpdateErrorCodes } from "./gateway-error-details-w0nAGBBp.js";\n' +
    text.replace(validation, validation + "\n" + refusal)
  );
}
export function compileEagerOllamaRuntime(relative: string, text: string) {
  if (relative !== "dist/stream-api-DUG3zQPW.js") return text;
  if (sha256(text) !== "998ecb135564b06544ef39ef048123bbf0cd8757c344cf93e4b7fe08022e8ebb")
    throw new Error("The reviewed eager Ollama runtime changed.");
  // Upstream immediately awaits this one-use loader before copying its exports.
  // A static import preserves that eager initialization and the same module graph
  // without introducing top-level await into the synchronous compiled registry.
  return text
    .replace('import { r as createLazyRuntimeModule } from "./lazy-runtime-CgCh8H_K.js";\n', "")
    .replace(
      'const ollamaStreamRuntime = await createLazyRuntimeModule(() => import("./stream.runtime.js"))();',
      'import * as ollamaStreamRuntime from "./stream.runtime.js";',
    );
}
export function compileAsyncProcessEntry(relative: string, text: string) {
  if (relative === "dist/system-agent/setup-inference-detection.worker.js") {
    if (sha256(text) !== "37aae8bde397c2dde8eda0514229022155250ea5c14ae1eca125f976f5f3e1b2")
      throw new Error("The reviewed asynchronous setup worker changed.");
    const start = "try {";
    const end = "//#endregion\nexport {};";
    if (text.split(start).length !== 2 || text.split(end).length !== 2)
      throw new Error("The setup worker entry boundary changed.");
    // Keep detection, error reporting, and port closure in their original order.
    // The process facade awaits completion before finishing ESM evaluation.
    return text
      .replace(start, "const __nemoWorkerCompletion = (async () => {\n" + start)
      .replace(end, "})();\nexport { __nemoWorkerCompletion };\n" + end);
  }
  if (relative !== "dist/config/sessions/session-accessor.sqlite-archive.worker.js") return text;
  if (sha256(text) !== "1bac9789df2f1a57538459e4c2c7878ead9bbc280a1218a6e1f116f9cff18158")
    throw new Error("The reviewed asynchronous archive worker changed.");
  const start = "if (isSqliteTranscriptArchiveWorkerData(workerData)) {";
  const end =
    "//#endregion\nexport { materializeTranscriptArchiveInWorker, publishTranscriptArchiveInWorker };";
  if (text.split(start).length !== 2 || text.split(end).length !== 2)
    throw new Error("The archive worker entry boundary changed.");
  // Only this standalone entry's final dispatch uses top-level await. Its facade
  // awaits the same completion before finishing ESM evaluation; failures propagate.
  return text
    .replace(start, "const __nemoWorkerCompletion = (async () => {\n" + start)
    .replace(end, "})();\nexport { __nemoWorkerCompletion };\n" + end);
}
export const PREBUILT_CHOICE_PLUGINS = {
  brave: {
    package: "@openclaw/brave-plugin",
    sha256: "40c0cf23e8373f2285034b8f0a575cc51ec1ed53d081b0e1592d219dd411e54d",
  },
  discord: {
    package: "@openclaw/discord",
    sha256: "358b88763e7697e29eb1807240ab5cdc04e38662462fb93c14e2b563ca7521d6",
  },
  slack: {
    package: "@openclaw/slack",
    sha256: "79ad40233b041c2081408efe59c93c2d38ca508429e016dd9843cccffc8cf49a",
  },
  tavily: {
    package: "@openclaw/tavily-plugin",
    sha256: "c5d65ff201a8178ec914736887802c38d33628c667be5b2453b890fe44086984",
  },
} as const;
function choiceRoots(source: string) {
  return Object.keys(PREBUILT_CHOICE_PLUGINS).map((id) => ({
    id,
    root: path.join(runtimeInputRoot(source), "plugins", id),
  }));
}
export function runtimeInputRoot(source: string) {
  const resolved = path.resolve(source);
  if (
    path.basename(resolved) !== "openclaw" ||
    path.basename(path.dirname(resolved)) !== "node_modules"
  )
    throw new Error("The canonical OpenClaw wrapper layout is required.");
  return path.dirname(path.dirname(resolved));
}
function inputRelativePath(source: string, file: string) {
  const relative = path.relative(runtimeInputRoot(source), file);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error("A runtime dependency escaped the verified input root.");
  return portablePath(relative);
}
export function runtimeExternalPlugin(source: string, externalPackages: readonly string[]): Plugin {
  return {
    name: "pinned-openclaw-runtime-dependencies",
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData?.resolvingRuntimeExternal) return;
        const selected = externalPackages.find(
          (name) => args.path === name || args.path.startsWith(name + "/"),
        );
        if (!selected) return;
        // The optional tracing peer remains absent, as in the approved source graph.
        if (selected === "@opentelemetry/api") return { path: args.path, external: true };
        const resolved = await build.resolve(args.path, {
          importer: args.importer,
          resolveDir: args.resolveDir,
          namespace: args.namespace,
          kind: args.kind,
          pluginData: { resolvingRuntimeExternal: true },
        });
        if (resolved.errors.length) return { errors: resolved.errors };
        if (resolved.external || !resolved.path)
          throw new Error("A pinned sidecar did not resolve to a verified input file.");
        return { path: "./" + inputRelativePath(source, resolved.path), external: true };
      });
    },
  };
}
export function guardWindowsConfiguredPluginInstall(relative: string, text: string) {
  if (relative !== "dist/missing-configured-plugin-install-B3eZm5tD.js") return text;
  if (sha256(text) !== "e41ae67723c77d09d21ccc38658a9376481d5d34054a589795efddc44a726e87")
    throw new Error("The reviewed configured-plugin repair source changed.");
  const refusal =
    'if (process.platform === "win32") throw new Error("A configured plugin is missing or incomplete in this installer-managed Windows application. Repair or update NemoClaw with its installer; runtime plugin downloads are disabled.");';
  for (const marker of [
    "if (missingRecordedPluginIds.length > 0) {",
    "const installed = await installCandidate({",
  ])
    if (text.split(marker).length !== 2)
      throw new Error("The configured-plugin repair admission seam changed.");
  return text
    .replace(
      "if (missingRecordedPluginIds.length > 0) {",
      "if (missingRecordedPluginIds.length > 0) {\n" + refusal,
    )
    .replace(
      "const installed = await installCandidate({",
      refusal + "\nconst installed = await installCandidate({",
    );
}
export function prebuiltPluginRegistrationSource(source: string) {
  const records = "dist/installed-plugin-index-records-C06Xozeq.js";
  const reader = "dist/installed-plugin-index-record-reader-SXWwf_BU.js";
  for (const [file, expected] of [
    [records, "46f3119398f4ee3a5acb4c51d49e049be6e1d5a3034804ccbc8dc1134c841ff9"],
    [reader, "6d1cff63b25360188af688f92856df69c1708bc68e1b37b4f5adccf2493db173"],
  ])
    if (sha256(fs.readFileSync(path.join(source, file))) !== expected)
      throw new Error("The reviewed plugin record API changed.");
  return `export async function registerPrebuiltPlugins(config) {
  __nemoPrepareAssetRoot();
  const fs = require("node:fs"), path = require("node:path");
  const packages = ${JSON.stringify(Object.fromEntries(Object.entries(PREBUILT_CHOICE_PLUGINS).map(([id, item]) => [id, item.package])))};
  const ids = Object.keys(packages).filter(id=>config.plugins?.entries?.[id]?.enabled === true);
  if (!ids.length) return {schemaVersion:1,registered:[]};
  // Bind consent to this compiled artifact, including its packaged resources.
  const integrity="sha256-"+require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(__nemoAssetDir,"openclaw-resource-closure.json"))).digest("base64");
  const selected = ids.map(id=>{
    const directory = path.join(__nemoAssetDir,"plugins",id);
    const metadata = JSON.parse(fs.readFileSync(path.join(directory,"package.json"),"utf8"));
    if(metadata.name!==packages[id]||metadata.version!=="2026.9.2") throw new Error("The prebuilt plugin is missing or differs from this application; repair NemoClaw with its installer.");
    const entries=metadata.openclaw?.runtimeExtensions??metadata.openclaw?.extensions;
    if(!Array.isArray(entries)||!entries.length)throw new Error("The prebuilt plugin runtime is incomplete; repair NemoClaw with its installer.");
    for(const entry of entries) {
      if(typeof entry!=="string"||!entry.startsWith("./dist/")||entry.includes("..")||entry.includes("\\\\")) throw new Error("The prebuilt plugin runtime entry is invalid.");
      const info=fs.lstatSync(path.join(directory,entry));
      if(!info.isFile()||info.isSymbolicLink())throw new Error("The prebuilt plugin runtime entry is unavailable; repair NemoClaw with its installer.");
    }
    return {pluginId:id,source:"path",sourcePath:directory,installPath:directory,version:metadata.version,integrity};
  });
  // Called before runCli or runtime loader initialization. These canonical APIs
  // update only the guest state's SQLite record/index and their metadata caches.
  const {r:loadRecords}=await import(${JSON.stringify(path.join(source, reader))});
  const {n:recordPluginInstallInRecords,s:writeRecords}=await import(${JSON.stringify(path.join(source, records))});
  let records=await loadRecords({env:process.env});
  for(const update of selected) {
    const previous=Object.hasOwn(records,update.pluginId)?records[update.pluginId]:undefined;
    if(previous && ["source","sourcePath","installPath","version","integrity"].every(key=>previous[key]===update[key])) continue;
    records=recordPluginInstallInRecords(records,update);
  }
  await writeRecords(records,{config,env:process.env});
  return {schemaVersion:1,registered:ids};
}\n`;
}

export function compiledPluginPlan(source: string, syntax: Syntax, compiler: Transformer) {
  const processRegistry = fs.readFileSync(
    path.join(source, "dist/runtime-process-entrypoints-CEMkwAJ_.js"),
    "utf8",
  );
  if (
    sha256(processRegistry) !== "357ec4f9cf1238a8c61afc35f9b783017d8d125b97d7173c5e1627776d814440"
  )
    throw new Error("The reviewed runtime process entrypoints changed.");
  // These modules are launched by filename, not imported by the parent graph.
  // Keep all sibling entrypoints from the exact upstream registry in the bundle.
  const processEntries = new Set(
    [...processRegistry.matchAll(/distWorkerPath: "([a-zA-Z0-9/_.-]+\.js)"/g)].map((match) =>
      path.join(source, "dist", match[1]),
    ),
  );
  if (processEntries.size !== 11)
    throw new Error("The runtime process entrypoint inventory changed.");
  // The central registry omits workers owned by individual subsystems. These
  // filename-launched modules also need a registry in their new process.
  for (const [relative, expected] of Object.entries({
    "agents/code-mode.worker.js":
      "d26f55f9e06c00c5c73bfad0c0aeb55a17b48520454371bb6b14d85b6c773991",
    "agents/compaction-planning.worker.js":
      "743208e555c08e977a5be25b65629a9754325fbc57395b97c6b9937f0fad0b57",
    "agents/model-provider-auth.worker.js":
      "acc15b2a308497a82f85b591462946e8e113e7ed0a877c659039dabe7ed99325",
    "agents/prepared-model-catalog.worker.js":
      "a82707371e3cf477446023b4ea836e89b760646bbd20d5720d9925c60d255017",
    "config/sessions/disk-budget.worker.js":
      "2a330cb989426a3b2056f1cb34939df8a4b2bc33f3a85c77e8c53c0147e4f8eb",
    "config/sessions/session-model-context.worker.js":
      "5207534e3a19431b783cd8b591aaf3fd65b1071357ee54d45c341264859d95cd",
    "system-agent/setup-inference-detection.worker.js":
      "37aae8bde397c2dde8eda0514229022155250ea5c14ae1eca125f976f5f3e1b2",
    "extensions/memory-core/memory-search-knn.child.js":
      "4dea70100d79859e7a0e17577acb91cc5231192c5a5c7c957b57313de8082e78",
    "telegram-ingress-worker.runtime.js":
      "44ea3ff5063d74a524bf2adeaf8c54902fc019f9f392bcf03cb1cadbe9dee358",
  })) {
    const file = path.join(source, "dist", relative);
    if (sha256(fs.readFileSync(file)) !== expected)
      throw new Error(`The reviewed subsystem process entry changed: ${relative}`);
    processEntries.add(file);
  }
  const auditRecorder = path.join(source, "dist/audit-recorder-BCaTSxYZ.js");
  if (
    sha256(fs.readFileSync(auditRecorder)) !==
    "74d8649501180770ba7df5fa0f5caad9920b64ffc7e44bc7c10db4f3fef3b484"
  )
    throw new Error("The reviewed process-owned audit recorder changed.");
  const entryFiles = filesBelow(path.join(source, "dist", "extensions")).filter(
    (file) =>
      file.endsWith(".js") &&
      path.relative(path.join(source, "dist", "extensions"), file).split(path.sep).length === 2,
  );
  entryFiles.push(path.join(source, "dist", "plugins", "runtime", "index.js"));
  // The package control exercises the same compiled recorder used by the gateway.
  entryFiles.push(auditRecorder);
  entryFiles.push(...[...processEntries].filter((file) => !entryFiles.includes(file)));
  for (const plugin of choiceRoots(source))
    entryFiles.push(
      ...filesBelow(path.join(plugin.root, "dist")).filter((file) => file.endsWith(".js")),
    );
  for (const name of [
    "plugin-entry",
    "extension-shared",
    "target-resolver-runtime",
    "provider-web-search-config-contract",
    "string-coerce-runtime",
    "diagnostic-runtime",
    "lazy-runtime",
    "provider-http",
    "provider-web-search",
    "runtime-env",
    "ssrf-runtime",
  ])
    entryFiles.push(path.join(source, "dist", "plugin-sdk", `${name}.js`));
  const entries: Entry[] = entryFiles.map((file) => {
    const text = fs.readFileSync(file, "utf8");
    return {
      path: inputRelativePath(source, file),
      exports: exportNames(syntax, file, text),
      sourceSha256: sha256(text),
      ...(processEntries.has(file) ? { processEntry: true } : {}),
    };
  });
  const factories = entries
    .map(
      (entry) =>
        `${javascriptStringLiteral(entry.path)}:()=>require(${javascriptStringLiteral(entryFiles[entries.indexOf(entry)]!)})`,
    )
    .join(",\n");
  const prelude = `const factories={${factories}};
const registry=Object.freeze({load(key){if(!Object.hasOwn(factories,key))throw Error("Unknown compiled plugin entry");return factories[key]();}});
Object.defineProperty(globalThis,Symbol.for("nemoclaw.compiled-openclaw.plugins.v1"),{value:registry});\n`;
  const banner = `
function __nemoModuleFilenameFor(relative){return require("node:path").join(__nemoAssetDir,relative);}
function __nemoModuleDirnameFor(relative){return require("node:path").dirname(__nemoModuleFilenameFor(relative));}
function __nemoModuleUrlFor(relative){return require("node:url").pathToFileURL(__nemoModuleFilenameFor(relative)).href;}`;
  return {
    entries,
    prelude,
    plugin: compiledModuleLocationPlugin(source, compiler, syntax),
    banner,
  };
}
export function compiledModuleLocationPlugin(
  source: string,
  compiler: Transformer,
  syntax?: Syntax,
): Plugin {
  // Preserve each original module's resource location while compiling its code into one graph.
  // This includes bundled dependencies, not just core/plugin files: their native
  // createRequire(import.meta.url) calls need the same sealed package locations.
  return {
    name: "compiled-openclaw-module-locations",
    setup(build) {
      registerSqliteCanonicalModule(build, source);
      const canonical = createRequire(path.join(source, "package.json"));
      build.onResolve({ filter: /^openclaw(?:\/|$)/ }, (args) => ({
        path: canonical.resolve(args.path),
      }));
      build.onLoad({ filter: /\.[cm]?js$/ }, async (args) => {
        const sourceRelative = inputRelativePath(source, args.path);
        const original = fs.readFileSync(args.path, "utf8");
        const adaptationPath = args.path.startsWith(source + path.sep)
          ? portablePath(path.relative(source, args.path))
          : sourceRelative;
        const text = guardWindowsConfiguredPluginInstall(
          adaptationPath,
          guardWindowsInstallerUpdate(
            adaptationPath,
            compileEagerOllamaRuntime(
              adaptationPath,
              compileAsyncProcessEntry(
                adaptationPath,
                compileSqliteCanonicalRuntime(
                  adaptationPath,
                  compilePrivateDirectoryRuntime(
                    adaptationPath,
                    compileNativePipeTransport(adaptationPath, original, syntax),
                  ),
                  original,
                ),
              ),
            ),
          ),
        );
        if (
          !text.includes("import.meta") &&
          !text.includes("__dirname") &&
          !text.includes("__filename")
        )
          return text === original
            ? undefined
            : { contents: text, loader: "js", resolveDir: path.dirname(args.path) };
        const relative = JSON.stringify(sourceRelative);
        const result = await compiler.transform(text, {
          loader: "js",
          sourcefile: args.path,
          define: {
            "import.meta.url": "__originalModuleUrl",
            __dirname: "__originalDirname",
            __filename: "__originalFilename",
          },
          banner: `const __originalModuleUrl=__nemoModuleUrlFor(${relative});const __originalFilename=__nemoModuleFilenameFor(${relative});const __originalDirname=__nemoModuleDirnameFor(${relative});`,
        });
        return { contents: result.code, loader: "js", resolveDir: path.dirname(args.path) };
      });
    },
  };
}
export function publishPluginFacades(app: string, entries: Entry[]) {
  for (const entry of entries) {
    const owner =
      "./" +
      portablePath(
        path.relative(path.dirname(path.join(app, entry.path)), path.join(app, "openclaw-app.cjs")),
      );
    // A Worker may intentionally have env:{}. Derive only its asset root from
    // the sealed owner; never copy the parent's environment into the Worker.
    // Ordinary plugin facades still require an initialized owner.
    const bootstrap = entry.processEntry
      ? `import {createRequire} from "node:module";import {dirname,isAbsolute,relative} from "node:path";
const requireOwner=createRequire(import.meta.url);const ownerPath=requireOwner.resolve(${JSON.stringify(owner)});const assetRoot=dirname(ownerPath);
const suppliedRoot=process.env.OPENCLAW_COMPILED_ASSET_ROOT;
if(suppliedRoot!==undefined&&(!isAbsolute(suppliedRoot)||relative(assetRoot,suppliedRoot)!==""))throw Error("The OpenClaw asset root does not match its compiled owner.");
process.env.OPENCLAW_COMPILED_ASSET_ROOT=assetRoot;
const owner=requireOwner(ownerPath);await owner.registerPrebuiltPlugins({});\n`
      : "";
    const content =
      bootstrap +
      `const registry=globalThis[Symbol.for("nemoclaw.compiled-openclaw.plugins.v1")];if(!registry)throw Error("The compiled OpenClaw owner is unavailable");const original=registry.load(${JSON.stringify(entry.path)});\n` +
      (entry.processEntry ? "await original.__nemoWorkerCompletion;\n" : "") +
      entry.exports
        .map(
          (name, index) =>
            `const v${index}=original[${JSON.stringify(name)}];export{v${index} as ${JSON.stringify(name)}};`,
        )
        .join("\n") +
      "\n";
    const target = path.join(app, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { flag: "wx" });
  }
}
export function publishDynamicImportBridges(app: string) {
  // Native SDK imports must resolve within the canonical wrapper, not the
  // top-level package metadata used by the compiled application's launcher.
  const bridge =
    '"use strict"; module.exports = specifier => typeof specifier === "string" && specifier.startsWith("openclaw/plugin-sdk/") ? require("./node_modules/openclaw/nemoclaw-dynamic-import.cjs")(specifier) : import(specifier);\n';
  const sdkBridge = '"use strict"; module.exports = specifier => import(specifier);\n';
  fs.mkdirSync(path.join(app, "node_modules/openclaw"), { recursive: true });
  fs.writeFileSync(path.join(app, "openclaw-dynamic-import.cjs"), bridge, { flag: "wx" });
  fs.writeFileSync(path.join(app, "node_modules/openclaw/nemoclaw-dynamic-import.cjs"), sdkBridge, {
    flag: "wx",
  });
  return bridge;
}
function resolvePackage(source: string, importer: string, name: string) {
  packageName(name);
  let directory = importer;
  const boundary = runtimeInputRoot(source);
  if (importer !== boundary && !importer.startsWith(boundary + path.sep)) return undefined;
  while (directory === boundary || directory.startsWith(boundary + path.sep)) {
    const candidate = path.join(directory, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    directory = path.dirname(directory);
  }
  return undefined;
}
function targetMatches(values: string[] | undefined, target: string) {
  return (
    !values ||
    (!values.includes(`!${target}`) &&
      (!values.some((value) => !value.startsWith("!")) || values.includes(target)))
  );
}
const sidecarRoots = [
  "koffi",
  "@emnapi/core",
  "@emnapi/runtime",
  "@lydell/node-pty",
  "@openclaw/fs-safe",
  "@silvia-odwyer/photon-node",
  "clawpdf",
  "rastermill",
  "quickjs-wasi",
  "web-tree-sitter",
  "tree-sitter-bash",
  "playwright-core",
  "typescript",
  "jiti",
  "@homebridge/ciao",
  "undici",
  "ws",
];
export const CONTROL_UI_STARTUP_ENTRY = "dist/control-ui/assets/index-1fvEwqai.js";
export const CONTROL_UI_SERVICE_WORKER = "dist/control-ui/sw.js";
export function protectControlUiWorkerRecovery(original: Buffer) {
  const source = original.toString("utf8");
  const signature = "async function navigateSuspendedClient(client) {";
  const start = source.indexOf(signature);
  const end = source.indexOf("\n}\n", start) + 3;
  if (
    start < 0 ||
    source.indexOf(signature, start + signature.length) !== -1 ||
    end <= start ||
    sha256(Buffer.from(source.slice(start, end))) !==
      "afa90cafacc3b3dd0b6a190a98af31ce0a7b968d979fd72649b93e4d89a30f58"
  )
    throw new Error("The reviewed Control UI worker recovery changed.");
  // Temporary Windows packaging bridge: WindowClient.url can retain the original
  // sign-in fragment after upstream removes it. A missed probe is not permission
  // to interrupt a visible page or replay credentials. Remove after upstream fixes
  // that recovery path; the installer maintainer owns this packaged adaptation.
  const guard = `
  const canRecover = current => {
    if (!current || current.visibilityState !== "hidden") return false;
    const target = new URL(current.url);
    const fragment = new URLSearchParams(target.hash.slice(1));
    return !["token", "bootstrapToken", "password", "gatewayUrl"].some(
      key => target.searchParams.has(key) || fragment.has(key)
    );
  };
  const current = await self.clients.get(client.id);
  if (!canRecover(current)) return;
  client = current;`;
  const recheck = `  try {
    const latest = await self.clients.get(client.id);
    if (!canRecover(latest)) {
      await reloadClaim.cache.delete(reloadClaim.guardRequest);
      return;
    }
    client = latest;
  } catch (error) {
    await reloadClaim.cache.delete(reloadClaim.guardRequest).catch(() => undefined);
    throw error;
  }
`;
  const recovery = source
    .slice(start, end)
    .replace(signature, signature + guard)
    .replace("  // Navigation can stay pending", recheck + "  // Navigation can stay pending");
  return Buffer.from(source.slice(0, start) + recovery + source.slice(end));
}
export function deferControlUiStartup(original: Buffer) {
  if (sha256(original) !== "76a9b487a03b82bb4355d7a9696c2a8c82c38739f29ebe54a71e50371ec5de3a")
    throw new Error("The reviewed Control UI startup entry changed.");
  // Edge can restore the initial navigation fragment after an early replaceState.
  // Let that navigation finish before upstream captures and sanitizes its landing URL.
  // Keep the upstream initializer, authentication and strict route comparison intact.
  // Remove this bridge when the pinned upstream startup handles that ordering itself.
  return Buffer.from(
    original
      .toString("utf8")
      .replace(
        ";e();",
        ';if(document.readyState==="complete"){e();}else{window.addEventListener("load",()=>e(),{once:true});}',
      ),
  );
}
export function stagePublishedResources(source: string, app: string, platform = "win32") {
  const core = path.join(app, inputRelativePath(source, source));
  const entrySource = path.join(source, CONTROL_UI_STARTUP_ENTRY);
  regular(entrySource);
  const entryBytes = fs.readFileSync(entrySource);
  const startup = deferControlUiStartup(entryBytes);
  const workerSource = path.join(source, CONTROL_UI_SERVICE_WORKER);
  regular(workerSource);
  const workerBytes = fs.readFileSync(workerSource);
  const worker = protectControlUiWorkerRecovery(workerBytes);
  for (const suffix of [".br", ".gz"])
    if (fs.existsSync(workerSource + suffix))
      throw new Error("A compressed Control UI worker would bypass the reviewed adaptation.");
  const startupPath = `dist/control-ui/assets/nemoclaw-start-${sha256(startup)}.js`;
  const indexSource = path.join(source, "dist/control-ui/index.html");
  regular(indexSource);
  const indexBytes = fs.readFileSync(indexSource);
  const originalReference = `src="./assets/${path.basename(CONTROL_UI_STARTUP_ENTRY)}"`;
  if (indexBytes.toString("utf8").split(originalReference).length !== 2)
    throw new Error("The reviewed Control UI startup reference changed.");
  const index = Buffer.from(
    indexBytes
      .toString("utf8")
      .replace(originalReference, `src="./assets/${path.basename(startupPath)}"`),
  );
  for (const name of ["package.json", "LICENSE", "THIRD_PARTY_NOTICES.md"])
    copyExact(path.join(source, name), path.join(core, name));
  copyExact(path.join(source, "package.json"), path.join(app, "package.json"));
  // Keep upstream chunks, their compressed siblings and asset manifest byte-identical.
  // A distinct entry URL prevents old immutable caches from bypassing the startup repair.
  // No frontend code is compiled on the customer machine.
  // Workspace creation reads the published templates from the canonical package root.
  for (const directory of ["dist/control-ui", "skills", "docs/reference/templates"]) {
    for (const file of filesBelow(path.join(source, directory))) {
      const relative = path.relative(source, file);
      copyExact(
        file,
        path.join(core, relative),
        portablePath(relative) === "dist/control-ui/index.html"
          ? () => index
          : portablePath(relative) === CONTROL_UI_SERVICE_WORKER
            ? () => worker
            : undefined,
      );
    }
  }
  fs.writeFileSync(path.join(core, startupPath), startup, { flag: "wx" });
  for (const file of filesBelow(path.join(source, "dist"))) {
    const relative = portablePath(path.relative(source, file));
    if (relative.startsWith("dist/control-ui/")) continue;
    // Preserve published data/licenses and nested extension resources. Development
    // declarations/maps are not deleted from the source; the compiled profile does not use them.
    const nestedExtension =
      relative.startsWith("dist/extensions/") && relative.split("/").length > 4;
    if (
      (!file.endsWith(".js") && !file.endsWith(".ts") && !file.endsWith(".map")) ||
      nestedExtension
    )
      copyExact(file, path.join(core, relative));
  }
  const pending = sidecarRoots.map((name) => {
    const found = resolvePackage(source, source, name);
    if (!found) throw new Error(`Missing pinned runtime sidecar: ${name}`);
    return found;
  });
  // The gateway resolves ws by package metadata; messaging plugins can select
  // nested copies. Preserve every selected identity instead of bundling a second one.
  for (const plugin of choiceRoots(source)) {
    const websocket = resolvePackage(source, plugin.root, "ws");
    if (!websocket) throw new Error("Missing pinned WebSocket sidecar.");
    pending.push(websocket);
  }
  for (const name of ["libopus-wasm", "@discordjs/voice"]) {
    const found = resolvePackage(
      source,
      path.join(runtimeInputRoot(source), "plugins", "discord"),
      name,
    );
    if (!found) throw new Error(`Missing canonical Discord native/WASM sidecar: ${name}`);
    pending.push(found);
  }
  const seen = new Set<string>();
  const destinations = new Map<string, string>();
  const packages: { name: string; version: string; path: string; packageSha256: string }[] = [];
  while (pending.length) {
    const folder = pending.shift()!;
    if (seen.has(folder)) continue;
    seen.add(folder);
    const packageBytes = fs.readFileSync(path.join(folder, "package.json"));
    const metadata = JSON.parse(packageBytes.toString("utf8")) as PackageMetadata;
    if (
      !targetMatches(metadata.os, platform) ||
      (!targetMatches(metadata.cpu, "arm64") && metadata.name !== "@snazzah/davey-wasm32-wasi")
    )
      continue;
    const destination = inputRelativePath(source, folder);
    const prior = destinations.get(destination);
    if (prior) {
      if (prior !== sha256(packageBytes))
        throw new Error("Conflicting pinned native sidecar dependency.");
    }
    destinations.set(destination, sha256(packageBytes));
    if (!prior)
      packages.push({
        name: metadata.name,
        version: metadata.version,
        path: destination,
        packageSha256: sha256(packageBytes),
      });
    for (const file of filesBelow(folder)) {
      if (path.relative(folder, file).split(path.sep).includes("node_modules")) continue;
      copyExact(file, path.join(app, destination, path.relative(folder, file)));
    }
    for (const [name] of Object.entries({
      ...metadata.dependencies,
      ...metadata.optionalDependencies,
    })) {
      const dependency = resolvePackage(source, folder, name);
      if (!dependency) throw new Error(`Missing pinned transitive sidecar: ${name}`);
      pending.push(dependency);
    }
  }
  for (const plugin of choiceRoots(source)) {
    const bytes = fs.readFileSync(path.join(plugin.root, "package.json"));
    const metadata = JSON.parse(bytes.toString("utf8")) as PackageMetadata;
    if (
      metadata.name !==
        PREBUILT_CHOICE_PLUGINS[plugin.id as keyof typeof PREBUILT_CHOICE_PLUGINS].package ||
      metadata.version !== "2026.9.2"
    )
      throw new Error("The reviewed complete choice plugin is required.");
    const pluginFiles = filesBelow(plugin.root);
    // The integrity-checked archive binds bundled dependency metadata; 9.2 no longer
    // publishes a plugin shrinkwrap. Keep target filtering at each package root.
    const dependencies = pluginFiles
      .map((file) => ({ file, relative: portablePath(path.relative(plugin.root, file)) }))
      .filter(({ relative }) =>
        /^(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)+package\.json$/.test(relative),
      )
      .map(
        ({ file, relative }) =>
          [
            relative.slice(0, -"/package.json".length),
            JSON.parse(fs.readFileSync(file, "utf8")) as PackageMetadata,
          ] as const,
      )
      .sort(([left], [right]) => right.length - left.length);
    for (const file of pluginFiles) {
      const relative = portablePath(path.relative(plugin.root, file));
      const dependency = dependencies.find(([name]) => relative.startsWith(name + "/"));
      if (
        dependency &&
        (!targetMatches(dependency[1].os, platform) ||
          (!targetMatches(dependency[1].cpu, "arm64") &&
            !dependency[0].endsWith("/@snazzah/davey-wasm32-wasi")))
      )
        continue;
      // Every plugin JS runtime entry has a compiled facade. Preserve its
      // original non-code resources and the bundled dependency data/licenses.
      if (/\.(?:[cm]?js|[cm]?ts|map)$/.test(file)) continue;
      copyExact(file, path.join(app, "plugins", plugin.id, relative));
    }
    packages.push({
      name: metadata.name,
      version: metadata.version,
      path: "plugins/" + plugin.id,
      packageSha256: sha256(bytes),
    });
  }
  return {
    packages: packages.sort((a, b) => a.path.localeCompare(b.path)),
    controlUiServiceWorker: {
      path: CONTROL_UI_SERVICE_WORKER,
      sourceSha256: sha256(workerBytes),
      stagedSha256: sha256(worker),
      adaptation: "Do not force recovery navigation of visible pages or credential-bearing URLs.",
    },
    controlUiStartup: {
      originalEntry: CONTROL_UI_STARTUP_ENTRY,
      sourceSha256: sha256(entryBytes),
      stagedEntry: startupPath,
      stagedSha256: sha256(startup),
      originalIndexSha256: sha256(indexBytes),
      stagedIndexSha256: sha256(index),
      adaptation:
        "Run the original UI initializer after initial document load; authentication and routing are unchanged.",
    },
  };
}
export function resourceInventory(app: string, facadePaths: string[]): ResourceFile[] {
  const facades = new Set(facadePaths);
  return filesBelow(app)
    .filter((file) => !file.endsWith("openclaw-resource-closure.json"))
    .map((file) => {
      const relative = portablePath(path.relative(app, file));
      let role: Role = "metadata";
      if (relative.startsWith("node_modules/openclaw/dist/control-ui/")) role = "control-ui";
      else if (relative.startsWith("dist/audit/")) role = "worker";
      else if (facades.has(relative)) role = "plugin-facade";
      else if (/\.(?:node|dll|exe)$/i.test(file)) role = "native-sidecar";
      else if (/(?:LICENSE|NOTICE|COPYING)/i.test(path.basename(file))) role = "license";
      else if (relative.startsWith("node_modules/") || /\.[cm]?js$/.test(file))
        role = "runtime-sidecar";
      const bytes = fs.readFileSync(file);
      return { path: relative, bytes: bytes.length, sha256: sha256(bytes), role };
    });
}
