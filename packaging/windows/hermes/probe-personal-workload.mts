// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decodeDiagnostic,
  errorDetail,
  fileIdentity,
  stopOwnedChild,
  type CommandResult,
} from "./probe-component-workload.mts";

export const personalCriticalFiles = [
  "git/bin/bash.exe",
  "git/bin/sh.exe",
  "git/usr/bin/bash.exe",
  "git/usr/bin/sh.exe",
  "git/usr/bin/msys-2.0.dll",
  "hermes-agent/venv/Scripts/python.exe",
  "hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/python.exe",
  "tools/browser-use/Scripts/python.exe",
  "agent-browser/bin/agent-browser-win32-x64.exe",
] as const;

export function validatePersonalWorkloadInput(input: any, runtime: string, nonce: string) {
  if (
    input.schemaVersion !== 1 ||
    input.nonce !== nonce ||
    input.runtime !== runtime ||
    !/^[a-f0-9]{40}$/u.test(input.compatibilityProofSource) ||
    !Array.isArray(input.files) ||
    input.files.length !== personalCriticalFiles.length ||
    new Set(input.files.map((file: any) => file.path)).size !== personalCriticalFiles.length
  )
    throw new Error("The verified Personal input identity or inventory differs.");
  for (const relative of personalCriticalFiles) {
    const file = input.files.find((row: any) => row.path === relative);
    if (
      !file ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      throw new Error("The Personal critical-file inventory is incomplete.");
    if (relative.startsWith("git/") && input.gitPins?.[relative.slice(4)] !== file.sha256)
      throw new Error("The Personal Git image differs from its passed proof.");
  }
  return input;
}

// Keep application output at its existing limit. Native compatibility evidence
// has a separate bounded channel, so it cannot hide a Python exception/result.
export async function personalCommand(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  timeout = 30_000,
) {
  const started = performance.now();
  const child = spawn(executable, args, {
    env: environment,
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result: CommandResult & {
    pid: number | null;
    nativeStderr: string;
    nativeStderrBytes: number;
    nativeStderrSha256: string;
    nativeRecordCount: number;
    nativeOutputExceeded: boolean;
    nativeParseErrors: Record<string, unknown>[];
  } = {
    executable,
    args,
    pid: child.pid ?? null,
    exitCode: null,
    signal: null,
    timedOut: false,
    outputExceeded: false,
    stdout: "",
    stderr: "",
    error: null,
    childClosed: false,
    elapsedMs: 0,
    nativeStderr: "",
    nativeStderrBytes: 0,
    nativeStderrSha256: "",
    nativeRecordCount: 0,
    nativeOutputExceeded: false,
    nativeParseErrors: [],
  };
  const output = {
    stdout: { chunks: [] as Buffer[], bytes: 0 },
    stderr: { chunks: [] as Buffer[], bytes: 0 },
    native: { chunks: [] as Buffer[], bytes: 0 },
  };
  let stopping: Promise<boolean> | undefined;
  let cleanupDeadline: number | undefined;
  const stop = () => {
    if (!stopping) {
      cleanupDeadline = performance.now() + 5000;
      stopping = stopOwnedChild(child, environment);
    }
    return stopping;
  };
  const retain = (channel: keyof typeof output, bytes: Buffer) => {
    const captured = output[channel];
    const limit = channel === "native" ? 256 * 1024 : 64 * 1024;
    const remaining = Math.max(0, limit - captured.bytes);
    if (remaining) captured.chunks.push(bytes.subarray(0, remaining));
    captured.bytes += Math.min(remaining, bytes.length);
    if (bytes.length > remaining) {
      if (channel === "native") {
        result.nativeOutputExceeded = true;
        result.error ??= errorDetail(new Error("Native diagnostic output exceeded its bound."));
      } else result.outputExceeded = true;
      void stop();
    }
  };
  const stderrLine = (bytes: Buffer) => {
    const text = bytes.toString("utf8");
    const prefix = /^NEMOCLAW_MSYS_[A-Z0-9_]+=/u.exec(text);
    if (!prefix) {
      retain("stderr", bytes);
      return;
    }
    retain("native", bytes);
    try {
      const record = JSON.parse(text.slice(prefix[0].length));
      if (!record || typeof record !== "object" || Array.isArray(record))
        throw new Error("Native diagnostic record is not an object.");
      result.nativeRecordCount += 1;
    } catch (error) {
      const detail = errorDetail(error);
      if (result.nativeParseErrors.length < 8) result.nativeParseErrors.push(detail);
      result.error ??= errorDetail(new Error("A native diagnostic record could not be parsed."));
      void stop();
    }
  };
  let pending = Buffer.alloc(0);
  child.stdout.on("data", (bytes: Buffer) => retain("stdout", bytes));
  child.stderr.on("data", (bytes: Buffer) => {
    pending = Buffer.concat([pending, bytes]);
    let newline: number;
    while ((newline = pending.indexOf(10)) >= 0) {
      stderrLine(pending.subarray(0, newline + 1));
      pending = pending.subarray(newline + 1);
    }
    if (pending.length > 64 * 1024) {
      stderrLine(pending);
      pending = Buffer.alloc(0);
    }
  });
  const closed = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      result.error ??= errorDetail(error);
    });
    child.once("close", (code, signal) => {
      result.exitCode = code;
      result.signal = signal;
      result.childClosed = true;
      resolve();
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(async () => {
      result.timedOut = true;
      await stop();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve();
    }, timeout);
  });
  await Promise.race([closed, deadline]);
  clearTimeout(timer);
  if (pending.length) stderrLine(pending);
  if (stopping) {
    await stopping;
    if (!result.childClosed) {
      // Exit precedes close. Observe pipe/handle closure within the same
      // cleanup budget rather than treating exit alone as complete cleanup.
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          closeTimer = setTimeout(resolve, Math.max(0, cleanupDeadline! - performance.now()));
        }),
      ]);
      clearTimeout(closeTimer);
    }
  }
  result.stdout = decodeDiagnostic(Buffer.concat(output.stdout.chunks));
  result.stderr = decodeDiagnostic(Buffer.concat(output.stderr.chunks));
  const native = Buffer.concat(output.native.chunks);
  result.nativeStderr = native.toString("utf8");
  result.nativeStderrBytes = native.length;
  result.nativeStderrSha256 = createHash("sha256").update(native).digest("hex");
  result.elapsedMs = performance.now() - started;
  return result;
}

export async function bashDiagnostics(
  runtime: string,
  cwd: string,
  nonce: string,
  environment: NodeJS.ProcessEnv,
  scope: "host" | "contained",
  gitPins?: Record<string, string>,
) {
  if (!/^[a-f0-9]{24}$/u.test(nonce)) throw new Error("Invalid Bash diagnostic identity.");
  const marker = `NEMOCLAW_BASH_DIAGNOSTIC_${nonce}`;
  const args = ["--noprofile", "--norc", "-c", `printf '%s\\n' '${marker}'`];
  const cases = await Promise.all(
    [
      ["git/bin/bash.exe", "828e6e891cee98d39057c0c193800e564231fdf92b3cefa15944378fc7730095"],
      ["git/usr/bin/bash.exe", "92cff5f145d42f85b55aa3be8d3ad9827844a21ec4fbeaa1ddfe1dd4d76c6474"],
    ].map(async ([relative, expected]) => {
      const executable = path.join(runtime, relative!);
      let attempted = false;
      try {
        const before = fileIdentity(executable);
        const pin = gitPins ? gitPins[relative!.slice("git/".length)] : expected;
        if (before.sha256 !== pin)
          throw new Error("The diagnostic Bash differs from the exact candidate bytes.");
        attempted = true;
        const execution = await personalCommand(executable, args, environment, cwd, 10_000);
        const after = fileIdentity(executable);
        return {
          executable,
          before,
          after,
          execution,
          childrenClosed:
            execution.childClosed &&
            !execution.timedOut &&
            !execution.outputExceeded &&
            !execution.error,
          bytesUnchanged: before.sha256 === after.sha256,
          sentinelObserved: execution.exitCode === 0 && execution.stdout.trim() === marker,
        };
      } catch (error) {
        return {
          executable,
          error: errorDetail(error),
          childrenClosed: !attempted,
          bytesUnchanged: false,
          sentinelObserved: false,
        };
      }
    }),
  );
  return {
    classification: "exact-byte-Bash-startup-diagnostic",
    scope,
    diagnosticOnly: true,
    canonicalQualification: false,
    cwd,
    home: environment.HOME,
    temp: environment.TEMP,
    environment: Object.fromEntries(
      [
        "PATH",
        "PATHEXT",
        "COMSPEC",
        "SYSTEMROOT",
        "HERMES_GIT_BASH_PATH",
        "HOME",
        "HERMES_HOME",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
      ].map((key) => [key, environment[key] ?? null]),
    ),
    cases,
    childrenClosed: cases.every((row) => row.childrenClosed),
  };
}

export function parseComponent(stdout: string, component: string, nonce: string) {
  const rows = stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("NEMOCLAW_PERSONAL_RESULT="));
  if (rows.length !== 1) throw new Error("The component did not publish exactly one result.");
  const result = JSON.parse(rows[0]!.slice("NEMOCLAW_PERSONAL_RESULT=".length));
  if (result.schemaVersion !== 1 || result.component !== component || result.nonce !== nonce)
    throw new Error("The component result identity differs.");
  return result;
}

async function main() {
  const [runtime, destination, nonce, configuration] = process.argv.slice(2);
  if (
    process.platform !== "win32" ||
    !runtime ||
    !destination ||
    !configuration ||
    !/^[a-f0-9]{24}$/u.test(nonce ?? "")
  )
    throw new Error("Invalid contained Personal probe invocation.");
  const expectedConfiguration = fileURLToPath(
    new URL("./personal-workload-input.json", import.meta.url),
  );
  if (path.resolve(configuration) !== expectedConfiguration)
    throw new Error("The Personal input differs from the owned controller path.");
  const input = validatePersonalWorkloadInput(
    JSON.parse(fs.readFileSync(configuration, "utf8")),
    runtime,
    nonce!,
  );
  for (const file of input.files) {
    const actual = fileIdentity(path.join(runtime, file.path));
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
      throw new Error(`The contained Personal input changed: ${file.path}`);
  }
  const python = path.join(runtime, "hermes-agent/venv/Scripts/python.exe");
  const script = fileURLToPath(new URL("./probe-personal-python.py", import.meta.url));
  const calls = ["python", "bash", "conpty", "browser"].map(async (component) => {
    const execution = await personalCommand(
      python,
      ["-I", "-B", script, component, runtime, nonce!],
      process.env,
      process.cwd(),
      component === "browser" ? 90_000 : 30_000,
    );
    try {
      const result = parseComponent(execution.stdout, component, nonce!);
      return {
        component,
        execution,
        result,
        passed:
          result.passed === true &&
          execution.exitCode === 0 &&
          execution.childClosed &&
          !execution.timedOut &&
          !execution.outputExceeded &&
          !execution.error,
      };
    } catch (error) {
      return { component, execution, error: String(error), passed: false };
    }
  });
  // Preserve the original LocalEnvironment outcome before starting direct
  // diagnostics. They overlap only the other bounded component checks.
  const diagnostic = calls[1]!.then(async (canonical) =>
    canonical.execution.childClosed
      ? await bashDiagnostics(
          runtime,
          process.cwd(),
          nonce!,
          process.env,
          "contained",
          input.gitPins,
        )
      : {
          classification: "exact-byte-Bash-startup-diagnostic",
          scope: "contained",
          diagnosticOnly: true,
          canonicalQualification: false,
          skipped: "canonical Bash child did not close",
        },
  );
  const components = await Promise.all(calls);
  const bashDiagnostic = await diagnostic;
  const identities = personalCriticalFiles.map((relative) => {
    try {
      const actual = fileIdentity(path.join(runtime, relative));
      const expected = input.files.find((file: any) => file.path === relative);
      return {
        ...actual,
        verified: actual.sha256 === expected.sha256 && actual.bytes === expected.bytes,
      };
    } catch (error) {
      return { path: relative, error: errorDetail(error), verified: false };
    }
  });
  const result = {
    schemaVersion: 1,
    classification: "canonical-personal-mxc-feasibility",
    nonce,
    components,
    bashDiagnostic,
    identities,
    controllerPid: process.pid,
    compatibilityProofSource: input.compatibilityProofSource,
    passed:
      components.every((entry) => entry.passed) && identities.every((entry) => entry.verified),
    installedAcceptance: false,
    dashboardTested: false,
    tuiTested: false,
  };
  fs.writeFileSync(destination, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  // The parent owns the qualification verdict. Always finish naturally after
  // publishing all independent component failures so MXC can close its job.
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
