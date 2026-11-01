// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath as nativeEntryFile } from "node:url";
declare const NEMOCLAW_BUNDLED_RUNTIME: boolean | undefined;
import { nativeWorkerAssets } from "./native-assets.mts";
import { hermesInferencePipePythonSource } from "./native-hermes-inference-pipe.mts";
import { hermesPipeLoopPythonSource } from "./native-hermes-pipe-loop.mts";
import { openInstalledRuntimeSession } from "./installed-runtime-provider.mts";
import { createPrivateShareRoot } from "./native-private-share.mts";
import {
  withNativeRuntimeSession,
  nativeHermesToolEnvironment,
  nativeHermesCompatibility,
  nativeRuntimeWorkerCommand,
  type NativeRuntimeSession,
} from "./native-runtime.mts";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  NATIVE_NODE_UI_POLICY,
  readOpenedRegularFile,
  writeNativeGatewayConfig,
} from "./native-security.mts";
import { attemptNativeUiCleanup } from "./native-ui-lifecycle.mts";

import {
  allowlistedWindowsEnvironment,
  argumentValue,
  freePort,
  quoteYamlPath,
  removeDirectory,
  requiredDirectory,
  requiredFile,
  sanitizedDiagnostic,
  stopChild,
  waitForPort,
} from "./run-installed-native-turn.mts";

const HERMES_TURN_PROOFS = [
  ["Reply exactly with NATIVE_HERMES_TURN_1_OK", "NATIVE_HERMES_TURN_1_OK"],
  ["Reply exactly with NATIVE_HERMES_TURN_2_OK", "NATIVE_HERMES_TURN_2_OK"],
  ["Reply exactly with NATIVE_HERMES_TURN_3_OK", "NATIVE_HERMES_TURN_3_OK"],
];

function fail(message): never {
  throw new Error(`Native Windows terminal-agent qualification failed: ${message}`);
}

async function waitForTerminalAgentResult(
  resultPath,
  finalToken,
  create,
  gateway,
  createFailure,
  agentLabel,
  timeout = 360_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (createFailure.error !== null) throw createFailure.error;
    if (create.signalCode !== null || (create.exitCode !== null && create.exitCode !== 0))
      fail(
        `OpenShell request exited ${create.exitCode ?? create.signalCode ?? "unknown"} before ${agentLabel} finished`,
      );
    if (gateway.exitCode !== null || gateway.signalCode !== null)
      fail(`The native gateway stopped before ${agentLabel} completed`);
    const result = readOpenedRegularFile(resultPath, {
      encoding: "utf8",
      maxBytes: 1024 * 1024,
    });
    if (result !== null && result.includes(finalToken) && result.endsWith("\n")) return result;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))),
    );
  }
  fail(`${agentLabel} did not publish its bounded result receipt before the deadline`);
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export { createPrivateShareRoot } from "./native-private-share.mts";

export function hermesWorkloadSource() {
  return String.raw`import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { nativeLocalPipeName } from "./native-local-pipe.mts";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};
const home = required("NEMOCLAW_HERMES_HOME_ROOT");
const hermesHome = join(home, ".hermes");
const python = required("NEMOCLAW_HERMES_PYTHON");
const modelPort = Number(required("NEMOCLAW_HERMES_MODEL_PORT"));
if (required("NEMOCLAW_HERMES_INFERENCE_PIPE_PORT") !== String(modelPort))
  throw new Error("The Hermes qualification inference pipe declaration does not match.");
const resultPath = required("NEMOCLAW_HERMES_RESULT");
const turnProofs = [
  ["Reply exactly with NATIVE_HERMES_TURN_1_OK", "NATIVE_HERMES_TURN_1_OK"],
  ["Reply exactly with NATIVE_HERMES_TURN_2_OK", "NATIVE_HERMES_TURN_2_OK"],
  ["Reply exactly with NATIVE_HERMES_TURN_3_OK", "NATIVE_HERMES_TURN_3_OK"],
];
const bodyText = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};
const messageText = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part?.text ?? "").join(" ");
};
const model = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "native-preview", object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  const body = JSON.parse(await bodyText(request));
  const prompt = (body.messages ?? []).map((entry) => messageText(entry?.content)).join("\n");
  const expected = turnProofs.find(([, token]) => prompt.includes(token))?.[1] ?? "NATIVE_HERMES_OK";
  const id = "chatcmpl-nemoclaw-native-hermes";
  const created = Math.floor(Date.now() / 1000);
  if (body.stream === true) {
    response.writeHead(200, { "cache-control": "no-cache", connection: "keep-alive", "content-type": "text/event-stream" });
    for (const chunk of [
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: { content: expected }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]) response.write("data: " + JSON.stringify(chunk) + "\n\n");
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model: "native-preview",
    choices: [{ index: 0, message: { role: "assistant", content: expected }, finish_reason: "stop" }],
  }));
});
await new Promise((resolve, reject) => {
  model.once("error", reject);
  model.listen(nativeLocalPipeName(modelPort), resolve);
});
mkdirSync(hermesHome, { recursive: true });
writeFileSync(join(hermesHome, "config.yaml"), [
  "model:",
  "  default: native-preview",
  "  provider: custom",
  "  base_url: http://127.0.0.1:" + modelPort + "/v1",
  "  api_key: sk-native-qualification",
  "  context_length: 131072",
  "agent:",
  "  max_turns: 3",
  "memory:",
  "  memory_enabled: false",
  "  user_profile_enabled: false",
  "display:",
  "  compact: true",
  "  show_reasoning: false",
  "security:",
  "  allow_lazy_installs: false",
  "updates:",
  "  check: false",
  "  pre_update_backup: false",
  "  refresh_cua_driver: false",
  "",
].join("\n"), "utf8");
writeFileSync(join(hermesHome, ".env"), "\n", "utf8");
const runner = join(home, "run-hermes.py");
writeFileSync(runner, [
  "import os",
  "import sys",
  "from io import BytesIO",
  "from PIL import Image, ImageShow",
  "from python_multipart.multipart import parse_form, parse_options_header",
  "if len(Image.new('RGB', (2, 2)).tobytes()) != 12:",
  "    raise RuntimeError('Native Pillow image operation failed')",
  "try:",
  "    ImageShow.WindowsViewer().get_command(chr(34))",
  "except ValueError:",
  "    pass",
  "else:",
  "    raise RuntimeError('Pillow accepted an invalid Windows filename')",
  "try:",
  "    parse_form({'Content-Type': b'application/octet-stream', 'Content-Length': b'-1'}, BytesIO(b'bounded'), lambda _: None, lambda _: None)",
  "except ValueError as error:",
  "    if 'Content-Length must be non-negative' not in str(error):",
  "        raise",
  "else:",
  "    raise RuntimeError('Multipart accepted a negative content length')",
  "header = b'form-data; name=plain; name*=utf-8' + bytes([39, 39]) + b'other'",
  "if parse_options_header(header)[1] != {b'name': b'plain'}:",
  "    raise RuntimeError('Multipart accepted an extended parameter override')",
  "from hermes_cli import __version__ as _hermes_version",
  "if _hermes_version != '0.21.1': raise RuntimeError('The official Hermes runtime version does not match its installation')",
  ...${JSON.stringify(hermesPipeLoopPythonSource())},
  ...${JSON.stringify(hermesInferencePipePythonSource())},
  "from hermes_cli.main import main",
  "main()",
  "",
].join("\n"), "utf8");

const execute = (prompt) => new Promise((resolve, reject) => {
  const child = spawn(python, [
    runner,
    "--oneshot", prompt,
    "--provider", "custom",
    "--model", "native-preview",
  ], {
    cwd: home,
    env: {
      ...process.env,
      HERMES_HOME: hermesHome,
      HERMES_DISABLE_LAZY_INSTALLS: "1",
      HERMES_NODE: required("HERMES_NODE"),
      HERMES_PYTHON: python,
      HERMES_SKIP_NODE_BOOTSTRAP: "1",
      HOME: home,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONPATH: required("NEMOCLAW_WORKER_ROOT"),
      PYTHONUTF8: "1",
      USERPROFILE: home,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    process.stderr.write(chunk);
  });
  child.once("error", reject);
  child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error("Hermes exited " + code + ": " + stderr)));
});

const turns = [];
try {
  for (let index = 0; index < turnProofs.length; index += 1) {
    const [prompt, expected] = turnProofs[index];
    console.log("HERMES> TURN " + (index + 1) + " running through the real Hermes CLI");
    const result = await execute(prompt);
    const output = result.stdout.trim();
    if (!output.includes(expected)) throw new Error("Hermes output did not contain exact token " + expected);
    console.log("HERMES> TURN " + (index + 1) + " PASS " + expected);
    turns.push({ prompt, expected, output });
  }
  writeFileSync(resultPath, JSON.stringify({
    schemaVersion: 1,
    classification: "native-windows-hermes-agent-result",
    hermesVersion: "0.21.1",
    nativePythonSecurityChecksPassed: true,
    turnCount: turns.length,
    turns,
    verdict: "pass",
  }, null, 2) + "\n", "utf8");
} finally {
  await new Promise((resolve) => model.close(() => resolve()));
}
`;
}

async function mainInternal(runtimeLease: NativeRuntimeSession) {
  if (process.platform !== "win32" || process.arch !== "arm64")
    fail("native Windows ARM64 is required");
  if (!process.argv.includes("--qualification"))
    fail("the current terminal-agent entrypoint requires a completed graphical configuration");
  const agentId = argumentValue("--agent") ?? "hermes";
  if (agentId !== "hermes") fail("unsupported terminal agent");
  const agentLabel = "Hermes";
  const sandboxPrefix = "nc-h";
  const agentVersion = "0.21.1";
  const turnProofs = HERMES_TURN_PROOFS;
  const finalToken = turnProofs[2][1];

  const installRoot = requiredDirectory(
    process.env.NEMOCLAW_NATIVE_INSTALL_ROOT ?? "",
    "NemoClaw installation root",
  );
  requiredFile(runtimeLease.node, "sealed Node.js runtime");
  const installedAgentRoot = requiredDirectory(runtimeLease.agentRoot, `${agentLabel} runtime`);
  const installedPythonRoot = requiredDirectory(
    path.dirname(runtimeLease.python!),
    "sealed Python directory",
  );
  const installedAgentEntrypoint = requiredFile(
    path.join(installedAgentRoot, "hermes-agent", "hermes_cli", "main.py"),
    "Hermes installed entrypoint",
  );
  requiredFile(path.join(installRoot, "config", "mxc-gateway.toml"), "MXC gateway configuration");
  requiredFile(path.join(installRoot, "mxc", "wxc-exec.exe"), "MXC executor");

  const systemDrive = process.env.SystemDrive;
  if (!systemDrive || !/^[A-Za-z]:$/u.test(systemDrive)) fail("SystemDrive is invalid");
  const systemRoot = requiredDirectory(process.env.SystemRoot ?? "", "Windows system root");
  const hermesTools = nativeHermesToolEnvironment(runtimeLease, systemRoot);
  const hermesCompatibility = nativeHermesCompatibility(runtimeLease);
  if (hermesTools) {
    for (const [tool, executable] of Object.entries({
      Python: hermesTools.python,
      Bash: hermesTools.bash,
      Node: hermesTools.node,
      ripgrep: hermesTools.ripgrep,
      compatibilityLauncher: hermesCompatibility!.launcher,
      compatibilityArm64Dll: hermesCompatibility!.arm64Dll,
      compatibilityX64Dll: hermesCompatibility!.x64Dll,
      compatibilityExecutor: hermesCompatibility!.executor,
    }))
      requiredFile(executable, `sealed Hermes ${tool}`);
  }
  const runId = randomBytes(5).toString("hex");
  const runRoot = path.join(`${systemDrive}\\`, `NemoClawNativeAgent-${agentId}-${runId}`);
  const shareRoot = path.join(`${systemDrive}\\`, `NemoClawNativeAgentShare-${agentId}-${runId}`);
  const runtimeRoot = path.join(
    `${systemDrive}\\`,
    `NemoClawNativeAgentRuntime-${agentId}-${runId}`,
  );
  const artifactArgument = argumentValue("--artifact-directory");
  const evidenceRoot = path.resolve(
    artifactArgument ??
      (process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "NVIDIA", "NemoClaw", "evidence", agentId)
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
  const receiptPath = path.join(evidenceRoot, `native-windows-${agentId}-${runId}.json`);
  const sandboxName = `${sandboxPrefix}-${runId}`;
  const gatewayName = `nemoclaw-${agentId}-${runId}`;
  const gatewayLogPath = path.join(runRoot, "openshell-gateway.log");
  const gatewayErrorPath = path.join(runRoot, "openshell-gateway.err.log");
  const ownedRoots: string[] = [];
  const ownedLogs = new Set<number>();
  const gatewaySession = openInstalledRuntimeSession(installRoot, runRoot);
  let gateway: ChildProcess | undefined;
  let shareCreator: ChildProcess | undefined;
  let shareCreatorStopped = true;
  let create: ChildProcess | null = null;
  let cliEnvironment: NodeJS.ProcessEnv | undefined;
  let createOutput = "";
  let createError = "";
  let passed = false;
  let sandboxAbsentFromRegistry = true;
  let sandboxDeletionRequested = false;
  let primaryFailed = false;
  let receipt: Record<string, unknown> | undefined;
  try {
    fs.mkdirSync(evidenceRoot, { recursive: true });
    for (const directory of [runRoot, runtimeRoot]) {
      if (fs.existsSync(directory)) fail("qualification root already exists");
      fs.mkdirSync(directory);
      ownedRoots.push(directory);
    }
    if (fs.existsSync(shareRoot)) fail("qualification root already exists");
    const gatewayConfig = await writeNativeGatewayConfig(
      installRoot,
      runRoot,
      runtimeLease,
      { network: { kind: "supervised" } },
      gatewaySession,
    );
    // MXC adds its container-specific grant from filesystem_policy after this host boundary is set.
    const privateShareAcl = await createPrivateShareRoot(
      shareRoot,
      systemRoot,
      (child) => {
        shareCreator = child;
        shareCreatorStopped = false;
      },
      () => ownedRoots.push(shareRoot),
    );
    runtimeLease.assertHeld();
    const agentEnvironment = {
      NEMOCLAW_HERMES_HOME_ROOT: path.join(shareRoot, "home"),
      NEMOCLAW_HERMES_MODEL_PORT: "",
      NEMOCLAW_HERMES_INFERENCE_PIPE_PORT: "",
      NEMOCLAW_HERMES_PYTHON: requiredFile(runtimeLease.python, "staged Python runtime"),
      NEMOCLAW_HERMES_RESULT: path.join(shareRoot, "hermes-result.json"),
    };
    const worker = nativeWorkerAssets(runtimeLease.runtimeRoot, "hermes-turn");
    const workload = requiredFile(worker.entry, "prebuilt terminal qualification worker");
    const resultPath = agentEnvironment.NEMOCLAW_HERMES_RESULT;
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
    const home = path.join(shareRoot, "home");
    const temp = path.join(shareRoot, "temp");
    for (const directory of [home, temp]) fs.mkdirSync(directory, { recursive: true });
    const openShellPort = await freePort();
    const modelPort = await freePort();
    agentEnvironment.NEMOCLAW_HERMES_MODEL_PORT = String(modelPort);
    agentEnvironment.NEMOCLAW_HERMES_INFERENCE_PIPE_PORT = String(modelPort);
    const gatewayLog = fs.openSync(gatewayLogPath, "w");
    ownedLogs.add(gatewayLog);
    const gatewayError = fs.openSync(gatewayErrorPath, "w");
    ownedLogs.add(gatewayError);
    await gatewaySession.prepare();
    const gatewayEnvironment = gatewaySession.gatewayEnvironment(gatewayConfig);
    gateway = gatewaySession.startGateway({
      port: openShellPort,
      environment: gatewayEnvironment,
      stdio: ["ignore", gatewayLog, gatewayError],
      windowsHide: true,
      logLevel: "info",
      explicitMtlsValue: false,
    });
    const gatewayFailure = new Promise<never>((_, reject) => gateway!.once("error", reject));
    void gatewayFailure.catch(() => {});
    cliEnvironment = gatewayEnvironment;
    console.log(`${agentLabel.toUpperCase()}> Starting the installed OpenShell MXC gateway`);
    await Promise.race([waitForPort(openShellPort, gateway), gatewayFailure, runtimeLease.failure]);
    cliEnvironment = allowlistedWindowsEnvironment({
      ...gatewayEnvironment,
      OPENSHELL_GATEWAY: undefined,
    });
    await gatewaySession.registerGateway(
      openShellPort,
      gatewayName,
      cliEnvironment,
      [
        `Registering the native ${agentLabel} gateway`,
        `Selecting the native ${agentLabel} gateway`,
      ],
      undefined,
    );
    const sandboxEnvironment = {
      ...worker.environment,
      HOME: home,
      LOCALAPPDATA: home,
      ...agentEnvironment,
      NODE_DISABLE_COMPILE_CACHE: "1",
      NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS ?? "1",
      OS: "Windows_NT",
      ...(hermesTools
        ? hermesTools.environment
        : {
            PATH: `${path.join(systemRoot, "System32")};${systemRoot}`,
          }),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PROCESSOR_ARCHITECTURE: "ARM64",
      SYSTEMDRIVE: systemDrive,
      SYSTEMROOT: systemRoot,
      TEMP: temp,
      TMP: temp,
      USERPROFILE: home,
      WINDIR: systemRoot,
    };
    const workloadCommand = nativeRuntimeWorkerCommand(runtimeLease, workload);
    const workloadRequest = {
      name: sandboxName,
      policy: policyPath,
      command: workloadCommand,
      directory: shareRoot,
      ports: [modelPort],
      terminal: false,
      environment: sandboxEnvironment,
    };
    console.log(
      `${agentLabel.toUpperCase()}> Launching the real ${agentLabel} runtime inside native MXC`,
    );
    create = gatewaySession.startWorkload(workloadRequest, cliEnvironment, [
      "ignore",
      "pipe",
      "pipe",
    ]);
    sandboxAbsentFromRegistry = false;
    create.stdout!.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      createOutput = `${createOutput}${text}`.slice(-128 * 1024);
      process.stdout.write(text);
    });
    create.stderr!.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      createError = `${createError}${text}`.slice(-128 * 1024);
      process.stderr.write(text);
    });
    const createFailure = { error: null };
    create.once("error", (error) => {
      createFailure.error = error;
    });
    const agentResultText = await Promise.race([
      waitForTerminalAgentResult(
        resultPath,
        finalToken,
        create,
        gateway,
        createFailure,
        agentLabel,
      ),
      runtimeLease.failure,
      gatewayFailure,
    ]);
    runtimeLease.assertHeld();
    const agentResult = JSON.parse(agentResultText);
    const reportedVersion = agentResult.hermesVersion;
    if (
      agentResult.verdict !== "pass" ||
      reportedVersion !== agentVersion ||
      agentResult.nativePythonSecurityChecksPassed !== true ||
      agentResult.turnCount !== 3 ||
      !turnProofs.every(([, expected], index) => agentResult.turns?.[index]?.expected === expected)
    )
      fail(`${agentLabel} result receipt is incomplete`);
    const completion = await gatewaySession.waitForCompletion(
      cliEnvironment,
      sandboxName,
      gateway,
      runtimeLease,
      undefined,
    );
    if (completion === "ExecFailed" || completion === "MainProcessFailed")
      fail(`The native ${agentLabel} execution failed`);
    sandboxDeletionRequested = true;
    await gatewaySession.deleteWorkload(
      sandboxName,
      cliEnvironment,
      `Deleting the native ${agentLabel} sandbox`,
      undefined,
      undefined,
    );
    if (create !== null && !(await stopChild(create)))
      fail(`${agentLabel} sandbox request watcher did not stop`);
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
        fail(`runtime root remained: ${path.basename(directory)}`);
    }
    receipt = {
      ...agentResult,
      classification: `installed-nemoclaw-native-windows-${agentId}`,
      architecture: "arm64",
      backend: "process_container",
      interface: `${agentLabel} terminal one-shot mode`,
      runtimeEntrypointSha256: sha256(installedAgentEntrypoint),
      runtimeHostSha256: sha256(
        requiredFile(path.join(installedPythonRoot, "python.exe"), "installed Python runtime"),
      ),
      deterministicLocalModel: true,
      privateShareAcl,
      createWatcherStopped: true,
      sandboxDeleted: true,
      sandboxRegistryAbsent: true,
      gatewayStopped: true,
      qualificationRootsRemoved: true,
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
        "private share creator stop",
        async () => {
          shareCreatorStopped = !shareCreator?.pid || (await stopChild(shareCreator));
          if (!shareCreatorStopped) throw new Error();
        },
      ],
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
              `Failure cleanup native ${agentLabel} sandbox`,
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
          if (passed) return;
          const diagnosticParts = [createOutput, createError];
          for (const file of ownedRoots.includes(runRoot)
            ? [gatewayLogPath, gatewayErrorPath]
            : []) {
            const content = readOpenedRegularFile(file, {
              encoding: "utf8",
              maxBytes: 2 * 1024 * 1024,
            });
            if (content !== null) diagnosticParts.push(content);
          }
          const diagnostic = sanitizedDiagnostic(diagnosticParts.filter(Boolean).join("\n"), [
            [installRoot, "<install-root>"],
            [runtimeRoot, "<runtime-root>"],
            [shareRoot, "<share-root>"],
            [runRoot, "<run-root>"],
          ]);
          if (diagnostic) {
            fs.writeFileSync(
              path.join(evidenceRoot, `native-windows-${agentId}-diagnostic-${runId}.log`),
              diagnostic,
              "utf8",
            );
            console.error(
              `${agentLabel.toUpperCase()}> Sanitized failure diagnostic\n${diagnostic}`,
            );
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
              if (directory === shareRoot && !shareCreatorStopped) throw new Error();
              if (!(await removeDirectory(directory))) throw new Error();
            },
          ] as const,
      ),
      [
        "private share ownership verification",
        () => {
          if (!ownedRoots.includes(shareRoot) && fs.existsSync(shareRoot)) throw new Error();
        },
      ],
    ]);
    if (!passed || failures.length) {
      try {
        fs.writeFileSync(
          receiptPath,
          JSON.stringify(
            {
              schemaVersion: 1,
              classification: `installed-nemoclaw-native-windows-${agentId}`,
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
              unconfirmedShareRoot:
                !ownedRoots.includes(shareRoot) && fs.existsSync(shareRoot) ? shareRoot : null,
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
      console.error(`${agentLabel.toUpperCase()}> Cleanup also failed: ${failures.join(", ")}`);
      if (!primaryFailed) fail(`cleanup failed: ${failures.join(", ")}`);
    }
  }
  if (!passed || !receipt) fail("the terminal-agent qualification receipt is missing");
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  console.log(
    `${agentLabel.toUpperCase()}> PASS three real ${agentLabel} agent turns inside native MXC`,
  );
}

export { mainInternal as qualifyNativeTerminalAgent };

async function main() {
  const installRoot = requiredDirectory(
    process.env.NEMOCLAW_NATIVE_INSTALL_ROOT ?? "",
    "NemoClaw installation root",
  );
  const launcher = requiredFile(path.join(installRoot, "bin", "NemoClaw.exe"), "NemoClaw launcher");
  const purpose = argumentValue("--agent") ?? "hermes";
  if (purpose !== "hermes") fail("unsupported native runtime purpose");
  return await withNativeRuntimeSession(
    launcher,
    installRoot,
    purpose as NativeRuntimeSession["purpose"],
    mainInternal,
  );
}

export async function runNativeTerminalTurnEntry() {
  await main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Native Windows terminal-agent qualification failed.",
    );
    process.exitCode = 1;
  });
}

if (
  typeof NEMOCLAW_BUNDLED_RUNTIME === "undefined" &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === nativeEntryFile(import.meta.url)
) {
  void runNativeTerminalTurnEntry();
}
