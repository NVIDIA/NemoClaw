// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  measuredCommand,
  identity as fileIdentity,
  stopOwned as stopOwnedChild,
  readFixtureRecord,
} from "./measurement.mts";
const errorDetail = (error: unknown) => ({
  message: error instanceof Error ? error.message : String(error),
});
const command = (
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
) => measuredCommand({ executable, args, environment, cwd, timeoutMs });

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? null : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path.`);
  return path.resolve(value);
}

export function probeSandboxName(nonce: string) {
  if (!/^[a-f0-9]{24}$/u.test(nonce)) throw new Error("The owned probe nonce is invalid.");
  return `ro-${nonce.slice(0, 12)}`;
}

async function main(): Promise<void> {
  if (
    process.platform !== "win32" ||
    process.arch !== "arm64" ||
    process.env.GITHUB_ACTIONS !== "true"
  )
    throw new Error("This installed read-only feasibility probe requires Windows ARM64.");
  const installRoot = fs.realpathSync(argument("--install-root"));
  const sourceIndex = process.argv.indexOf("--source-revision");
  const sourceRevision = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : "";
  if (!/^[a-f0-9]{40}$/u.test(sourceRevision ?? ""))
    throw new Error("The verified installed source revision is required.");
  const runtimeRoot = installRoot;
  const evidenceRoot = argument("--artifact-directory");
  const programFiles = process.env.ProgramFiles;
  if (
    !programFiles ||
    installRoot.toLowerCase() !==
      fs.realpathSync(path.join(programFiles, "NVIDIA", "NemoClaw")).toLowerCase()
  )
    throw new Error("The read-only probe must use the installed Program Files runtime.");
  if (fs.existsSync(evidenceRoot)) throw new Error("The probe evidence directory must be fresh.");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const helpers = await import(
    pathToFileURL(path.join(installRoot, "qualification", "run-installed-native-turn.mts")).href
  );
  const security = await import(
    pathToFileURL(path.join(installRoot, "qualification", "native-security.mts")).href
  );
  const lifecycle = await import(
    pathToFileURL(path.join(installRoot, "qualification", "native-ui-lifecycle.mts")).href
  );
  const nonce = randomBytes(12).toString("hex");
  const id = nonce.slice(0, 12);
  const drive = process.env.SystemDrive;
  const systemRoot = process.env.SystemRoot;
  if (!drive || !/^[A-Za-z]:$/u.test(drive) || !systemRoot)
    throw new Error("Windows system roots are missing.");
  const runRoot = path.join(`${drive}\\`, `NemoClawReadOnlyRun-${id}`);
  const shareRoot = path.join(`${drive}\\`, `NemoClawReadOnlyShare-${id}`);
  const ownedRoots = [runRoot, shareRoot];
  for (const root of ownedRoots) {
    if (fs.existsSync(root)) throw new Error("A component probe root already exists.");
  }
  const createdRoots: string[] = [];
  const openshell = path.join(installRoot, "bin", "openshell.exe");
  const gatewayExecutable = path.join(installRoot, "bin", "openshell-gateway.exe");
  const node = path.join(installRoot, "bin", "node.exe");
  const worker = path.join(runRoot, "readonly-workload.mts");
  const resultPath = path.join(shareRoot, "result.json");
  const sandboxName = probeSandboxName(nonce);
  const gatewayName = `readonly-gateway-${id}`;
  const cleanup = {
    sandboxDeleted: false,
    sandboxRegistryAbsent: false,
    createWatcherStopped: true,
    workloadStopped: false,
    gatewayStopped: true,
    ownedRootsRemoved: false,
  };
  const receipt: Record<string, unknown> = {
    schemaVersion: 1,
    sourceRevision,
    sourceBinding: "caller-verified installer identity plus recorded installed executable hashes",
    classification: "installed-programfiles-readonly-mxc-feasibility",
    runtimeTreeCopies: 0,
    runtimeBytesCopied: 0,
    runtimeReadOnlyRoots: [node, path.join(installRoot, "openclaw")],
    instrumentation:
      "feasibility only; Node compile cache disabled, isolated fixture HOME, no runtime copies",
    performanceComparison: false,
    completeRuntime: false,
    installedAcceptance: false,
    fullAgentTurnTested: false,
    backend: "process_container",
    architecture: process.arch,
    baselineInstallRoot: installRoot,
    runtimeRoot,
    sandboxName,
    nonce,
    cleanup,
    verdict: "fail",
  };
  let gateway: ChildProcess | null = null;
  let create: ChildProcess | null = null;
  let environment: NodeJS.ProcessEnv = {};
  let created = false;
  let primaryError: unknown = null;
  const cleanupErrors: unknown[] = [];
  const logHandles: number[] = [];
  const checked = async (args: string[], label: string, timeout = 30_000) => {
    console.log(`[Installed read-only] ${label}`);
    const value = await command(openshell, args, environment, runRoot, timeout);
    if (
      value.exitCode !== 0 ||
      value.spawnError ||
      value.timedOut ||
      value.outputExceeded ||
      !value.closed
    )
      throw new Error(`${label}: ${JSON.stringify(value)}`);
    return value;
  };
  const aclPaths = [
    ...new Set([
      path.parse(installRoot).root,
      programFiles,
      path.dirname(installRoot),
      installRoot,
      path.join(installRoot, "bin"),
      node,
      path.join(installRoot, "openclaw"),
      path.join(installRoot, "openclaw", "node_modules", "openclaw"),
      path.join(installRoot, "openclaw", "node_modules", "openclaw", "openclaw.mjs"),
    ]),
  ];
  const aclInput = path.join(evidenceRoot, "acl-paths.json");
  fs.writeFileSync(aclInput, JSON.stringify(aclPaths) + "\n", { flag: "wx" });
  const captureAcl = async (name: string) => {
    const observed = await measuredCommand({
      executable: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fileURLToPath(new URL("./acl-snapshot.ps1", import.meta.url)),
        "-InputPath",
        aclInput,
        "-OutputPath",
        path.join(evidenceRoot, "acl-" + name + ".json"),
      ],
      environment: process.env,
      cwd: evidenceRoot,
      timeoutMs: 30_000,
    });
    if (observed.exitCode !== 0 || observed.timedOut || !observed.closed)
      throw new Error("ACL snapshot failed: " + JSON.stringify(observed));
  };
  const assertAclEqual = (first: string, second: string) => {
    const a = JSON.parse(
      fs.readFileSync(path.join(evidenceRoot, "acl-" + first + ".json"), "utf8"),
    );
    const z = JSON.parse(
      fs.readFileSync(path.join(evidenceRoot, "acl-" + second + ".json"), "utf8"),
    );
    if (JSON.stringify(a) !== JSON.stringify(z))
      throw new Error("An inspected installed runtime ACL changed.");
  };
  try {
    for (const root of ownedRoots) {
      fs.mkdirSync(root);
      createdRoots.push(root);
    }
    for (const name of ["readonly-workload.mts", "measurement.mts"])
      fs.copyFileSync(
        fileURLToPath(new URL("./" + name, import.meta.url)),
        path.join(runRoot, name),
      );
    const copiedProbeCode = ["readonly-workload.mts", "measurement.mts"].map((name) =>
      fileIdentity(path.join(runRoot, name)),
    );
    receipt.probeCodeFiles = copiedProbeCode;
    receipt.probeCodeBytesCopied = copiedProbeCode.reduce((total, file) => total + file.bytes, 0);
    receipt.baselineFiles = [
      "bin/node.exe",
      "bin/openshell.exe",
      "bin/openshell-gateway.exe",
      "mxc/wxc-exec.exe",
      "qualification/run-installed-native-turn.mts",
      "qualification/native-security.mts",
      "qualification/native-ui-lifecycle.mts",
    ].map((relative) => fileIdentity(path.join(installRoot, relative)));
    receipt.installedRuntimeFiles = [
      "bin/node.exe",
      "openclaw/node_modules/openclaw/openclaw.mjs",
      "openclaw/node_modules/openclaw/package.json",
    ].map((relative) => fileIdentity(path.join(installRoot, relative)));
    const home = path.join(shareRoot, "home");
    const temp = path.join(shareRoot, "temp");
    for (const directory of [home, temp, path.join(runRoot, "state"), path.join(runRoot, "config")])
      fs.mkdirSync(directory);
    const gatewayConfig = security.writeNativeGatewayConfig(installRoot, runRoot);
    const policyPath = path.join(runRoot, "policy.yaml");
    fs.writeFileSync(
      policyPath,
      [
        "version: 1",
        "filesystem_policy:",
        "  include_workdir: false",
        "  read_only:",
        ...[node, path.join(installRoot, "openclaw"), runRoot].map(
          (root) => `    - ${helpers.quoteYamlPath(root)}`,
        ),
        "  read_write:",
        `    - ${helpers.quoteYamlPath(shareRoot)}`,
        "",
      ].join("\n"),
    );
    const ownedPath = [
      path.join(installRoot, "bin"),
      path.join(systemRoot, "System32"),
      systemRoot,
    ].join(";");
    environment = helpers.allowlistedWindowsEnvironment({
      OPENSHELL_DRIVERS: "mxc",
      OPENSHELL_GATEWAY_CONFIG: gatewayConfig,
      XDG_CONFIG_HOME: path.join(runRoot, "config"),
      XDG_STATE_HOME: path.join(runRoot, "state"),
      OPENSHELL_GATEWAY: undefined,
    });
    const gatewayPort = await helpers.freePort();
    for (const name of ["gateway.stdout.log", "gateway.stderr.log"])
      logHandles.push(fs.openSync(path.join(evidenceRoot, name), "wx"));
    gateway = spawn(
      gatewayExecutable,
      [
        "--port",
        String(gatewayPort),
        "--disable-tls",
        "--db-url",
        "sqlite::memory:",
        "--log-level",
        "info",
      ],
      { env: environment, windowsHide: true, stdio: ["ignore", logHandles[0], logHandles[1]] },
    );
    const gatewayFailure: { error: Error | null } = { error: null };
    gateway.once("error", (error) => {
      gatewayFailure.error = error;
    });
    await captureAcl("before");
    console.log("[Installed read-only] Starting the installed baseline MXC gateway.");
    await helpers.waitForPort(gatewayPort, gateway);
    if (gatewayFailure.error) throw gatewayFailure.error;
    await checked(
      ["gateway", "add", `http://127.0.0.1:${gatewayPort}`, "--local", "--name", gatewayName],
      "Registering component gateway",
    );
    await checked(["gateway", "select", gatewayName], "Selecting component gateway");
    const sandboxEnvironment = {
      COMSPEC: path.join(systemRoot, "System32", "cmd.exe"),
      LOCALAPPDATA: home,
      APPDATA: home,
      HOME: home,

      OS: "Windows_NT",
      PATH: ownedPath,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PROCESSOR_ARCHITECTURE: "ARM64",
      SYSTEMDRIVE: drive,
      SYSTEMROOT: systemRoot,
      TEMP: temp,
      TMP: temp,
      USERPROFILE: home,
      WINDIR: systemRoot,
    };
    receipt.sandboxEnvironment = sandboxEnvironment;
    const args = [
      "sandbox",
      "create",
      "--name",
      sandboxName,
      "--policy",
      policyPath,
      "--driver-config-json",
      JSON.stringify({
        mxc: {
          command: [
            node,
            "--experimental-strip-types",
            "--no-warnings",
            worker,
            installRoot,
            shareRoot,
            nonce,
          ],
          cwd: shareRoot,
          windows_ui: true,
        },
      }),
      "--no-tty",
    ];
    for (const [key, value] of Object.entries(sandboxEnvironment))
      args.push("--env", `${key}=${value}`);
    const createFailure: { error: Error | null } = { error: null };
    for (const name of ["create.stdout.log", "create.stderr.log"])
      logHandles.push(fs.openSync(path.join(evidenceRoot, name), "wx"));
    console.log(
      "[Installed read-only] Executing installed Node and OpenClaw directly from Program Files.",
    );
    receipt.sandboxCreateRequestedUtc = new Date().toISOString();
    receipt.sandboxCreateRequestedHrtimeNs = process.hrtime.bigint().toString();
    created = true;
    create = spawn(openshell, args, {
      env: environment,
      windowsHide: true,
      stdio: ["ignore", logHandles[2], logHandles[3]],
    });
    create.once("error", (error) => {
      createFailure.error = error;
    });
    const activePath = path.join(shareRoot, "active.json");
    await helpers.waitForNativeTurnResult(activePath, create, gateway, createFailure, 30_000);
    const active = readFixtureRecord(activePath) as {
      nonce: string;
      schemaVersion: number;
      node?: { path: string };
      processId: number;
    };
    if (
      active.nonce !== nonce ||
      active.schemaVersion !== 1 ||
      active.node?.path.toLowerCase() !== fs.realpathSync(node).toLowerCase()
    )
      throw new Error("The active direct-read process identity is invalid.");
    receipt.active = active;
    receipt.firstScriptReceiptObservedUtc = new Date().toISOString();
    receipt.firstScriptReceiptObservedHrtimeNs = process.hrtime.bigint().toString();
    const processStart = await measuredCommand({
      executable: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fileURLToPath(new URL("./process-start.ps1", import.meta.url)),
        "-ProcessId",
        String(active.processId),
        "-ExpectedExecutable",
        node,
        "-OutputPath",
        path.join(evidenceRoot, "contained-process-start.json"),
      ],
      environment: process.env,
      cwd: evidenceRoot,
      timeoutMs: 15_000,
    });
    if (processStart.exitCode !== 0 || processStart.timedOut)
      throw new Error("The actual contained process start could not be observed.");
    const observedStart = JSON.parse(
      fs.readFileSync(path.join(evidenceRoot, "contained-process-start.json"), "utf8"),
    );
    if (observedStart.processId !== active.processId || observedStart.processAlive !== true)
      throw new Error("The active ACL audit did not bind to the live contained process.");
    receipt.containedProcessStart = observedStart;
    await captureAcl("during");
    assertAclEqual("before", "during");
    fs.writeFileSync(path.join(shareRoot, "continue"), nonce + "\n", { flag: "wx" });
    await helpers.waitForNativeTurnResult(resultPath, create, gateway, createFailure, 120_000);
    const result = readFixtureRecord(resultPath) as {
      nonce: string;
      schemaVersion: number;
      passed: boolean;
      runtimeTreeCopies: number;
      runtimeBytesCopied: number;
    };
    receipt.workload = result;
    if (
      result.nonce !== nonce ||
      result.schemaVersion !== 1 ||
      result.passed !== true ||
      result.runtimeTreeCopies !== 0 ||
      result.runtimeBytesCopied !== 0
    )
      throw new Error("The exact component workload did not pass; see per-executable diagnostics.");
    const completion = await lifecycle.waitForNativeMxcCompletion(
      openshell,
      environment,
      sandboxName,
      gateway,
      null,
    );
    receipt.completion = completion;
    if (completion !== "AgentCompleted")
      throw new Error("MXC did not confirm successful component workload termination.");
    cleanup.workloadStopped = true;
    await captureAcl("after");
    assertAclEqual("before", "after");
    receipt.inspectedRuntimeAclsUnchanged = true;
  } catch (error) {
    primaryError = error;
  } finally {
    if (created) {
      try {
        await checked(["sandbox", "delete", sandboxName], "Deleting the owned component sandbox");
        cleanup.sandboxDeleted = true;
        const list = await checked(
          ["sandbox", "list", "-o", "json"],
          "Verifying component registry cleanup",
        );
        cleanup.sandboxRegistryAbsent = !helpers.jsonContainsExactValue(
          JSON.parse(list.stdout),
          sandboxName,
        );
      } catch (error) {
        cleanupErrors.push(errorDetail(error));
      }
    }
    for (const [key, child] of [
      ["createWatcherStopped", create],
      ["gatewayStopped", gateway],
    ] as const) {
      try {
        if (child) cleanup[key] = await stopOwnedChild(child, environment);
      } catch (error) {
        cleanup[key] = false;
        cleanupErrors.push({ action: key, ...errorDetail(error) });
      }
    }
    for (const handle of logHandles) {
      try {
        fs.closeSync(handle);
      } catch (error) {
        cleanupErrors.push({ action: "close diagnostic file", ...errorDetail(error) });
      }
    }
    if (fs.existsSync(path.join(evidenceRoot, "acl-before.json"))) {
      try {
        await captureAcl("after-cleanup");
        assertAclEqual("before", "after-cleanup");
        receipt.inspectedRuntimeAclsRestoredAfterCleanup = true;
      } catch (error) {
        cleanupErrors.push({ action: "runtime ACL cleanup audit", ...errorDetail(error) });
      }
    }
    const removed = await Promise.all(
      createdRoots.map(async (root) => {
        try {
          return await helpers.removeDirectory(root);
        } catch (error) {
          cleanupErrors.push({ action: "remove owned root", root, ...errorDetail(error) });
          return false;
        }
      }),
    );
    cleanup.ownedRootsRemoved = removed.every(Boolean);
    if (primaryError) receipt.error = errorDetail(primaryError);
    receipt.cleanupErrors = cleanupErrors;
    const passed =
      primaryError === null && cleanupErrors.length === 0 && Object.values(cleanup).every(Boolean);
    receipt.verdict = passed ? "pass" : "fail";
    fs.writeFileSync(
      path.join(evidenceRoot, "installed-readonly.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { flag: "wx" },
    );
    console.log(
      `[Installed read-only] ${passed ? "PASS" : "FAIL"}: ${path.join(evidenceRoot, "installed-readonly.json")}`,
    );
    if (!passed) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(JSON.stringify(errorDetail(error)));
    process.exitCode = 1;
  });
}
