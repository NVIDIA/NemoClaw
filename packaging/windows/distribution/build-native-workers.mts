// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Build-time source materialization only. No source factory is invoked by the
// distributed host or guest; their artifacts are executable JavaScript bundles.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build, version as esbuildVersion } from "esbuild";
import ts from "typescript";
import { prepareRuntimeSource } from "./prepare-runtime-source.mts";

const factories = [
  ["openclaw-turn", "run-installed-native-turn.mts", "probeSource"],
  ["openclaw-web", "run-installed-native-web-ui.mts", "gatewaySource"],
  ["pi-turn", "run-installed-native-pi.mts", "piWorkloadSource"],
  ["hermes-turn", "run-installed-native-pi.mts", "hermesWorkloadSource"],
  ["deepagents-turn", "run-installed-native-pi.mts", "deepAgentsWorkloadSource"],
  ["interactive", "run-installed-native-console-agent.mts", "interactiveWorkloadSource"],
  ["nemocua", "native-nemocua-relay.mts", "relayWorkloadSource"],
] as const;

function parse(name: string, text: string) {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (
    (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
      .length
  )
    throw new Error("The reviewed worker source does not parse: " + name);
  return source;
}
function all<T extends ts.Node>(root: ts.Node, match: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node) => {
    if (match(node)) result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}
function evaluateBuildExpression(text: string, values: Record<string, unknown> = {}) {
  // Only exact checked-in first-party source is evaluated in the CI build.
  return Function(
    ...Object.keys(values),
    '"use strict"; return (' + text + ");",
  )(...Object.values(values));
}
function renderFactory(root: string, file: string, name: string) {
  const source = parse(file, fs.readFileSync(path.join(root, file), "utf8"));
  const matches = all(source, ts.isFunctionDeclaration).filter((node) => node.name?.text === name);
  if (matches.length !== 1) throw new Error("A build-only source factory is missing or ambiguous.");
  const code = matches[0].getText(source).replace(/^export\s+/u, "");
  const dashboard = parse(
    "dashboard.mts",
    fs.readFileSync(path.join(root, "native-hermes-dashboard.mts"), "utf8"),
  );
  const helper = all(dashboard, ts.isFunctionDeclaration).find(
    (node) => node.name?.text === "hermesDashboardPythonSource",
  );
  if (!helper) throw new Error("The reviewed Hermes dashboard source is missing.");
  const helperJs = ts.transpileModule(helper.getText(dashboard).replace(/^export\s+/u, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const hermesDashboardPythonSource = Function(
    helperJs + "\nreturn hermesDashboardPythonSource;",
  )();
  const value = evaluateBuildExpression("(" + code + ")()", { hermesDashboardPythonSource });
  if (typeof value !== "string" || Buffer.byteLength(value) > 256 * 1024)
    throw new Error("Invalid build-time worker source.");
  return value;
}

export function staticWorkerSource(mode: string, input: string, assets: Map<string, string>) {
  const source = parse(mode + ".mjs", input);
  const edits: { start: number; end: number; text: string }[] = [];
  const declarations = all(source, ts.isVariableDeclaration);
  const shim = declarations.find((node) => node.name.getText(source) === "deepAgentsTempfileShim");
  const deepAgentsTempfileShim = shim?.initializer
    ? evaluateBuildExpression(shim.initializer.getText(source))
    : [];
  const writes = all(source, ts.isCallExpression).filter(
    (call) =>
      call.expression.getText(source) === "writeFileSync" &&
      call.arguments[0]?.getText(source) === "runner",
  );
  for (const call of writes) {
    const block = call.parent.parent;
    const runner = all(block, ts.isVariableDeclaration).find(
      (node) => node.name.getText(source) === "runner",
    );
    if (!runner?.initializer || !ts.isExpressionStatement(call.parent))
      throw new Error("Unknown Python worker construction.");
    const hermes = runner.initializer.getText(source).includes("hermes");
    const variants =
      mode === "interactive" && hermes
        ? ([
            ["hermes-console", false, false],
            ["hermes-console-probe", false, true],
            ["hermes-dashboard", true, false],
            ["hermes-dashboard-probe", true, true],
          ] as const)
        : ([[mode === "interactive" ? "deepagents-console" : mode, false, false]] as const);
    for (const [name, dashboard, consoleProbe] of variants) {
      const value = evaluateBuildExpression(call.arguments[1].getText(source), {
        dashboard,
        consoleProbe,
        deepAgentsTempfileShim,
      });
      if (typeof value !== "string" || Buffer.byteLength(value) > 64 * 1024)
        throw new Error("Invalid static Python worker.");
      assets.set(name + ".py", value);
    }
    const filename =
      mode === "interactive" && hermes
        ? '(dashboard ? "hermes-dashboard" : "hermes-console") + (process.env.NEMOCLAW_AGENT_CONSOLE_PROBE ? "-probe" : "") + ".pyc"'
        : JSON.stringify((mode === "interactive" ? "deepagents-console" : mode) + ".pyc");
    edits.push({
      start: runner.initializer.getStart(source),
      end: runner.initializer.end,
      text: "nativeGuestAsset(" + filename + ")",
    });
    edits.push({ start: call.parent.getStart(source), end: call.parent.end, text: "" });
  }
  const expected = ["hermes-turn", "deepagents-turn"].includes(mode)
    ? 1
    : mode === "interactive"
      ? 2
      : 0;
  if (writes.length !== expected) throw new Error("The Python worker site inventory changed.");
  if (mode === "openclaw-turn") {
    const worker = declarations.find((node) => node.name.getText(source) === "workerSource");
    if (!worker?.initializer) throw new Error("The OpenClaw worker source is missing.");
    assets.set(
      "openclaw-invoke.cjs",
      [
        'const { workerData } = require("node:worker_threads");',
        'const { createRequire } = require("node:module");',
        "process.argv = [process.execPath, workerData.entry, ...workerData.args];",
        "Promise.resolve(createRequire(workerData.entry)(workerData.entry).runOpenClaw(process.argv)).catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exit(1); });",
        "",
      ].join("\n"),
    );
    edits.push({
      start: worker.initializer.getStart(source),
      end: worker.initializer.end,
      text: 'nativeGuestAsset("openclaw-invoke.cjs")',
    });
    const evalFlags = all(source, ts.isPropertyAssignment).filter(
      (node) => node.name.getText(source) === "eval",
    );
    if (evalFlags.length !== 1 || evalFlags[0].initializer.kind !== ts.SyntaxKind.TrueKeyword)
      throw new Error("The original Worker contract changed.");
    edits.push({
      start: evalFlags[0].initializer.getStart(source),
      end: evalFlags[0].initializer.end,
      text: "false",
    });
  }
  let rewritten = input;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
  if (mode === "openclaw-turn")
    rewritten = rewritten.replace(
      'const entry = join(dirname(launcher), "dist", "entry.js");',
      "const entry = launcher;",
    );
  if (mode === "openclaw-web") {
    const expression = "import(pathToFileURL(launcher).href)";
    if (!rewritten.includes(expression))
      throw new Error("The OpenClaw gateway entry contract changed.");
    rewritten = rewritten.replace(expression, "runPackagedOpenClaw(process.argv)");
  }
  const result = parse(mode + ".mjs", rewritten);
  const imports = result.statements
    .filter(ts.isImportDeclaration)
    .map((node) => node.getText(result));
  const statements = result.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText(result));
  return [
    'import { nativeGuestAsset } from "./native-assets.mts";',
    ...(mode === "openclaw-web"
      ? ['import { runPackagedOpenClaw } from "native-openclaw-api";']
      : []),
    ...imports,
    "export async function run() {",
    ...statements,
    "}\n",
  ].join("\n");
}

export async function buildNativeWorkers(
  runtimeSource: string,
  output: string,
  openClawBundle?: string,
) {
  if (fs.existsSync(output)) throw new Error("The prebuilt runtime output must be fresh.");
  fs.mkdirSync(output, { recursive: true });
  const assets = new Map<string, string>();
  const generated = new Map<string, string>();
  const inputs = new Map<string, string>();
  for (const [mode, file, factory] of factories) {
    generated.set(
      mode,
      staticWorkerSource(mode, renderFactory(runtimeSource, file, factory), assets),
    );
    inputs.set(
      file,
      createHash("sha256")
        .update(fs.readFileSync(path.join(runtimeSource, file)))
        .digest("hex"),
    );
  }
  const common = {
    define: { NEMOCLAW_BUNDLED_RUNTIME: "true" },
    bundle: true,
    platform: "node" as const,
    target: "node22",
    format: "esm" as const,
    minify: false,
    sourcemap: false as const,
    metafile: true,
    treeShaking: true,
  };
  const host = await build({
    ...common,
    entryPoints: [path.join(runtimeSource, "native-main.mts")],
    outfile: path.join(output, "native-host.mjs"),
  });
  const guestMain =
    [...generated.keys()]
      .map((mode, index) => `import { run as run${index} } from "worker:${mode}";`)
      .join("\n") +
    "\nconst modes = {" +
    [...generated.keys()].map((mode, index) => JSON.stringify(mode) + ":run" + index).join(",") +
    "};\n" +
    'const mode = process.env.NEMOCLAW_WORKER_MODE;\nif (!Object.hasOwn(modes, mode ?? "")) throw new Error("The prebuilt guest mode is invalid.");\nPromise.resolve(modes[mode]()).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });\n';
  const plugins = [
    {
      name: "reviewed-static-workers",
      setup(builder: import("esbuild").PluginBuild) {
        builder.onResolve({ filter: /^worker:/ }, (args) => ({
          path: args.path.slice(7),
          namespace: "native-worker",
        }));
        builder.onLoad({ filter: /.*/, namespace: "native-worker" }, (args) => ({
          contents: generated.get(args.path),
          loader: "js" as const,
          resolveDir: runtimeSource,
        }));
        builder.onResolve({ filter: /^native-openclaw-api$/ }, () => ({
          path: "api",
          namespace: "native-openclaw",
        }));
        builder.onLoad({ filter: /.*/, namespace: "native-openclaw" }, () => ({
          loader: "js" as const,
          resolveDir: runtimeSource,
          contents: openClawBundle
            ? "export { runOpenClaw as runPackagedOpenClaw } from " +
              JSON.stringify(path.resolve(openClawBundle)) +
              ";"
            : 'import { createRequire } from "node:module"; export async function runPackagedOpenClaw(argv) { const entry = process.env.NEMOCLAW_MXC_OPENCLAW_ENTRY; if (!entry) throw new Error("Missing prebuilt OpenClaw entry"); return await createRequire(entry)(entry).runOpenClaw(argv); }',
        }));
      },
    },
  ];
  const guest = await build({
    ...common,
    stdin: { contents: guestMain, sourcefile: "native-guest-entry.mjs", resolveDir: runtimeSource },
    outfile: path.join(output, "native-guest.mjs"),
    plugins,
  });
  const unified =
    'import { dispatchNativeEntry, nativeEntryModes } from "./native-dispatch.mts";\nimport { isSea } from "node:sea";\n' +
    guestMain.slice(0, guestMain.indexOf("const mode =")) +
    'if (process.argv[2] === "--describe-runtime" && process.argv.length === 3) { process.stdout.write(JSON.stringify({schemaVersion:1,kind:"prebuilt-native-runtime",sea:isSea(),node:process.version,hostModes:nativeEntryModes,guestModes:Object.keys(modes)})+"\\n"); }\n' +
    'else { const guestMode = process.env.NEMOCLAW_WORKER_MODE; const action = guestMode === undefined ? () => dispatchNativeEntry(process.argv[2], process.argv.slice(3)) : modes[guestMode]; if (!action) throw new Error("The prebuilt runtime mode is invalid"); Promise.resolve(action()).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }); }\n';
  const combined = await build({
    ...common,
    format: "cjs",
    stdin: { contents: unified, sourcefile: "native-runtime-entry.cjs", resolveDir: runtimeSource },
    outfile: path.join(output, "native-runtime.cjs"),
    plugins,
  });
  const python = path.join(output, "python-build-inputs");
  fs.mkdirSync(python);
  for (const [name, content] of assets)
    fs.writeFileSync(path.join(name.endsWith(".py") ? python : output, name), content, {
      flag: "wx",
    });
  fs.copyFileSync(
    path.join(runtimeSource, "native-inference-manifest.json"),
    path.join(output, "native-inference-manifest.json"),
  );
  const files = fs
    .readdirSync(output)
    .filter((name) => fs.statSync(path.join(output, name)).isFile())
    .map((name) => {
      const data = fs.readFileSync(path.join(output, name));
      return {
        file: name,
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      };
    });
  const report = {
    schemaVersion: 1,
    classification: "prebuilt-windows-runtime-bundles",
    esbuildVersion,
    typescriptVersion: ts.version,
    modes: [...generated.keys()],
    files,
    factoryInputs: Object.fromEntries(inputs),
    hostInputs: Object.keys(host.metafile!.inputs),
    guestInputs: Object.keys(guest.metafile!.inputs),
    combinedInputs: Object.keys(combined.metafile!.inputs),
    openClawStaticallyLinked: Boolean(openClawBundle),
    pythonBytecodeCompilationRequired: true,
    installedExecutionQualified: false,
    userSideSourceGenerationRequired: false,
  };
  fs.writeFileSync(path.join(output, "build.json"), JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error("The CI runtime output directory is required.");
  const source = fileURLToPath(new URL("../runtime", import.meta.url));
  const staged = prepareRuntimeSource(
    source,
    fileURLToPath(new URL("./prebuilt-runtime.patch", import.meta.url)),
  );
  try {
    await buildNativeWorkers(staged.runtime, path.resolve(output), process.argv[3]);
    fs.writeFileSync(
      path.join(output, "source-adaptation.json"),
      JSON.stringify(staged.receipt, null, 2) + "\n",
      { flag: "wx" },
    );
  } finally {
    staged.close();
  }
}
