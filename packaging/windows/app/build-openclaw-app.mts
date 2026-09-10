// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// CI compiler. Dependency/native builds precede this stage; never run it at install/startup.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import {
  compiledPluginPlan,
  publishPluginFacades,
  stagePublishedResources,
  resourceInventory,
} from "./openclaw-app-resources.mts";

const require = createRequire(import.meta.url);
const external = [
  "@opentelemetry/api",
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
];
function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return path.resolve(process.argv[index + 1]);
}
const source = argument("--source-root");
const output = argument("--output");
const toolRoot = argument("--tool-root");
const portable = process.argv.includes("--portable-proof");
if (
  !portable &&
  (process.platform !== "win32" || process.arch !== "arm64" || process.versions.node !== "22.23.2")
)
  throw new Error("Windows application compilation requires canonical Node 22.23.2 ARM64.");
const compiler = require(
  path.join(toolRoot, "node_modules", "esbuild"),
) as typeof import("esbuild");
if (compiler.version !== "0.27.4") throw new Error("The reviewed compiler is esbuild 0.27.4.");
const materializationBytes = fs.readFileSync(
  path.join(path.dirname(source), "materialization-receipt.json"),
);
const materialization = JSON.parse(materializationBytes.toString("utf8")) as {
  classification: string;
  source: { sha256: string };
  additionalPackages: {
    package: string;
    version: string;
    sha256: string;
    integrity: string;
    bytes: number;
  }[];
};
if (
  materialization.classification !== "verified-application-build-inputs" ||
  materialization.source.sha256 !==
    "67ad539d9915efb63d5f294beeb9290b7172d23c92d8052110a9c8355f783458" ||
  !materialization.additionalPackages?.some(
    (item) =>
      item.package === "@openclaw/brave-plugin" &&
      item.sha256 === "f5198ea18ea0adebc376c669b8e5e1100781f07ec2d9e24e86c90cb82acb039c",
  )
)
  throw new Error("The verified complete application input receipt is required.");
const metadata = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")) as {
  name: string;
  version: string;
};
if (metadata.name !== "openclaw" || metadata.version !== "2026.7.1")
  throw new Error("The exact selected OpenClaw package is required.");
if (fs.existsSync(output)) throw new Error("Compilation output must be fresh.");
fs.mkdirSync(output, { recursive: true });
const app = path.join(output, "app");
const diagnostics = path.join(output, "diagnostics");
fs.mkdirSync(app);
fs.mkdirSync(diagnostics);
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const entry = path.join(source, "dist", "cli", "run-main.js");
const syntaxApi = require(
  path.join(source, "node_modules", "typescript"),
) as typeof import("typescript");
const pluginPlan = compiledPluginPlan(source, syntaxApi, compiler);
const adapter = `${pluginPlan.prelude}export async function runCli(argv = process.argv) {
  __nemoPrepareAssetRoot();
  const upstream = await import(${JSON.stringify(entry.replaceAll("\\", "/"))});
  return await upstream.runCli(argv);
}
export const runOpenClaw = runCli;
if (typeof require !== "undefined" && require.main === module) {
  runCli().catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
}
`;
const banner = `${pluginPlan.banner}\nlet __nemoAssetDir, __nemoFilename, __nemoModuleUrl;
function __nemoPrepareAssetRoot() {
  const path = require("node:path");
  const root = process.env.OPENCLAW_COMPILED_ASSET_ROOT;
  if (!root || !path.isAbsolute(root)) throw new Error("The sealed OpenClaw asset root is required.");
  const resolved = path.resolve(root);
  if (__nemoAssetDir && __nemoAssetDir !== resolved) throw new Error("The compiled OpenClaw asset root cannot change within one process.");
  __nemoAssetDir = resolved;
  __nemoFilename = path.join(resolved, "openclaw-app.cjs");
  __nemoModuleUrl = require("node:url").pathToFileURL(__nemoFilename).href;
}
function __nemoExternalImport(specifier) {
  return require("node:module").createRequire(__nemoFilename)("./openclaw-dynamic-import.cjs")(specifier);
}`;
fs.writeFileSync(path.join(diagnostics, "entry-adapter.mjs"), adapter, { flag: "wx" });
try {
  const result = await compiler.build({
    stdin: {
      contents: adapter,
      resolveDir: source,
      sourcefile: "windows-openclaw-entry.mjs",
      loader: "js",
    },
    outfile: path.join(app, "openclaw-app.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22.23",
    define: {
      __OPENCLAW_VERSION__: JSON.stringify(metadata.version),
    },
    banner: { js: banner },
    plugins: [pluginPlan.plugin],
    external,
    metafile: true,
    sourcemap: "external",
    treeShaking: false,
    keepNames: true,
    logLevel: "warning",
  });
  if (!result.metafile) throw new Error("Compiler input/output evidence is missing.");
  fs.writeFileSync(
    path.join(diagnostics, "metafile.json"),
    JSON.stringify(result.metafile, null, 2) + "\n",
    { flag: "wx" },
  );
  fs.writeFileSync(
    path.join(diagnostics, "warnings.json"),
    JSON.stringify(result.warnings, null, 2) + "\n",
    { flag: "wx" },
  );
  fs.renameSync(
    path.join(app, "openclaw-app.cjs.map"),
    path.join(diagnostics, "pre-import-bridge-openclaw-app.cjs.map"),
  );
  // Native import() cannot execute from a SEA main with useCodeCache. Delegate
  // only these generated external-import expressions to one normal Node module.
  // Internal imports are already compiler module-table calls. No source file is edited.
  const ts = require(path.join(source, "node_modules", "typescript")) as {
    ScriptTarget: { Latest: number };
    ScriptKind: { JS: number };
    SyntaxKind: { ImportKeyword: number };
    createSourceFile(
      name: string,
      text: string,
      target: number,
      parents: boolean,
      kind: number,
    ): AstNode;
    isCallExpression(node: AstNode): boolean;
    forEachChild(node: AstNode, visit: (node: AstNode) => void): void;
  };
  type AstNode = { kind: number; expression?: AstNode; getStart(source: AstNode): number };
  const codePath = path.join(app, "openclaw-app.cjs");
  let codeText = fs.readFileSync(codePath, "utf8");
  const syntax = ts.createSourceFile(
    codePath,
    codeText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const imports: number[] = [];
  const visit = (node: AstNode) => {
    if (ts.isCallExpression(node) && node.expression?.kind === ts.SyntaxKind.ImportKeyword)
      imports.push(node.expression.getStart(syntax));
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  for (const offset of imports.sort((a, b) => b - a)) {
    if (codeText.slice(offset, offset + 6) !== "import")
      throw new Error("Unexpected generated import syntax.");
    codeText = codeText.slice(0, offset) + "__nemoExternalImport" + codeText.slice(offset + 6);
  }
  fs.writeFileSync(codePath, codeText);
  const bridge = '"use strict"; module.exports = specifier => import(specifier);\n';
  fs.writeFileSync(path.join(app, "openclaw-dynamic-import.cjs"), bridge, { flag: "wx" });
  const code = Buffer.from(codeText);
  publishPluginFacades(app, pluginPlan.entries);
  const admittedPackages = stagePublishedResources(source, app);
  const workerResult = await compiler.build({
    entryPoints: [path.join(source, "dist/audit/audit-event-writer.worker.js")],
    outfile: path.join(app, "dist/audit/audit-event-writer.worker.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22.23",
    external,
    metafile: true,
    define: { "import.meta.url": "__workerUrl" },
    banner: { js: 'const __workerUrl=require("node:url").pathToFileURL(__filename).href;' },
  });
  fs.writeFileSync(
    path.join(app, "dist/audit/package.json"),
    JSON.stringify({ type: "commonjs" }) + "\n",
    { flag: "wx" },
  );
  fs.writeFileSync(
    path.join(diagnostics, "plugin-registry.json"),
    JSON.stringify(pluginPlan.entries, null, 2) + "\n",
    { flag: "wx" },
  );
  fs.writeFileSync(
    path.join(diagnostics, "audit-worker-metafile.json"),
    JSON.stringify(workerResult.metafile, null, 2) + "\n",
    { flag: "wx" },
  );
  fs.writeFileSync(
    path.join(output, "build-receipt.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        classification: "compiled-openclaw-code-unit",
        sourceVersion: metadata.version,
        materializationReceiptSha256: sha256(materializationBytes),
        sourcePackageSha256: sha256(fs.readFileSync(path.join(source, "package.json"))),
        sourceLockSha256: sha256(fs.readFileSync(path.join(source, "npm-shrinkwrap.json"))),
        entrySourceSha256: sha256(fs.readFileSync(entry)),
        adapterSha256: sha256(adapter),
        compilerVersion: compiler.version,
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.versions.node,
        portableProof: portable,
        compiledInputs: Object.keys(result.metafile.inputs).length,
        code: { file: "app/openclaw-app.cjs", bytes: code.length, sha256: sha256(code) },
        exports: ["runOpenClaw", "runCli"],
        argvConvention: "full [node, entry, ...args]",
        assetRootEnvironment: "OPENCLAW_COMPILED_ASSET_ROOT",
        nativeImportBridge: {
          file: "app/openclaw-dynamic-import.cjs",
          bytes: Buffer.byteLength(bridge),
          sha256: sha256(bridge),
          rewrittenGeneratedImports: imports.length,
          keepExternalToSea: true,
        },
        externalPackages: external,
        optionalUninstalledPeer: "@opentelemetry/api",
        resourceContract:
          "Original module-relative resource URLs are preserved under the sealed asset root; one shared compiled registry backs canonical plugin facades. Remaining tool/browser execution qualification stays separate.",
        runtimeClosureProven: false,
        windowsQualified: false,
        seaPrepared: false,
        cacheCoverage:
          "Statically link main CJS into shared SEA useCodeCache. The tiny dynamic-import bridge and separately admitted native/ESM sidecars remain normal Node runtime execution; no whole-runtime cache or native-AOT claim.",
        developmentArtifacts:
          "diagnostics/ contains the generated adapter, complete compiler map and the explicitly pre-import-bridge source map; it is not a production expansion tree.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  const resourceReceipt = {
    schemaVersion: 1,
    classification: "compiled-openclaw-resource-closure",
    package: {
      name: metadata.name,
      version: metadata.version,
      sourceArchiveSha256: "67ad539d9915efb63d5f294beeb9290b7172d23c92d8052110a9c8355f783458",
      shrinkwrapSha256: sha256(fs.readFileSync(path.join(source, "npm-shrinkwrap.json"))),
    },
    compiler: {
      receiptSha256: sha256(fs.readFileSync(path.join(output, "build-receipt.json"))),
      mainSha256: sha256(code),
      bridgeSha256: sha256(bridge),
      pluginRegistryModuleCount: pluginPlan.entries.length,
    },
    files: resourceInventory(
      app,
      pluginPlan.entries.map((entry) => entry.path),
    ),
    controlUiRoot: "dist/control-ui",
    canonicalPluginEntries: pluginPlan.entries,
    admittedPackages,
    additionalInputArchives: materialization.additionalPackages.map(
      ({ package: name, version, sha256, integrity, bytes }) => ({
        name,
        version,
        sha256,
        integrity,
        bytes,
      }),
    ),
    absentOptionalPeers: ["@opentelemetry/api", "bufferutil", "utf-8-validate", "supports-color"],
    closureAdmitted: false,
    closureAdmissionMeaning:
      "Reviewed selected gateway composition with no customer build/install fallback; independent of execution qualification. Pending final sidecar/tool and Windows checks.",
    qualification: {
      portableGatewayObserved: false,
      windowsGatewayObserved: false,
      modelTools: false,
    },
  };
  fs.writeFileSync(
    path.join(app, "openclaw-resource-closure.json"),
    JSON.stringify(resourceReceipt, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      compiledInputs: Object.keys(result.metafile.inputs).length,
      codeBytes: code.length,
      externalPackages: external.length,
      runtimeClosureProven: false,
    }),
  );
} catch (error) {
  try {
    fs.writeFileSync(
      path.join(output, "build-failure.json"),
      JSON.stringify(
        {
          classification: "application-compiler-failure",
          error: error instanceof Error ? error.message : "Compilation failed.",
        },
        null,
        2,
      ) + "\n",
    );
  } catch {
    /* Failure evidence must not replace the original compiler exception. */
  }
  throw error;
}
