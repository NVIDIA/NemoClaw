// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { command, errorDetail, fileIdentity } from "./probe-component-workload.mts";

export function personalRequest(
  node: string,
  worker: string,
  runtime: string,
  share: string,
  nonce: string,
  windows: string,
) {
  if (
    !/^[a-f0-9]{24}$/u.test(nonce) ||
    [node, worker, runtime, share, windows].some((value) => /["\r\n]/u.test(value))
  )
    throw new Error("Invalid Personal probe identity or path.");
  const home = path.win32.join(share, "home");
  const temp = path.win32.join(share, "temp");
  const environment = {
    NODE_DISABLE_COMPILE_CACHE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    COMSPEC: path.win32.join(windows, "System32/cmd.exe"),
    HERMES_HOME: home,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    HERMES_GIT_BASH_PATH: path.win32.join(runtime, "git/bin/bash.exe"),
    HERMES_DISABLE_LAZY_INSTALLS: "1",
    UV_OFFLINE: "1",
    PIP_NO_INDEX: "1",
    TEMP: temp,
    TMP: temp,
    OS: "Windows_NT",
    PROCESSOR_ARCHITECTURE: "ARM64",
    SYSTEMROOT: windows,
    WINDIR: windows,
    SYSTEMDRIVE: path.win32.parse(windows).root.slice(0, 2),
    PATHEXT: ".COM;.EXE;.BAT;.CMD;",
    PATH: ["bin", "node", "hermes-agent/venv/Scripts", "git/cmd", "git/bin", "git/usr/bin"]
      .map((value) => path.win32.join(runtime, value))
      .concat([path.win32.join(windows, "System32"), windows])
      .join(";"),
  };
  return {
    version: "0.6.0-alpha",
    containerId: `hp-${nonce.slice(0, 12)}`,
    containment: "processcontainer",
    process: {
      commandLine: [
        node,
        "--experimental-strip-types",
        "--no-warnings",
        worker,
        runtime,
        path.win32.join(share, "result.json"),
        nonce,
      ]
        .map((value) => `"${value}"`)
        .join(" "),
      cwd: share,
      timeout: 120_000,
      env: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    },
    processContainer: {
      leastPrivilege: false,
      capabilities: ["privateNetworkClientServer", "internetClient"],
    },
    ui: { disable: false },
    network: {
      defaultPolicy: "allow",
      allowedHosts: [],
      blockedHosts: [],
      allowLocalNetwork: true,
    },
    filesystem: { readonlyPaths: [runtime, path.win32.dirname(worker)], readwritePaths: [share] },
    lifecycle: { destroyOnExit: false, preservePolicy: false },
  };
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1]!.startsWith("--"))
    throw new Error(`Missing ${name}.`);
  return path.resolve(process.argv[index + 1]!);
}

export function removePersonalRoots(
  directories: string[],
  attempted: boolean,
  executorClosed: boolean,
) {
  const errors: unknown[] = [];
  if (!attempted || executorClosed) {
    for (const directory of directories) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        errors.push(errorDetail(error));
      }
    }
  }
  return { removed: directories.every((directory) => !fs.existsSync(directory)), errors };
}

export function publishPersonalReceipt(
  file: string,
  receipt: Record<string, unknown>,
  primary: unknown,
  report: (value: unknown) => void = console.error,
) {
  if (primary) report({ primary: errorDetail(primary) });
  try {
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    return true;
  } catch (error) {
    report({ receiptWriteError: errorDetail(error) });
    return false;
  }
}

async function main() {
  if (
    process.platform !== "win32" ||
    process.arch !== "arm64" ||
    process.env.GITHUB_ACTIONS !== "true"
  )
    throw new Error("The Personal candidate probe requires disposable Windows ARM64 CI.");
  const runtime = fs.realpathSync(argument("--runtime-root"));
  const mxc = argument("--mxc");
  const output = argument("--output");
  const windows = path.dirname(process.env.ComSpec ?? process.env.COMSPEC ?? "");
  const windowsRoot = path.dirname(windows);
  if (
    !/^[A-Za-z]:\\NemoClawHermesProbe-[a-f0-9]{12}$/u.test(runtime) ||
    !/^[A-Za-z]:\\Windows$/iu.test(windowsRoot)
  )
    throw new Error("The candidate and Windows roots differ from the owned probe contract.");
  fs.mkdirSync(output);
  const nonce = randomBytes(12).toString("hex");
  const root = path.parse(runtime).root;
  const launcher = path.join(root, `NemoClawPersonalNode-${nonce.slice(0, 12)}`);
  const share = path.join(root, `NemoClawPersonalShare-${nonce.slice(0, 12)}`);
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "COMSPEC",
    "ComSpec",
    "OS",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "RUNNER_TRACKING_ID",
  ])
    if (process.env[key]) environment[key] = process.env[key];
  environment.PATH = path.join(windowsRoot, "System32");
  const cleanup = { executorClosed: false, profileDeleted: false, ownedRootsRemoved: false };
  const receipt: Record<string, unknown> = {
    schemaVersion: 1,
    classification: "canonical-personal-mxc-feasibility",
    sourceRevision: process.env.GITHUB_SHA,
    candidateSource: "47d890728482cca05e840edd27e33e3d495aeabf",
    runtime,
    installedAcceptance: false,
    fullAgentQualified: false,
    feasibilityPassed: false,
    cleanup,
  };
  const errors: unknown[] = [];
  let attempted = false;
  let failure: unknown = null;
  let request: ReturnType<typeof personalRequest> | undefined;
  try {
    const nodeIdentity = fileIdentity(process.execPath);
    const mxcIdentity = fileIdentity(mxc);
    if (
      nodeIdentity.sha256 !== "97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878" ||
      mxcIdentity.sha256 !== "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503"
    )
      throw new Error("An executed host binary differs from its immutable pin.");
    receipt.hostInputs = { node: nodeIdentity, mxc: mxcIdentity };
    fs.mkdirSync(launcher);
    fs.mkdirSync(share);
    for (const name of ["home", "temp"]) fs.mkdirSync(path.join(share, name));
    fs.copyFileSync(process.execPath, path.join(launcher, "node.exe"));
    for (const name of [
      "probe-component-workload.mts",
      "probe-personal-workload.mts",
      "probe-personal-python.py",
    ])
      fs.copyFileSync(
        fileURLToPath(new URL("./" + name, import.meta.url)),
        path.join(launcher, name),
      );
    request = personalRequest(
      path.join(launcher, "node.exe"),
      path.join(launcher, "probe-personal-workload.mts"),
      runtime,
      share,
      nonce,
      windowsRoot,
    );
    const policy = path.join(output, "personal-request.json");
    const bytes = JSON.stringify(request, null, 2) + "\n";
    fs.writeFileSync(policy, bytes, { flag: "wx" });
    receipt.requestSha256 = createHash("sha256").update(bytes).digest("hex");
    attempted = true;
    const execution = await command(
      mxc,
      [policy, "--log-file", path.join(output, "mxc-native.log")],
      environment,
      share,
      120_000,
    );
    receipt.execution = execution;
    cleanup.executorClosed = execution.childClosed;
    const result = path.join(share, "result.json");
    if (fs.existsSync(result)) {
      fs.copyFileSync(result, path.join(output, "workload.json"));
      receipt.workload = JSON.parse(fs.readFileSync(result, "utf8"));
    }
    if (
      execution.exitCode !== 0 ||
      execution.timedOut ||
      execution.outputExceeded ||
      execution.error ||
      !execution.childClosed
    )
      throw new Error("The owned MXC executor did not finish successfully; see its exact output.");
    const workload = receipt.workload as
      | { nonce?: string; passed?: boolean; components?: unknown[] }
      | undefined;
    if (workload?.nonce !== nonce || workload.passed !== true || workload.components?.length !== 4)
      throw new Error("One or more canonical Personal component operations failed.");
    const log = fs
      .readFileSync(path.join(output, "mxc-native.log"), "utf8")
      .replace(/\[\d+\][ \t]*/gu, "");
    if (
      !/^selected isolation tier:\s*appcontainer-dacl\s*$/mu.test(log) ||
      log.includes("Win32k mitigation applied to child process")
    )
      throw new Error(
        "The actual MXC log does not confirm the intended Personal UI-compatible tier.",
      );
    receipt.selectedTier = "appcontainer-dacl";
  } catch (error) {
    failure = error;
  } finally {
    if (attempted && cleanup.executorClosed && request) {
      try {
        const deletion = await command(
          mxc,
          ["--delete", "--containername", request.containerId],
          environment,
          root,
        );
        receipt.profileDeletion = deletion;
        cleanup.profileDeleted =
          deletion.exitCode === 0 &&
          deletion.childClosed &&
          !deletion.error &&
          !deletion.timedOut &&
          !deletion.outputExceeded;
      } catch (error) {
        errors.push(errorDetail(error));
      }
    }
    const roots = removePersonalRoots([share, launcher], attempted, cleanup.executorClosed);
    errors.push(...roots.errors);
    cleanup.ownedRootsRemoved = roots.removed;
    receipt.executorAttempted = attempted;
    receipt.rootsRetainedForUnclosedExecutor = attempted && !cleanup.executorClosed;
    receipt.error = failure ? errorDetail(failure) : null;
    receipt.cleanupErrors = errors;
    receipt.feasibilityPassed =
      failure === null && errors.length === 0 && Object.values(cleanup).every(Boolean);
    const published = publishPersonalReceipt(
      path.join(output, "personal-feasibility.json"),
      receipt,
      failure,
    );
    if (!receipt.feasibilityPassed || !published) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(errorDetail(error));
    process.exitCode = 1;
  });
}
