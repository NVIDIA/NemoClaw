// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// CI-only composition of the pinned package's prebuilt runtime. No dependency scripts run here.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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
export function compiledPluginPlan(source: string, syntax: Syntax, compiler: Transformer) {
  const entryFiles = filesBelow(path.join(source, "dist", "extensions")).filter(
    (file) =>
      file.endsWith(".js") &&
      path.relative(path.join(source, "dist", "extensions"), file).split(path.sep).length === 2,
  );
  entryFiles.push(path.join(source, "dist", "plugins", "runtime", "index.js"));
  for (const name of [
    "plugin-entry",
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
      path: portablePath(path.relative(source, file)),
      exports: exportNames(syntax, file, text),
      sourceSha256: sha256(text),
    };
  });
  const factories = entries
    .map(
      (entry) =>
        `${JSON.stringify(entry.path)}:()=>require(${JSON.stringify(path.join(source, entry.path))})`,
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
      build.onLoad({ filter: /\.[cm]?js$/ }, async (args) => {
        if (!args.path.startsWith(source + path.sep)) return;
        const text = fs.readFileSync(args.path, "utf8");
        if (
          !text.includes("import.meta") &&
          !text.includes("__dirname") &&
          !text.includes("__filename")
        )
          return;
        const relative = JSON.stringify(portablePath(path.relative(source, args.path)));
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
  while (directory === source || directory.startsWith(source + path.sep)) {
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
];
export function stagePublishedResources(source: string, app: string) {
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
  const seen = new Set<string>();
  const packages: { name: string; version: string; path: string; packageSha256: string }[] = [];
  while (pending.length) {
    const folder = pending.shift()!;
    if (seen.has(folder)) continue;
    seen.add(folder);
    const packageBytes = fs.readFileSync(path.join(folder, "package.json"));
    const metadata = JSON.parse(packageBytes.toString("utf8")) as PackageMetadata;
    if (!targetMatches(metadata.os, "win32") || !targetMatches(metadata.cpu, "arm64")) continue;
    packages.push({
      name: metadata.name,
      version: metadata.version,
      path: portablePath(path.relative(source, folder)),
      packageSha256: sha256(packageBytes),
    });
    for (const file of filesBelow(folder)) {
      if (path.relative(folder, file).split(path.sep).includes("node_modules")) continue;
      copyExact(file, path.join(app, path.relative(source, file)));
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
  const brave = path.join(path.dirname(source), "plugins", "brave");
  const braveBytes = fs.readFileSync(path.join(brave, "package.json"));
  const braveMetadata = JSON.parse(braveBytes.toString("utf8")) as PackageMetadata;
  if (braveMetadata.name !== "@openclaw/brave-plugin" || braveMetadata.version !== "2026.7.1")
    throw new Error("The reviewed prebuilt Brave plugin is required.");
  for (const file of filesBelow(brave))
    copyExact(file, path.join(app, "plugins", "brave", path.relative(brave, file)));
  packages.push({
    name: braveMetadata.name,
    version: braveMetadata.version,
    path: "plugins/brave",
    packageSha256: sha256(braveBytes),
  });
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
