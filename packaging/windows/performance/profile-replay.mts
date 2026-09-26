// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BASELINE_RUNNER_SHA256 =
  "1dec4d760c023e973cf908e9f488023843ba5d8038fb6069e87da5e94fa8784a";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export function matchesProfileChatNavigation(actual: URL, expectedUrl: string): boolean {
  const expected = new URL(expectedUrl);
  return actual.origin === expected.origin && actual.pathname === expected.pathname;
}

export function makeDiagnosticReplay(
  source: string,
  installedHelpers: string,
  collectorModule: string,
) {
  if (hash(source) !== BASELINE_RUNNER_SHA256)
    throw new Error("The diagnostic adapter requires the exact f8 baseline runner.");
  const changes: { label: string; before: string; after: string }[] = [];
  let output = source;
  const replace = (label: string, before: string, after: string) => {
    if (output.split(before).length !== 2)
      throw new Error(`The exact diagnostic adaptation boundary is missing: ${label}.`);
    output = output.replace(before, after);
    changes.push({ label, before, after });
  };
  const headerEnd = output.indexOf("const TURN_PROOFS =");
  if (headerEnd < 0) throw new Error("The baseline import boundary is unavailable.");
  const beforeHeader = output.slice(0, headerEnd);
  const afterHeader =
    beforeHeader.replace(
      /from "\.\/([^"/]+\.mts)"/gu,
      (_all, name: string) =>
        `from ${JSON.stringify(pathToFileURL(path.join(installedHelpers, name)).href)}`,
    ) +
    `import { harvestReplay, matchesProfileChatNavigation } from ${JSON.stringify(pathToFileURL(collectorModule).href)};\n`;
  replace("bind original helper imports to the installed baseline", beforeHeader, afterHeader);
  replace(
    "own diagnostic output and shutdown facts",
    "    let primaryError;",
    "    let primaryError;\n    let profilingRoot = '';\n    let profilingSandboxAbsent = false;\n    let profilingGatewayStopped = false;\n    let profilingExecutorCompleted = false;",
  );
  replace(
    "create diagnostic-only output directory",
    '      const node = path.join(runtimeRoot, "node.exe");',
    '      profilingRoot = path.join(shareRoot, "profiling");\n      fs.mkdirSync(profilingRoot);\n      const node = path.join(runtimeRoot, "node.exe");',
  );
  replace(
    "direct contained Node CPU and module/fs traces",
    "command: [node, gatewayScript],",
    'command: [node, "--cpu-prof", "--cpu-prof-interval=1000", "--cpu-prof-dir=" + profilingRoot, "--trace-event-categories=v8,v8.execute,disabled-by-default-v8.compile,node.environment,node.module_timer,node.fs.sync,node.fs.async,node.fs_dir.sync,node.fs_dir.async", "--trace-event-file-pattern=" + path.join(profilingRoot, "node-${pid}-${rotation}.json"), gatewayScript],',
  );
  replace(
    "enable official startup tracing inside the existing grant",
    "        NEMOCLAW_MXC_HOME: home,",
    "        NEMOCLAW_MXC_HOME: home,\n        NEMOCLAW_PROFILE_ROOT: profilingRoot,\n        OPENCLAW_GATEWAY_STARTUP_TRACE: '1',",
  );
  replace(
    "own the bounded contained trace monitor",
    "let agentFailed = false;",
    "let agentFailed = false;\nlet profilingBudget;\nlet rejectProfilingBudget;\nconst profilingBudgetFailure = new Promise((_, reject) => { rejectProfilingBudget = reject; });\nvoid profilingBudgetFailure.catch(() => {});",
  );
  replace(
    "bind contained diagnostic destination",
    'const modelPort = brokerTunnel?.port ?? Number(required("NEMOCLAW_MXC_MODEL_PORT"));',
    'const profilingRoot = required("NEMOCLAW_PROFILE_ROOT");\nconst modelPort = brokerTunnel?.port ?? Number(required("NEMOCLAW_MXC_MODEL_PORT"));',
  );
  replace(
    "bound ongoing contained trace files",
    'const profilingRoot = required("NEMOCLAW_PROFILE_ROOT");',
    `const profilingRoot = required("NEMOCLAW_PROFILE_ROOT");
profilingBudget = setInterval(() => {
  try {
    const names = fs.readdirSync(profilingRoot);
    const bytes = names.reduce((sum, name) => sum + fs.statSync(join(profilingRoot, name)).size, 0);
    if (names.length > 64 || bytes > 256 * 1024 * 1024) rejectProfilingBudget(new Error("Contained diagnostic traces exceeded their file/byte budget."));
  } catch { rejectProfilingBudget(new Error("Contained diagnostic trace budget could not be observed.")); }
}, 500);
profilingBudget.unref();`,
  );
  replace(
    "measure deterministic model handler separately",
    "const mock = qualification && brokerTunnel === null ? createServer(async (request, response) => {",
    `const mock = qualification && brokerTunnel === null ? createServer(async (request, response) => {
  const began = process.hrtime.bigint();
  response.once("finish", () => {
    const elapsedMs = Number(process.hrtime.bigint() - began) / 1e6;
    try { fs.appendFileSync(join(profilingRoot, "model-timing.jsonl"), JSON.stringify({ schemaVersion: 1, classification: "deterministic-model-handler", elapsedMs, method: request.method, status: response.statusCode, realProviderLatency: false }) + "\\n"); } catch { rejectProfilingBudget(new Error("The diagnostic model timing could not be saved.")); }
  });`,
  );
  replace(
    "retain actual upstream startup messages",
    'writeFileSync(join(configDirectory, "openclaw.json"), JSON.stringify({\n  ...serviceConfiguration,',
    'writeFileSync(join(configDirectory, "openclaw.json"), JSON.stringify({\n  ...serviceConfiguration,\n  logging: { level: "debug", consoleLevel: "debug", file: join(profilingRoot, "openclaw-startup.jsonl") },',
  );
  replace(
    "read the actual active plugin registry before shutdown",
    "await Promise.race([fileTunnelTask, gatewayFailure, ...(brokerTunnel ? [brokerTunnel.failure] : [])]);",
    `await Promise.race([fileTunnelTask, gatewayFailure, profilingBudgetFailure, ...(brokerTunnel ? [brokerTunnel.failure] : [])]);
const registryModule = await import(new URL("./dist/runtime-pr_AayQr.js", pathToFileURL(launcher)).href);
const registry = registryModule.c();
const plugins = (registry?.plugins ?? []).map((item) => ({ id: item.id, status: item.status, enabled: item.enabled }));
if (plugins.length > 512 || plugins.some((item) => typeof item.id !== "string" || item.id.length > 256 || typeof item.status !== "string" || item.status.length > 64)) throw new Error("The diagnostic plugin registry is invalid.");
writeFileSync(join(profilingRoot, "active-plugins.json"), JSON.stringify({ schemaVersion: 1, classification: "actual-active-plugin-registry", observedBeforeShutdown: true, registryAvailable: registry != null, plugins, perPluginElapsedMs: null }) + "\\n");`,
  );
  replace(
    "close the trace budget on every guest exit",
    "  await stopOwnedGateway(agentFailed, async () => { await brokerTunnel?.close(); });",
    "  clearInterval(profilingBudget);\n  await stopOwnedGateway(agentFailed, async () => { await brokerTunnel?.close(); });",
  );
  replace(
    "accept the dashboard session query on the exact expected origin and path",
    "    await page.waitForURL(`${openClawUrl}/chat`, { timeout: 30_000 });",
    "    await page.waitForURL((url) => matchesProfileChatNavigation(url, `${openClawUrl}/chat`), { timeout: 30_000 });",
  );
  replace(
    "measure a real post-response dashboard idle interval",
    "    await sleep(3000);\n    return { browserVersion, demonstratedAgentChoices, disabledAgentChoices, turns };",
    `    await sleep(3000);
    const idleStarted = process.hrtime.bigint();
    console.log("PROFILE_IDLE_BEGIN");
    await sleep(30_000);
    const idleElapsedMs = Number(process.hrtime.bigint() - idleStarted) / 1e6;
    fs.writeFileSync(path.join(evidenceRoot, "idle-interval.json"), JSON.stringify({schemaVersion:1,classification:"live-dashboard-idle-interval",elapsedMs:idleElapsedMs,requestedMs:30000,afterThreeVisibleResponses:true}) + "\\n", {flag:"wx"});
    console.log("PROFILE_IDLE_END");
    return { browserVersion, demonstratedAgentChoices, disabledAgentChoices, turns };`,
  );
  replace(
    "require observed MXC execution completion",
    '              if (completion === "ExecFailed")',
    '              profilingExecutorCompleted = true;\n              if (completion === "ExecFailed")',
  );
  replace(
    "require actual registry absence before harvest",
    "            if (jsonContainsExactValue(JSON.parse(listed.stdout), sandboxName)) throw new Error();",
    "            if (jsonContainsExactValue(JSON.parse(listed.stdout), sandboxName)) throw new Error();\n            profilingSandboxAbsent = true;",
  );
  replace(
    "require gateway exit before harvest",
    "            if (gateway && gateway.pid && !(await stopChild(gateway))) throw new Error();",
    "            if (gateway && gateway.pid && !(await stopChild(gateway))) throw new Error();\n            profilingGatewayStopped = true;",
  );
  replace(
    "harvest before original temporary-root cleanup",
    '        [\n          "temporary runtime directories",',
    `        [
          "diagnostic artifact harvest",
          async () => {
            if (!profilingRoot) return;
            await harvestReplay(profilingRoot, path.join(evidenceRoot, "contained-traces"), !create || (profilingSandboxAbsent && profilingGatewayStopped && profilingExecutorCompleted), [modelToken, relayToken, brokerRelayToken]);
          },
        ],
        [
          "temporary runtime directories",`,
  );
  return { source: output, beforeSha256: hash(source), afterSha256: hash(output), changes };
}

async function checkWindowsReparseAttributes(paths: string[]) {
  if (process.platform !== "win32") return;
  const executable = path.join(
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script =
    "$ErrorActionPreference='Stop'; try { $paths=[Console]::In.ReadToEnd() | ConvertFrom-Json; foreach($p in $paths) { if(([IO.File]::GetAttributes([string]$p) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse'} }; [Console]::Out.Write('ORDINARY') } catch { exit 1 }";
  const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  child.stderr.resume();
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.length > 64) child.kill();
  });
  const finished = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  child.stdin.end(JSON.stringify(paths));
  const timeout = setTimeout(() => child.kill(), 15000);
  try {
    if ((await finished) !== 0 || output !== "ORDINARY")
      throw new Error("Windows rejected a reparse or unreadable diagnostic path.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function harvestReplay(
  root: string,
  destination: string,
  producerStopped: boolean,
  secrets: string[],
) {
  if (fs.existsSync(destination)) throw new Error("Diagnostic harvest needs a fresh destination.");
  fs.mkdirSync(destination);
  const manifest: { path: string; bytes: number; sha256: string }[] = [];
  let total = 0;
  let primary: unknown;
  try {
    if (!producerStopped)
      throw new Error(
        "Diagnostic files cannot be read before the contained producer is confirmed stopped.",
      );
    const actualRoot = fs.realpathSync(root);
    if (
      actualRoot.toLowerCase() !== path.resolve(root).toLowerCase() ||
      fs.lstatSync(root).isSymbolicLink()
    )
      throw new Error("The diagnostic root was redirected.");
    const names = fs.readdirSync(root);
    if (names.length > 64) throw new Error("The diagnostic file count exceeded its bound.");
    const parents = [root];
    for (
      let directory = path.dirname(root);
      directory !== path.dirname(directory);
      directory = path.dirname(directory)
    )
      parents.push(directory);
    await checkWindowsReparseAttributes([
      ...parents,
      ...names.map((name) => path.join(root, name)),
    ]);
    for (const name of names) {
      if (!/^[A-Za-z0-9_.-]+\.(?:json|jsonl|cpuprofile)$/u.test(name))
        throw new Error("The diagnostic filename is unsupported.");
      const file = path.join(root, name);
      const stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > 128 * 1024 * 1024 ||
        fs.realpathSync(file).toLowerCase() !== file.toLowerCase()
      )
        throw new Error("The diagnostic file is redirected or exceeds its bound.");
      total += stat.size;
      if (total > 256 * 1024 * 1024)
        throw new Error("The diagnostic output exceeded its total bound.");
      const descriptor = fs.openSync(file, "r");
      let bytes: Buffer;
      try {
        const opened = fs.fstatSync(descriptor);
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.dev !== stat.dev ||
          opened.ino !== stat.ino ||
          opened.size !== stat.size
        )
          throw new Error("The stopped diagnostic file changed before reading.");
        bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
          if (!count) throw new Error("A diagnostic file ended unexpectedly.");
          offset += count;
        }
        if (fs.fstatSync(descriptor).size !== opened.size)
          throw new Error("A diagnostic file grew while reading.");
      } finally {
        fs.closeSync(descriptor);
      }
      let text = bytes.toString("utf8");
      for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[REDACTED]");
      text = text.replace(/(Bearer\s+)[^\s"',;]+/giu, "$1[REDACTED]");
      fs.writeFileSync(path.join(destination, name), text, { flag: "wx" });
      manifest.push({ path: name, bytes: Buffer.byteLength(text), sha256: hash(text) });
    }
    if (!manifest.some((file) => file.path.endsWith(".cpuprofile")))
      throw new Error("The contained Node CPU profile did not finalize.");
    if (!manifest.some((file) => /^node-.*\.json$/u.test(file.path)))
      throw new Error("The contained Node event trace did not finalize.");
    const log = fs.readFileSync(path.join(destination, "openclaw-startup.jsonl"), "utf8");
    if (!log.includes("startup trace:"))
      throw new Error("The actual upstream startup trace is missing.");
    const plugins = JSON.parse(
      fs.readFileSync(path.join(destination, "active-plugins.json"), "utf8"),
    );
    if (plugins.registryAvailable !== true)
      throw new Error("The actual active plugin registry was unavailable.");
  } catch (error) {
    primary = error;
  } finally {
    try {
      fs.writeFileSync(
        path.join(destination, "harvest.json"),
        JSON.stringify({
          schemaVersion: 1,
          classification: "stopped-contained-diagnostic-artifacts",
          producerStopped,
          complete: primary === undefined,
          totalSourceBytes: total,
          files: manifest,
          error: primary instanceof Error ? primary.message : null,
        }) + "\n",
        { flag: "wx" },
      );
    } catch (error) {
      primary ??= error;
    }
  }
  if (primary !== undefined) throw primary;
}
