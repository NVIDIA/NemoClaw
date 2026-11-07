// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath as nativeEntryFile } from "node:url";
declare const NEMOCLAW_BUNDLED_RUNTIME: boolean | undefined;
import { nativeWorkerAssets } from "./native-assets.mts";
import { openInstalledRuntimeSession } from "./installed-runtime-provider.mts";
import {
  withNativeRuntimeSession,
  nativeRuntimeWorkerCommand,
  type NativeRuntimeSession,
} from "./native-runtime.mts";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  allowlistedWindowsEnvironment,
  requiredFile,
  stopChild,
  removeDirectory,
} from "./native-command.mts";
export {
  allowlistedWindowsEnvironment,
  requiredFile,
  run,
  stopChild,
  removeDirectory,
} from "./native-command.mts";

import {
  NATIVE_NODE_UI_POLICY,
  readOpenedRegularFile,
  writeNativeGatewayConfig,
} from "./native-security.mts";
import { attemptNativeUiCleanup } from "./native-ui-lifecycle.mts";

const TIMEOUT_MS = 300_000;
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function fail(message: string): never {
  throw new Error(`Native Windows MXC turn qualification failed: ${message}`);
}

export function requiredDirectory(directory: string, label: string) {
  const resolved = path.resolve(directory);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) fail(`${label} is missing`);
  return resolved;
}

export function argumentValue(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

export async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate a loopback port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

export async function waitForPort(
  port: number,
  child: ChildProcess,
  label = "OpenShell gateway",
  timeout = 60_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`${label} exited before readiness`);
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await sleep(500);
  }
  fail(`${label} did not become ready`);
}

/** Wait for the owned workload result; a successful create only proves provisioning. */
export async function waitForNativeTurnResult(
  resultPath: string,
  create: Pick<ChildProcess, "exitCode" | "signalCode">,
  gateway: Pick<ChildProcess, "exitCode" | "signalCode">,
  createFailure: { error: Error | null },
  timeout = TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (createFailure.error !== null) throw createFailure.error;
    if (create.signalCode !== null || (create.exitCode !== null && create.exitCode !== 0))
      fail(
        `OpenShell sandbox request exited ${create.exitCode ?? create.signalCode ?? "unknown"} before publishing a result`,
      );
    if (gateway.exitCode !== null || gateway.signalCode !== null)
      fail("OpenShell MXC gateway stopped before the installed OpenClaw turn published a result");
    if (fs.existsSync(resultPath)) return;
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  fail("installed OpenClaw turn did not publish a result");
}

export async function waitForFileText(file: string, expected: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(expected)) return true;
    await sleep(250);
  }
  return false;
}

export function jsonContainsExactValue(value: unknown, target: unknown): boolean {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((item) => jsonContainsExactValue(item, target));
  if (value !== null && typeof value === "object")
    return Object.values(value).some((item) => jsonContainsExactValue(item, target));
  return false;
}

export function quoteYamlPath(value: string) {
  return JSON.stringify(value.replaceAll("\\", "/"));
}

export function sanitizedDiagnostic(
  text: string,
  replacements: readonly (readonly [string, string])[],
) {
  let sanitized = text.slice(-64 * 1024);
  for (const [value, replacement] of replacements) {
    if (value) sanitized = sanitized.replaceAll(value, replacement);
  }
  return sanitized
    .replaceAll(/C:\\Users\\[^\\\r\n]+/giu, "<user-profile>")
    .replaceAll(/[A-Za-z0-9_-]{32,}/gu, "<opaque>");
}

export function probeSource() {
  return String.raw`import { Worker } from "node:worker_threads";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { nativeLocalPipeName } from "./native-local-pipe.mts";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};
const launcher = required("NEMOCLAW_MXC_OPENCLAW_ENTRY");
const entry = join(dirname(launcher), "dist", "entry.js");
const home = required("NEMOCLAW_MXC_HOME");
const resultPath = required("NEMOCLAW_MXC_RESULT");
const mockPort = Number(required("NEMOCLAW_MXC_MOCK_PORT"));
const env = {
  ...process.env,
  HOME: home,
  NODE_DISABLE_COMPILE_CACHE: "1",
  NEMOCLAW_MXC_BROKER_PIPE_PORT: String(mockPort),
  OPENCLAW_HOME: home,
  OPENCLAW_NO_RESPAWN: "1",
  USERPROFILE: home,
};
const workerSource = [
  'const { workerData } = require("node:worker_threads");',
  'const { pathToFileURL } = require("node:url");',
  'process.argv = [process.execPath, workerData.entry, ...workerData.args];',
  'import(pathToFileURL(workerData.entry).href).catch((error) => {',
  '  console.error(error instanceof Error ? error.stack ?? error.message : String(error));',
  '  process.exit(1);',
  '});',
].join("\n");
const run = async (args, timeout = 210000) => {
  const worker = new Worker(workerSource, { eval: true, env, execArgv: ["--preserve-symlinks", "--preserve-symlinks-main"], resourceLimits: { stackSizeMb: 64 }, stderr: true, stdout: true, workerData: { args, entry } });
  let stdout = "";
  let stderr = "";
  worker.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  worker.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({ exitCode: 1, stdout, stderr: stderr + "OpenClaw worker timed out" });
    }, timeout);
    worker.once("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: stderr + (error instanceof Error ? error.message : String(error)) });
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
};
const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};
const mock = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "mock-chat", object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  const body = JSON.parse(await readBody(request));
  if (body?.model !== "mock-chat" || !Array.isArray(body?.messages)) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unexpected request" } }));
    return;
  }
  const id = "chatcmpl-nemoclaw-native";
  const created = Math.floor(Date.now() / 1000);
  if (body.stream === true) {
    response.writeHead(200, { "cache-control": "no-cache", connection: "keep-alive", "content-type": "text/event-stream" });
    for (const value of [
      { id, object: "chat.completion.chunk", created, model: "mock-chat", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "mock-chat", choices: [{ index: 0, delta: { content: "CHAT_OK" }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "mock-chat", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]) response.write("data: " + JSON.stringify(value) + "\n\n");
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model: "mock-chat",
    choices: [{ index: 0, message: { role: "assistant", content: "CHAT_OK" }, finish_reason: "stop" }],
  }));
});
await new Promise((resolve, reject) => {
  mock.once("error", reject);
  mock.listen({ path: nativeLocalPipeName(mockPort) }, resolve);
});
const configDirectory = join(home, ".openclaw");
mkdirSync(configDirectory, { recursive: true });
writeFileSync(join(configDirectory, "openclaw.json"), JSON.stringify({
  models: { mode: "merge", providers: { nemoclawNative: {
    baseUrl: "http://127.0.0.1:" + mockPort + "/v1",
    apiKey: "unused",
    api: "openai-completions",
    timeoutSeconds: 180,
    models: [{ id: "mock-chat", name: "mock-chat", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 4096 }],
  } } },
  agents: { defaults: { model: { primary: "nemoclawNative/mock-chat" }, timeoutSeconds: 180, skipBootstrap: true, thinkingDefault: "off" }, list: [{ id: "main", default: true }] },
}), "utf8");
const version = await run(["--version"], 30000);
const normalizedVersion = /\b2026\.9\.2\b/u.test(version.stdout) ? "2026.9.2" : version.stdout.trim();
const chat = await run(["agent", "--local", "--agent", "main", "--message", "Reply exactly: CHAT_OK", "--thinking", "off", "--timeout", "180", "--json"]);
let exactReply = false;
try {
  const document = JSON.parse(chat.stdout.trim());
  const payloads = document?.result?.payloads ?? document?.payloads;
  exactReply = document?.status !== "error" && Array.isArray(payloads) && payloads.length === 1 && payloads[0]?.text === "CHAT_OK";
} catch {}
const result = { executionMode: "embedded-worker", version: normalizedVersion, versionExitCode: version.exitCode, versionError: version.stderr.slice(-2000), chatExitCode: chat.exitCode, chatError: chat.stderr.slice(-2000), exactReply, reply: exactReply ? "CHAT_OK" : null };
writeFileSync(resultPath, JSON.stringify(result), "utf8");
await new Promise((resolve) => mock.close(resolve));
process.exit(version.exitCode === 0 && normalizedVersion === "2026.9.2" && chat.exitCode === 0 && exactReply ? 0 : 1);
`;
}

async function main(runtimeLease: NativeRuntimeSession) {
  if (process.platform !== "win32" || process.arch !== "arm64") {
    fail("native Windows ARM64 is required");
  }
  const installRoot = requiredDirectory(
    process.env.NEMOCLAW_NATIVE_INSTALL_ROOT ?? "",
    "NemoClaw installation root",
  );
  requiredFile(runtimeLease.node, "sealed Node.js runtime");
  const installedOpenClawRoot = requiredDirectory(
    runtimeLease.agentRoot ?? fail("sealed OpenClaw runtime is missing"),
    "sealed OpenClaw runtime",
  );
  requiredFile(path.join(installedOpenClawRoot, "openclaw-app.cjs"), "OpenClaw entrypoint");
  requiredFile(path.join(installRoot, "config", "mxc-gateway.toml"), "MXC gateway configuration");
  requiredFile(path.join(installRoot, "mxc", "wxc-exec.exe"), "MXC executor");

  const systemDrive = process.env.SystemDrive;
  if (!systemDrive || !/^[A-Za-z]:$/u.test(systemDrive)) fail("SystemDrive is invalid");
  const systemRoot = requiredDirectory(process.env.SystemRoot ?? "", "Windows system root");
  const comSpec = requiredFile(
    path.join(systemRoot, "System32", "cmd.exe"),
    "Windows command host",
  );
  const runId = randomBytes(5).toString("hex");
  const runRoot = path.join(`${systemDrive}\\`, `NemoClawNativeTurn-${runId}`);
  const shareRoot = path.join(`${systemDrive}\\`, `NemoClawNativeShare-${runId}`);
  const runtimeRoot = path.join(`${systemDrive}\\`, `NemoClawNativeArtifact-${runId}`);
  const artifactArgument = argumentValue("--artifact-directory");
  const evidenceRoot = path.resolve(
    artifactArgument ??
      (process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "NVIDIA", "NemoClaw", "evidence")
        : fail("an artifact directory is required when LOCALAPPDATA is unavailable")),
  );
  for (const root of [runRoot, shareRoot, runtimeRoot]) {
    const relative = path.relative(root, evidenceRoot);
    if (
      !relative ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))
    )
      fail("the artifact directory must be outside the qualification roots");
  }
  const receiptPath = path.join(evidenceRoot, `native-windows-turn-${runId}.json`);
  const sandboxName = `nc-${runId}`;
  const gatewayName = `nemoclaw-gateway-${runId}`;
  const gatewayLogPath = path.join(runRoot, "openshell-gateway.log");
  const gatewayErrorPath = path.join(runRoot, "openshell-gateway.err.log");
  const ownedRoots: string[] = [];
  const ownedLogs = new Set<number>();
  const gatewaySession = openInstalledRuntimeSession(installRoot, runRoot);
  let gateway: ChildProcess | undefined;
  let create: ChildProcess | null = null;
  let cliEnvironment: NodeJS.ProcessEnv | undefined;
  let passed = false;
  let sandboxAbsentFromRegistry = true;
  let sandboxDeletionRequested = false;
  let primaryFailed = false;
  let receipt: Record<string, unknown> | undefined;
  try {
    fs.mkdirSync(evidenceRoot, { recursive: true });
    for (const directory of [runRoot, shareRoot, runtimeRoot]) {
      if (fs.existsSync(directory)) fail("qualification roots already exist");
      fs.mkdirSync(directory);
      ownedRoots.push(directory);
    }
    const gatewayPort = await freePort();
    const mockPort = await freePort();
    const gatewayConfig = await writeNativeGatewayConfig(
      installRoot,
      runRoot,
      undefined,
      { network: { kind: "supervised" } },
      gatewaySession,
    );
    runtimeLease.assertHeld();
    console.log("NEMOCLAW> Selecting the sealed installed Node/OpenClaw runtime without copying");
    const openClawRoot = installedOpenClawRoot;
    const openClawEntry = requiredFile(
      path.join(openClawRoot, "openclaw-app.cjs"),
      "sealed OpenClaw entrypoint",
    );
    const home = path.join(shareRoot, "home");
    const temp = path.join(shareRoot, "temp");
    for (const directory of [home, temp]) fs.mkdirSync(directory, { recursive: true });
    const worker = nativeWorkerAssets(runtimeLease.runtimeRoot, "openclaw-turn");
    const probePath = requiredFile(worker.entry, "prebuilt OpenClaw worker");
    const resultPath = path.join(shareRoot, "result.json");
    const policyPath = path.join(runRoot, "policy.yaml");
    fs.writeFileSync(
      policyPath,
      [
        "version: 1",
        "",
        ...NATIVE_NODE_UI_POLICY,
        "filesystem_policy:",
        "  include_workdir: false",
        "  read_only:",
        `    - ${quoteYamlPath(runtimeRoot)}`,
        ...runtimeLease.readOnlyRoots.map((root) => `    - ${quoteYamlPath(root)}`),
        "  read_write:",
        `    - ${quoteYamlPath(shareRoot)}`,
        "",
      ].join("\n"),
      "utf8",
    );
    const gatewayLog = fs.openSync(gatewayLogPath, "w");
    ownedLogs.add(gatewayLog);
    const gatewayError = fs.openSync(gatewayErrorPath, "w");
    ownedLogs.add(gatewayError);
    await gatewaySession.prepare();
    const gatewayEnvironment = gatewaySession.gatewayEnvironment(gatewayConfig);
    gateway = gatewaySession.startGateway({
      port: gatewayPort,
      environment: gatewayEnvironment,
      stdio: ["ignore", gatewayLog, gatewayError],
      windowsHide: true,
      logLevel: "info",
      explicitMtlsValue: true,
    });
    const gatewayFailure = new Promise<never>((_, reject) => gateway!.once("error", reject));
    void gatewayFailure.catch(() => {});
    let result = null;
    cliEnvironment = gatewayEnvironment;
    let createWatcherDetached = false;
    console.log("NEMOCLAW> Starting installed OpenShell MXC gateway");
    await Promise.race([waitForPort(gatewayPort, gateway), gatewayFailure]);
    cliEnvironment = allowlistedWindowsEnvironment({
      ...gatewayEnvironment,
      OPENSHELL_GATEWAY: undefined,
    });
    await gatewaySession.registerGateway(
      gatewayPort,
      gatewayName,
      cliEnvironment,
      ["Registering qualification gateway", "Selecting qualification gateway"],
      undefined,
    );
    const sandboxEnvironment = {
      ...worker.environment,
      COMSPEC: comSpec,
      LOCALAPPDATA: home,
      NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS ?? "1",
      NEMOCLAW_MXC_OPENCLAW_ENTRY: openClawEntry,
      OPENCLAW_COMPILED_ASSET_ROOT: openClawRoot,
      NEMOCLAW_MXC_HOME: home,
      NEMOCLAW_MXC_RESULT: resultPath,
      NEMOCLAW_MXC_MOCK_PORT: String(mockPort),
      OS: "Windows_NT",
      PATH: `${path.join(systemRoot, "System32")};${systemRoot}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PROCESSOR_ARCHITECTURE: "ARM64",
      SYSTEMDRIVE: systemDrive,
      SYSTEMROOT: systemRoot,
      TEMP: temp,
      TMP: temp,
      USERPROFILE: home,
      WINDIR: systemRoot,
    };
    const workloadRequest = {
      name: sandboxName,
      policy: policyPath,
      command: nativeRuntimeWorkerCommand(runtimeLease, probePath),
      directory: shareRoot,
      ports: undefined,
      terminal: false,
      environment: sandboxEnvironment,
    };
    console.log("NEMOCLAW> Creating native MXC OpenClaw sandbox");
    const createFailure: { error: Error | null } = { error: null };
    create = gatewaySession.startWorkload(workloadRequest, cliEnvironment, "ignore");
    sandboxAbsentFromRegistry = false;
    create.once("error", (error) => {
      createFailure.error = error;
    });
    console.log("NEMOCLAW> Waiting for the installed OpenClaw agent turn");
    await Promise.race([
      waitForNativeTurnResult(resultPath, create, gateway, createFailure),
      runtimeLease.failure,
      gatewayFailure,
    ]);
    runtimeLease.assertHeld();
    createWatcherDetached = create.exitCode === null;
    if (!(await stopChild(create))) fail("OpenShell sandbox request watcher did not stop");
    result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const turnPassed =
      result.executionMode === "embedded-worker" &&
      result.version === "2026.9.2" &&
      result.versionExitCode === 0 &&
      result.chatExitCode === 0 &&
      result.exactReply === true &&
      result.reply === "CHAT_OK";
    if (!turnPassed) {
      const failedProbe = sanitizedDiagnostic(JSON.stringify(result), [
        [installRoot, "<install-root>"],
        [runtimeRoot, "<runtime-root>"],
        [shareRoot, "<share-root>"],
        [runRoot, "<run-root>"],
      ]);
      console.error(`NEMOCLAW> Failed sandbox probe result ${failedProbe}`);
      fail("installed OpenClaw turn result was not exact");
    }
    const completion = await gatewaySession.waitForCompletion(
      cliEnvironment,
      sandboxName,
      gateway,
      runtimeLease,
      undefined,
    );
    if (completion === "ExecFailed" || completion === "MainProcessFailed")
      fail("OpenShell reported failed MXC workload termination");
    console.log("AGENT> CHAT_OK");
    sandboxDeletionRequested = true;
    await gatewaySession.deleteWorkload(
      sandboxName,
      cliEnvironment,
      "Deleting native MXC sandbox",
      undefined,
      undefined,
    );
    await gatewaySession.confirmRegistryEmpty(cliEnvironment, {
      sandboxName,
      gateway,
      stateSession: runtimeLease,
    });
    sandboxAbsentFromRegistry = true;
    if (!(await gatewaySession.stopGateway())) fail("OpenShell MXC gateway did not stop");
    await gatewaySession.dispose();
    fs.closeSync(gatewayLog);
    ownedLogs.delete(gatewayLog);
    fs.closeSync(gatewayError);
    ownedLogs.delete(gatewayError);
    for (const directory of ownedRoots) {
      if (!(await removeDirectory(directory)))
        fail(`qualification root remained after cleanup: ${path.basename(directory)}`);
    }
    receipt = {
      schemaVersion: 1,
      classification: "installed-nemoclaw-native-windows-turn",
      architecture: "arm64",
      backend: "process_container",
      openClawExecutionMode: result.executionMode,
      openShellCreateWatcherDetached: createWatcherDetached,
      createWatcherStopped: true,
      workloadStopped: true,
      gatewayStopped: true,
      artifactStagedAtDriveRoot: false,
      runtimeBytesCopied: 0,
      runtimeId: runtimeLease.runtimeId,
      manifestSha256: runtimeLease.manifestSha256,
      openClawVersion: result.version,
      exactReply: result.reply,
      sandboxDeleted: true,
      sandboxRegistryAbsent: true,
      qualificationRootsRemoved: true,
      verdict: "pass",
    };
    passed = true;
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    let requestStopped = false;
    let gatewayCleanupConfirmed = false;
    const failures = await attemptNativeUiCleanup([
      [
        "sandbox request stop",
        async () => {
          requestStopped = !create?.pid || (await stopChild(create));
          if (!requestStopped) throw new Error();
        },
      ],
      [
        "sandbox removal",
        async () => {
          if (!sandboxAbsentFromRegistry && !sandboxDeletionRequested && create && cliEnvironment) {
            sandboxDeletionRequested = true;
            await gatewaySession.deleteWorkload(
              sandboxName,
              cliEnvironment,
              "Failure cleanup sandbox delete",
              30_000,
              undefined,
            );
          }
        },
      ],
      [
        "sandbox registry verification",
        async () => {
          if (!sandboxAbsentFromRegistry && create && cliEnvironment) {
            await gatewaySession.confirmRegistryEmpty(cliEnvironment, {
              sandboxName,
              gateway,
              stateSession: runtimeLease,
            });
            sandboxAbsentFromRegistry = true;
          }
        },
      ],
      [
        "gateway stop",
        async () => {
          if (gateway?.pid && !(await gatewaySession.stopGateway())) throw new Error();
        },
      ],
      [
        "private gateway cleanup",
        async () => {
          await gatewaySession.dispose();
          gatewayCleanupConfirmed = true;
        },
      ],
      ...[...ownedLogs].map(
        (descriptor) =>
          [
            "gateway log close",
            () => {
              fs.closeSync(descriptor);
              ownedLogs.delete(descriptor);
            },
          ] as const,
      ),
      [
        "failure diagnostic",
        () => {
          if (passed || !ownedRoots.includes(runRoot)) return;
          const diagnosticParts = [gatewayLogPath, gatewayErrorPath]
            .map((file) =>
              readOpenedRegularFile(file, { encoding: "utf8", maxBytes: 2 * 1024 * 1024 }),
            )
            .filter((text): text is string => text !== null);
          if (diagnosticParts.length > 0) {
            const diagnostic = sanitizedDiagnostic(diagnosticParts.join("\n"), [
              [installRoot, "<install-root>"],
              [runtimeRoot, "<runtime-root>"],
              [shareRoot, "<share-root>"],
              [runRoot, "<run-root>"],
            ]);
            const diagnosticPath = path.join(
              evidenceRoot,
              `native-windows-turn-diagnostic-${runId}.log`,
            );
            fs.writeFileSync(diagnosticPath, diagnostic, "utf8");
            console.error(`NEMOCLAW> Sanitized MXC diagnostic\n${diagnostic}`);
          }
        },
      ],
      ...ownedRoots.map(
        (directory) =>
          [
            "temporary root removal: " + path.basename(directory),
            async () => {
              if (!requestStopped || !gatewayCleanupConfirmed || !sandboxAbsentFromRegistry)
                throw new Error();
              if (!(await removeDirectory(directory))) throw new Error();
            },
          ] as const,
      ),
    ]);
    if (!passed || failures.length) {
      try {
        fs.writeFileSync(
          receiptPath,
          JSON.stringify(
            {
              schemaVersion: 1,
              classification: "installed-nemoclaw-native-windows-turn",
              verdict: "fail",
              sandboxName,
              sandboxAbsentFromRegistry,
              cleanupFailures: failures,
              ownedQualificationRootsRemoved:
                ownedRoots.every((directory) => !fs.existsSync(directory)) &&
                !fs.existsSync(gatewaySession.root),
              privateGatewayStateRemoved: !fs.existsSync(gatewaySession.root),
              retainedPrivateGatewayRoot: fs.existsSync(gatewaySession.root)
                ? gatewaySession.root
                : null,
              retainedQualificationRoots: ownedRoots.filter((directory) =>
                fs.existsSync(directory),
              ),
            },
            null,
            2,
          ) + "\n",
          "utf8",
        );
      } catch {
        failures.push("failure receipt write");
      }
    }
    if (failures.length) {
      console.error(`NEMOCLAW> Cleanup also failed: ${failures.join(", ")}`);
      if (!primaryFailed) fail(`cleanup failed: ${failures.join(", ")}`);
    }
  }
  if (!passed || !receipt) fail("the turn qualification receipt is missing");
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  console.log(`NEMOCLAW> PASS receipt=${receiptPath}`);
}

export { main as qualifyNativeOpenClawTurn };

async function runLeasedNativeTurn() {
  const installRoot = requiredDirectory(
    process.env.NEMOCLAW_NATIVE_INSTALL_ROOT ?? "",
    "NemoClaw installation root",
  );
  const launcher = requiredFile(path.join(installRoot, "bin", "NemoClaw.exe"), "NemoClaw launcher");
  return await withNativeRuntimeSession(launcher, installRoot, "openclaw", main);
}

export async function runNativeTurnEntry() {
  await runLeasedNativeTurn().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Native Windows turn qualification failed.",
    );
    process.exitCode = 1;
  });
}

if (
  typeof NEMOCLAW_BUNDLED_RUNTIME === "undefined" &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === nativeEntryFile(import.meta.url)
) {
  void runNativeTurnEntry();
}
