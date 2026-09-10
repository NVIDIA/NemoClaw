// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { command, errorDetail, fileIdentity, stopOwnedChild } from "./probe-component-workload.mts";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? null : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path.`);
  return path.resolve(value);
}

async function main(): Promise<void> {
  if (process.platform !== "win32" || process.arch !== "arm64")
    throw new Error("This component feasibility probe requires Windows ARM64.");
  const installRoot = fs.realpathSync(argument("--install-root"));
  const runtimeRoot = fs.realpathSync(argument("--runtime-root"));
  const evidenceRoot = argument("--artifact-directory");
  if (!/^[A-Za-z]:\\NemoClawHermesProbe-[a-f0-9]{12}$/u.test(runtimeRoot))
    throw new Error("The official runtime must use its build-owned shallow root.");
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
  const runRoot = path.join(`${drive}\\`, `NemoClawComponentRun-${id}`);
  const shareRoot = path.join(`${drive}\\`, `NemoClawComponentShare-${id}`);
  const launcherRoot = path.join(`${drive}\\`, `NemoClawComponentNode-${id}`);
  const ownedRoots = [runRoot, shareRoot, launcherRoot];
  for (const root of ownedRoots) {
    if (fs.existsSync(root)) throw new Error("A component probe root already exists.");
  }
  const createdRoots: string[] = [];
  const openshell = path.join(installRoot, "bin", "openshell.exe");
  const gatewayExecutable = path.join(installRoot, "bin", "openshell-gateway.exe");
  const node = path.join(launcherRoot, "node.exe");
  const worker = path.join(launcherRoot, "probe-component-workload.mts");
  const resultPath = path.join(shareRoot, "result.json");
  const sandboxName = `hermes-component-${id}`;
  const gatewayName = `hermes-component-gateway-${id}`;
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
    classification: "official-hermes-mxc-component-feasibility-only",
    completeRuntime: false,
    installedAcceptance: false,
    conptyTested: false,
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
    console.log(`[Hermes components] ${label}`);
    const value = await command(openshell, args, environment, runRoot, timeout);
    if (
      value.exitCode !== 0 ||
      value.error ||
      value.timedOut ||
      value.outputExceeded ||
      !value.childClosed
    )
      throw new Error(`${label}: ${JSON.stringify(value)}`);
    return value;
  };
  try {
    for (const root of ownedRoots) {
      fs.mkdirSync(root);
      createdRoots.push(root);
    }
    fs.copyFileSync(path.join(installRoot, "bin", "node.exe"), node);
    fs.copyFileSync(
      fileURLToPath(new URL("./probe-component-workload.mts", import.meta.url)),
      worker,
    );
    receipt.baselineFiles = [
      "bin/node.exe",
      "bin/openshell.exe",
      "bin/openshell-gateway.exe",
      "mxc/wxc-exec.exe",
      "qualification/run-installed-native-turn.mts",
      "qualification/native-security.mts",
      "qualification/native-ui-lifecycle.mts",
    ].map((relative) => fileIdentity(path.join(installRoot, relative)));
    receipt.componentFiles = [
      "git/bin/bash.exe",
      "git/usr/bin/bash.exe",
      "git/usr/bin/msys-2.0.dll",
      "git/usr/bin/cat.exe",
      "git/usr/bin/printf.exe",
      "git/cmd/git.exe",
      "hermes-agent/venv/Scripts/python.exe",
      "hermes-agent/venv/pyvenv.cfg",
      "hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/python.exe",
    ].map((relative) => fileIdentity(path.join(runtimeRoot, relative)));
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
        ...[runtimeRoot, launcherRoot].map((root) => `    - ${helpers.quoteYamlPath(root)}`),
        "  read_write:",
        `    - ${helpers.quoteYamlPath(shareRoot)}`,
        "",
      ].join("\n"),
    );
    const ownedPath = [
      path.join(runtimeRoot, "git", "cmd"),
      path.join(runtimeRoot, "git", "bin"),
      path.join(runtimeRoot, "git", "usr", "bin"),
      path.join(runtimeRoot, "hermes-agent", "venv", "Scripts"),
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
    console.log("[Hermes components] Starting the installed baseline MXC gateway.");
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
      HERMES_GIT_BASH_PATH: path.join(runtimeRoot, "git", "bin", "bash.exe"),
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
            runtimeRoot,
            resultPath,
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
    console.log("[Hermes components] Running exact PortableGit and managed Python inside MXC.");
    created = true;
    create = spawn(openshell, args, {
      env: environment,
      windowsHide: true,
      stdio: ["ignore", logHandles[2], logHandles[3]],
    });
    create.once("error", (error) => {
      createFailure.error = error;
    });
    await helpers.waitForNativeTurnResult(resultPath, create, gateway, createFailure, 120_000);
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    receipt.workload = result;
    if (
      result.nonce !== nonce ||
      result.schemaVersion !== 1 ||
      result.passed !== true ||
      result.components?.length !== 2
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
      path.join(evidenceRoot, "mxc-components.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { flag: "wx" },
    );
    console.log(
      `[Hermes components] ${passed ? "PASS" : "FAIL"}: ${path.join(evidenceRoot, "mxc-components.json")}`,
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
