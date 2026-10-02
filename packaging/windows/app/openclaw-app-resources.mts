// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// CI-only composition of the pinned package's prebuilt runtime. No dependency scripts run here.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Plugin, TransformOptions, TransformResult } from "esbuild";
import type ts from "typescript";

type Syntax = typeof ts;
type Transformer = {
  transform(input: string, options: TransformOptions): Promise<TransformResult>;
};
type Entry = { path: string; exports: string[]; sourceSha256: string };
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
function copyExact(source: string, target: string) {
  regular(source);
  const content = fs.readFileSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    regular(target);
    if (!fs.readFileSync(target).equals(content))
      throw new Error("Conflicting runtime resource output.");
    return;
  }
  fs.writeFileSync(target, content, { flag: "wx" });
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
export function normalizeWindowsNativePluginRequire(relative: string, text: string) {
  if (relative !== "dist/plugin-module-loader-cache-uqaaAPup.js") return text;
  if (sha256(text) !== "af5dc41aba74bb7eab264d1544d16a86906401bfe1c24a0ad53ae25bb8f1d2ac")
    throw new Error("The reviewed native plugin loader changed.");
  const original = "return withNativeRequireAliases(aliasMap, () => nodeRequire(modulePath));";
  if (text.split(original).length !== 2) throw new Error("The native plugin require seam changed.");
  // Windows callers use file URLs for ESM/Jiti. Native require needs the
  // corresponding filesystem path; ordinary specifiers and all guards stay intact.
  return text.replace(
    original,
    'return withNativeRequireAliases(aliasMap, () => nodeRequire(process.platform === "win32" && typeof modulePath === "string" && modulePath.startsWith("file:") ? fileURLToPath(modulePath) : modulePath));',
  );
}
export function guardWindowsInstallerUpdate(relative: string, text: string) {
  if (relative !== "dist/update-B0wRhzt_.js") return text;
  if (sha256(text) !== "d9ab62237a9405a6ce9057d6193f42a6c833c6738be0771e992b8d3e39f734aa")
    throw new Error("The reviewed gateway update handler changed.");
  const validation =
    'if (!assertValidParams(params, validateUpdateRunParams, "update.run", respond)) return;';
  if (text.split(validation).length !== 2)
    throw new Error("The gateway update admission seam changed.");
  const refusal =
    'if (process.platform === "win32") { respond(false, void 0, __nemoUpdateErrorShape(__nemoUpdateErrorCodes.UNAVAILABLE, "This Windows application is managed by the NemoClaw installer. Use the NemoClaw installer to update or repair it.")); return; }';
  return (
    'import { Gn as __nemoUpdateErrorShape, Wn as __nemoUpdateErrorCodes } from "./schema-BuOFpc7K.js";\n' +
    text.replace(validation, validation + "\n" + refusal)
  );
}
export const PREBUILT_CHOICE_PLUGINS = {
  brave: {
    package: "@openclaw/brave-plugin",
    sha256: "f5198ea18ea0adebc376c669b8e5e1100781f07ec2d9e24e86c90cb82acb039c",
  },
  discord: {
    package: "@openclaw/discord",
    sha256: "28f1511de04906def70f7ff6950cd2d26f52be0ec93c5efce8f5c07cb46bc521",
  },
  slack: {
    package: "@openclaw/slack",
    sha256: "d6ae8745867d812560e917707e633c8b66b36f7270124a8cca9602c6dc98ef46",
  },
  tavily: {
    package: "@openclaw/tavily-plugin",
    sha256: "c8d7c2fb40b0c6a3f8ad99e927c1851ef501bef89ce049e88ab79083ff6dcb09",
  },
} as const;
function choiceRoots(source: string) {
  return Object.keys(PREBUILT_CHOICE_PLUGINS).map((id) => ({
    id,
    root: path.join(path.dirname(source), "plugins", id),
  }));
}
function packagedModulePath(source: string, file: string): string | undefined {
  if (file.startsWith(source + path.sep)) return portablePath(path.relative(source, file));
  const plugin = choiceRoots(source).find((value) => file.startsWith(value.root + path.sep));
  return plugin
    ? `plugins/${plugin.id}/${portablePath(path.relative(plugin.root, file))}`
    : undefined;
}
export function guardWindowsConfiguredPluginInstall(relative: string, text: string) {
  if (relative !== "dist/missing-configured-plugin-install-jsvFew4a.js") return text;
  if (sha256(text) !== "637689bddd8bcc278ef7a0af5535b933aa36bdc02510583e1ece61d1b0713354")
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
  const records = "dist/installed-plugin-index-records-NrU3hnwq.js";
  const reader = "dist/installed-plugin-index-record-reader-CrcykudU.js";
  for (const [file, expected] of [
    [records, "5500445dcd66876952758eec91019a3c4dcc4a852498f956022828f0f867d21f"],
    [reader, "2e0f0a33799137ed64dede1f05bf6b19fdba8a4d1f69e3f0f3906ce916d0497a"],
  ])
    if (sha256(fs.readFileSync(path.join(source, file))) !== expected)
      throw new Error("The reviewed plugin record API changed.");
  return `export async function registerPrebuiltPlugins(config) {
  __nemoPrepareAssetRoot();
  const fs = require("node:fs"), path = require("node:path");
  const packages = ${JSON.stringify(Object.fromEntries(Object.entries(PREBUILT_CHOICE_PLUGINS).map(([id, item]) => [id, item.package])))};
  const ids = Object.keys(packages).filter(id=>config.plugins?.entries?.[id]?.enabled === true);
  if (!ids.length) return {schemaVersion:1,registered:[]};
  const selected = ids.map(id=>{
    const directory = path.join(__nemoAssetDir,"plugins",id);
    const metadata = JSON.parse(fs.readFileSync(path.join(directory,"package.json"),"utf8"));
    if(metadata.name!==packages[id]||metadata.version!=="2026.7.1") throw new Error("The prebuilt plugin is missing or differs from this application; repair NemoClaw with its installer.");
    const entries=metadata.openclaw?.runtimeExtensions??metadata.openclaw?.extensions;
    if(!Array.isArray(entries)||!entries.length)throw new Error("The prebuilt plugin runtime is incomplete; repair NemoClaw with its installer.");
    for(const entry of entries) {
      if(typeof entry!=="string"||!entry.startsWith("./dist/")||entry.includes("..")||entry.includes("\\\\")) throw new Error("The prebuilt plugin runtime entry is invalid.");
      const info=fs.lstatSync(path.join(directory,entry));
      if(!info.isFile()||info.isSymbolicLink())throw new Error("The prebuilt plugin runtime entry is unavailable; repair NemoClaw with its installer.");
    }
    return {pluginId:id,source:"path",sourcePath:directory,installPath:directory,version:metadata.version};
  });
  // Called before runCli or runtime loader initialization. These canonical APIs
  // update only the guest state's SQLite record/index and their metadata caches.
  const {t:loadRecords}=await import(${JSON.stringify(path.join(source, reader))});
  const {n:recordPluginInstallInRecords,s:writeRecords}=await import(${JSON.stringify(path.join(source, records))});
  let records=await loadRecords({env:process.env});
  for(const update of selected)records=recordPluginInstallInRecords(records,update);
  await writeRecords(records,{config,env:process.env});
  return {schemaVersion:1,registered:ids};
}\n`;
}

export function compiledPluginPlan(source: string, syntax: Syntax, compiler: Transformer) {
  const entryFiles = filesBelow(path.join(source, "dist", "extensions")).filter(
    (file) =>
      file.endsWith(".js") &&
      path.relative(path.join(source, "dist", "extensions"), file).split(path.sep).length === 2,
  );
  entryFiles.push(path.join(source, "dist", "plugins", "runtime", "index.js"));
  for (const plugin of choiceRoots(source))
    entryFiles.push(
      ...filesBelow(path.join(plugin.root, "dist")).filter((file) => file.endsWith(".js")),
    );
  for (const name of [
    "plugin-entry",
    "extension-shared",
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
      path: packagedModulePath(source, file)!,
      exports: exportNames(syntax, file, text),
      sourceSha256: sha256(text),
    };
  });
  const factories = entries
    .map(
      (entry) =>
        `${JSON.stringify(entry.path)}:()=>require(${JSON.stringify(entryFiles[entries.indexOf(entry)])})`,
    )
    .join(",\n");
  const prelude = `const factories={${factories}};
const registry=Object.freeze({load(key){if(!Object.hasOwn(factories,key))throw Error("Unknown compiled plugin entry");return factories[key]();}});
Object.defineProperty(globalThis,Symbol.for("nemoclaw.compiled-openclaw.plugins.v1"),{value:registry});\n`;
  // Preserve each original module's resource location while compiling its code into one graph.
  // This avoids duplicate plugin/core singletons and does not rewrite any canonical input file.
  const plugin: Plugin = {
    name: "compiled-openclaw-module-locations",
    setup(build) {
      const canonical = createRequire(path.join(source, "package.json"));
      build.onResolve({ filter: /^openclaw(?:\/|$)/ }, (args) => ({
        path: canonical.resolve(args.path),
      }));
      build.onLoad({ filter: /\.[cm]?js$/ }, async (args) => {
        const sourceRelative = packagedModulePath(source, args.path);
        if (sourceRelative === undefined) return;
        const original = fs.readFileSync(args.path, "utf8");
        const text = guardWindowsConfiguredPluginInstall(
          sourceRelative,
          guardWindowsInstallerUpdate(
            sourceRelative,
            normalizeWindowsNativePluginRequire(sourceRelative, original),
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
  const banner = `
function __nemoModuleFilenameFor(relative){return require("node:path").join(__nemoAssetDir,relative);}
function __nemoModuleDirnameFor(relative){return require("node:path").dirname(__nemoModuleFilenameFor(relative));}
function __nemoModuleUrlFor(relative){return require("node:url").pathToFileURL(__nemoModuleFilenameFor(relative)).href;}`;
  return { entries, prelude, plugin, banner };
}
export function publishPluginFacades(app: string, entries: Entry[]) {
  for (const entry of entries) {
    const content =
      `const registry=globalThis[Symbol.for("nemoclaw.compiled-openclaw.plugins.v1")];if(!registry)throw Error("The compiled OpenClaw owner is unavailable");const original=registry.load(${JSON.stringify(entry.path)});\n` +
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
function resolvePackage(source: string, importer: string, name: string) {
  packageName(name);
  let directory = importer;
  const boundary =
    importer.startsWith(source + path.sep) || importer === source
      ? source
      : choiceRoots(source).find(
          (item) => importer === item.root || importer.startsWith(item.root + path.sep),
        )?.root;
  if (!boundary) return undefined;
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
];
export function stagePublishedResources(source: string, app: string, platform = "win32") {
  for (const name of ["package.json", "LICENSE", "THIRD_PARTY_NOTICES.md"])
    copyExact(path.join(source, name), path.join(app, name));
  // UI JavaScript is already the canonical published frontend build. All its dynamic
  // chunks, fonts, styles and other data are copied, never compiled on the customer machine.
  for (const directory of ["dist/control-ui", "skills"]) {
    for (const file of filesBelow(path.join(source, directory)))
      copyExact(file, path.join(app, path.relative(source, file)));
  }
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
      copyExact(file, path.join(app, relative));
  }
  const pending = sidecarRoots.map((name) => {
    const found = resolvePackage(source, source, name);
    if (!found) throw new Error(`Missing pinned runtime sidecar: ${name}`);
    return found;
  });
  for (const name of ["@snazzah/davey", "libopus-wasm", "@discordjs/voice"]) {
    const found = resolvePackage(
      source,
      path.join(path.dirname(source), "plugins", "discord"),
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
    const destination = folder.startsWith(source + path.sep)
      ? portablePath(path.relative(source, folder))
      : "node_modules/" + metadata.name;
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
      metadata.version !== "2026.7.1"
    )
      throw new Error("The reviewed complete choice plugin is required.");
    const locked = JSON.parse(
      fs.readFileSync(path.join(plugin.root, "npm-shrinkwrap.json"), "utf8"),
    ) as { packages: Record<string, { os?: string[]; cpu?: string[] }> };
    const dependencies = Object.entries(locked.packages)
      .filter(([name]) => name.startsWith("node_modules/"))
      .sort(([left], [right]) => right.length - left.length);
    for (const file of filesBelow(plugin.root)) {
      const relative = portablePath(path.relative(plugin.root, file));
      // These complete packages live at the shared agent node_modules root.
      // Do not leave a nearer metadata-only package shadowing their entrypoints.
      if (
        ["undici", "@snazzah/davey", "libopus-wasm", "@discordjs/voice"].some((name) =>
          relative.startsWith("node_modules/" + name + "/"),
        )
      )
        continue;
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
  return packages.sort((a, b) => a.path.localeCompare(b.path));
}
export function resourceInventory(app: string, facadePaths: string[]): ResourceFile[] {
  const facades = new Set(facadePaths);
  return filesBelow(app)
    .filter((file) => !file.endsWith("openclaw-resource-closure.json"))
    .map((file) => {
      const relative = portablePath(path.relative(app, file));
      let role: Role = "metadata";
      if (relative.startsWith("dist/control-ui/")) role = "control-ui";
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
