// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { command, errorDetail, fileIdentity } from "./probe-component-workload.mts";

export async function bashDiagnostics(
  runtime: string,
  cwd: string,
  nonce: string,
  environment: NodeJS.ProcessEnv,
  scope: "host" | "contained",
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
        if (before.sha256 !== expected)
          throw new Error("The diagnostic Bash differs from the exact candidate bytes.");
        attempted = true;
        const execution = await command(executable, args, environment, cwd, 10_000);
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
  const [runtime, destination, nonce] = process.argv.slice(2);
  if (
    process.platform !== "win32" ||
    !runtime ||
    !destination ||
    !/^[a-f0-9]{24}$/u.test(nonce ?? "")
  )
    throw new Error("Invalid contained Personal probe invocation.");
  const python = path.join(runtime, "hermes-agent/venv/Scripts/python.exe");
  const script = fileURLToPath(new URL("./probe-personal-python.py", import.meta.url));
  const calls = ["python", "bash", "conpty", "browser"].map(async (component) => {
    const execution = await command(
      python,
      ["-I", script, component, runtime, nonce!],
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
      ? await bashDiagnostics(runtime, process.cwd(), nonce!, process.env, "contained")
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
  const identities = [
    "git/bin/bash.exe",
    "git/usr/bin/bash.exe",
    "git/usr/bin/msys-2.0.dll",
    "hermes-agent/venv/Scripts/python.exe",
    "hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/python.exe",
    "tools/browser-use/Scripts/python.exe",
    "agent-browser/bin/agent-browser-win32-x64.exe",
  ].map((relative) => {
    try {
      return { ...fileIdentity(path.join(runtime, relative)), verified: true };
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
