// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host Python discovery for the Model Router venv.
 *
 * #3781: NemoClaw used to pick whatever `python3` resolved to first, run
 * `python3 -m venv` unconditionally, and surface only the venv exit code
 * when ensurepip failed at the stdlib level. On macOS with Homebrew
 * python@3.14, that means a cryptic `_XML_SetAllocTrackerActivationThreshold`
 * pyexpat import error gets hidden behind "Failed to create Model Router
 * virtual environment.", even when a healthy python3.11 is right there on
 * PATH.
 *
 * pickHostPython probes each candidate interpreter for two things:
 *   1. version is inside the supported window (3.10 ≤ X < 3.14)
 *   2. the stdlib modules venv setup needs (ensurepip, pyexpat, ssl, venv)
 *      actually import without raising
 *
 * It returns the first candidate that passes, plus the per-candidate failure
 * reasons so the caller can show the real cause when nothing works.
 *
 * Every external call (which lookup, probe invocation) is dependency-injected
 * so tests run with no spawn.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const { run, runCapture } = require("../runner") as typeof import("../runner");

/** Inclusive lower bound. Matches the Model Router pyproject `requires-python = ">=3.10"`. */
export const MIN_PYTHON_VERSION: readonly [number, number] = [3, 10];

/**
 * Exclusive upper bound. Pinned to 3.14 because torch and litellm wheels
 * do not yet ship cp314 abi tags reliably (May 2026), and macOS Homebrew
 * python@3.14's pyexpat dlopen failure (#3781) is in the wild.
 *
 * Lift this as upstream wheel coverage catches up.
 */
export const MAX_PYTHON_EXCLUSIVE: readonly [number, number] = [3, 14];

/** Stdlib modules that must import for `python -m venv` to bootstrap. */
export const REQUIRED_STDLIB_MODULES: readonly string[] = ["ensurepip", "pyexpat", "ssl", "venv"];

const CANDIDATES: readonly string[] = [
  "python3.13",
  "python3.12",
  "python3.11",
  "python3.10",
  "python3",
];

const PROBE_SCRIPT = [
  "import sys, json",
  "err = None",
  "try:",
  `    import ${REQUIRED_STDLIB_MODULES.join(", ")}  # noqa: F401`,
  "except Exception as e:",
  '    err = f"{type(e).__name__}: {e}"',
  'print(json.dumps({"version": list(sys.version_info[:3]), "error": err}))',
  "sys.exit(0 if err is None else 1)",
].join("\n");

export interface PythonProbeOk {
  /** Name to spawn (matches the candidate, e.g. "python3.12", or the
   * NEMOCLAW_MODEL_ROUTER_PYTHON override absolute path). Production passes
   * this to spawnSync so PATH resolution mirrors what `command -v` saw. */
  command: string;
  /** Absolute path discovered at probe time, for diagnostics. */
  executable: string;
  version: readonly [number, number, number];
}

export interface PythonProbeFailure {
  candidate: string;
  resolved: string | null;
  reason: string;
}

export interface PickHostPythonResult {
  ok: PythonProbeOk | null;
  failures: readonly PythonProbeFailure[];
}

export interface PickHostPythonDeps {
  which?: (cmd: string) => string | null;
  probe?: (executable: string) => { exit: number; stdout: string; stderr: string };
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

export function pickHostPython(deps: PickHostPythonDeps = {}): PickHostPythonResult {
  const which = deps.which ?? defaultWhich;
  const probe = deps.probe ?? defaultProbe;
  const log = deps.log ?? defaultLog;
  const env = deps.env ?? process.env;

  const failures: PythonProbeFailure[] = [];
  const tried = new Set<string>();

  const override = (env.NEMOCLAW_MODEL_ROUTER_PYTHON || "").trim();
  const ordered = override ? [override, ...CANDIDATES] : [...CANDIDATES];

  for (const candidate of ordered) {
    const resolved = candidate.startsWith("/") ? candidate : which(candidate);
    if (!resolved) {
      failures.push({ candidate, resolved: null, reason: "not on PATH" });
      continue;
    }
    if (tried.has(resolved)) continue;
    tried.add(resolved);

    const result = probeCandidate(candidate, resolved, probe);
    if (result.ok) {
      log(`  ${candidate} (${resolved}): version ${result.ok.version.join(".")} healthy`);
      return { ok: { ...result.ok, command: candidate }, failures };
    }
    failures.push(result.failure);
    log(`  ${candidate} (${resolved}): ${result.failure.reason}`);
  }

  return { ok: null, failures };
}

function probeCandidate(
  candidate: string,
  resolved: string,
  probe: NonNullable<PickHostPythonDeps["probe"]>,
):
  | { ok: Omit<PythonProbeOk, "command">; failure?: never }
  | { ok?: never; failure: PythonProbeFailure } {
  const probeResult = probe(resolved);
  let parsed: { version?: number[]; error?: string | null } = {};
  if (probeResult.stdout) {
    try {
      parsed = JSON.parse(probeResult.stdout);
    } catch {
      // fall through — handled below
    }
  }
  const version = Array.isArray(parsed.version) && parsed.version.length === 3 ? parsed.version : null;
  if (probeResult.exit !== 0 || !version) {
    const detail =
      parsed.error ||
      probeResult.stderr.trim().split("\n").slice(-1)[0] ||
      `probe exit ${probeResult.exit}`;
    return { failure: { candidate, resolved, reason: detail } };
  }
  const [major, minor, patch] = version;
  if (compareVersion([major, minor], MIN_PYTHON_VERSION) < 0) {
    return {
      failure: {
        candidate,
        resolved,
        reason: `version ${version.join(".")} below supported floor ${MIN_PYTHON_VERSION.join(".")}`,
      },
    };
  }
  if (compareVersion([major, minor], MAX_PYTHON_EXCLUSIVE) >= 0) {
    return {
      failure: {
        candidate,
        resolved,
        reason: `version ${version.join(".")} above supported ceiling ${MAX_PYTHON_EXCLUSIVE.join(".")} (exclusive)`,
      },
    };
  }
  return { ok: { executable: resolved, version: [major, minor, patch] } };
}

function compareVersion(a: readonly [number, number], b: readonly [number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

export function formatHostPythonFailureMessage(failures: readonly PythonProbeFailure[]): string {
  const ceiling = `${MAX_PYTHON_EXCLUSIVE[0]}.${MAX_PYTHON_EXCLUSIVE[1] - 1}`;
  const lines = [
    `No usable host Python interpreter found for Model Router.`,
    `Need Python ${MIN_PYTHON_VERSION.join(".")}-${ceiling} with ${REQUIRED_STDLIB_MODULES.join(", ")} importable.`,
    "Probed:",
  ];
  for (const f of failures) {
    lines.push(`  - ${f.candidate}${f.resolved ? ` (${f.resolved})` : ""}: ${f.reason}`);
  }
  lines.push(
    "Install a supported interpreter (for example `brew install python@3.12` on macOS),",
    "or set NEMOCLAW_MODEL_ROUTER_PYTHON to the absolute path of a known-good python.",
  );
  return lines.join("\n");
}

function defaultWhich(cmd: string): string | null {
  // Routes through runner.runCapture so the onboard-model-router integration
  // tests can stub `command -v` lookups without spawning real processes.
  const out = runCapture(["sh", "-c", 'command -v "$1"', "--", cmd], { ignoreError: true }).trim();
  return out || null;
}

function defaultProbe(executable: string): { exit: number; stdout: string; stderr: string } {
  const result = spawnSync(executable, ["-c", PROBE_SCRIPT], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  return {
    exit: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function defaultLog(message: string): void {
  console.log(message);
}

/**
 * Prepare the Model Router venv: pick a healthy host python, create the venv,
 * and verify the venv python landed on disk. Throws with the real reason on
 * any failure (probe failure, version mismatch, stdlib import error, or
 * `python -m venv` non-zero exit). Returns the absolute path to the venv
 * python binary on success.
 */
export function prepareModelRouterVenv(opts: {
  venvDir: string;
  log?: (message: string) => void;
}): string {
  const log = opts.log ?? defaultLog;
  const { ok: hostPython, failures } = pickHostPython({ log });
  if (!hostPython) {
    throw new Error(formatHostPythonFailureMessage(failures));
  }

  const venvPython = path.join(opts.venvDir, "bin", "python");
  fs.mkdirSync(path.dirname(opts.venvDir), { recursive: true });
  log(`  Preparing Model Router environment: ${opts.venvDir} (using ${hostPython.executable})`);
  const venvResult = run([hostPython.command, "-m", "venv", opts.venvDir], {
    ignoreError: true,
    timeout: 120_000,
  });
  if (venvResult.status !== 0 || !fs.existsSync(venvPython)) {
    const stderrTail = (venvResult.stderr?.toString("utf-8") || "").trim().split("\n").slice(-3).join("\n");
    throw new Error(
      `Failed to create Model Router virtual environment with ${hostPython.executable}.${stderrTail ? `\n${stderrTail}` : ""}`,
    );
  }
  return venvPython;
}
