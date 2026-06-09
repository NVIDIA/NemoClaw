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
 * Probing happens in two stages, both with fallback:
 *   1. pickHostPython runs the stdlib import probe across the candidate list
 *      and returns every interpreter that passes, in priority order.
 *   2. prepareModelRouterVenv walks that list, retrying `python -m venv` on
 *      the next healthy candidate if creation fails — so a python whose
 *      imports succeed but whose venv bootstrap is broken does not strand
 *      onboarding (Codex P2 on PR #3786).
 *
 * NEMOCLAW_MODEL_ROUTER_PYTHON is strict: when set, that single interpreter
 * is the only candidate. If it fails the probe, NemoClaw aborts rather than
 * silently using a different python (Codex P3 on PR #3786), matching the
 * "pin" wording in docs/inference/inference-options.mdx and commands.mdx.
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

export const OVERRIDE_ENV_VAR = "NEMOCLAW_MODEL_ROUTER_PYTHON";

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
  /** Original candidate label (e.g. "python3.12", or the override path).
   * Used only for diagnostics/log lines so the user can correlate a
   * failure to the candidate they expected to be tried. */
  candidate: string;
  /** Absolute path discovered at probe time. Production spawns this directly
   * so a PATH change between probe and use cannot substitute a different
   * interpreter (Codex P-Major on PR #3786, CodeRabbit follow-up). */
  executable: string;
  version: readonly [number, number, number];
}

export interface PythonProbeFailure {
  candidate: string;
  resolved: string | null;
  reason: string;
}

export interface PickHostPythonResult {
  /** First healthy candidate, or null when nothing qualifies. Kept for
   * back-compat with callers that only need the best pick. */
  ok: PythonProbeOk | null;
  /** Every healthy candidate in priority order, so the venv step can
   * fall back to the next one when `python -m venv` itself fails. */
  healthy: readonly PythonProbeOk[];
  failures: readonly PythonProbeFailure[];
  /** True when NEMOCLAW_MODEL_ROUTER_PYTHON was set. Used to tailor the
   * failure message and signal strict-override semantics to callers. */
  overrideRequested: boolean;
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
  const healthy: PythonProbeOk[] = [];
  const tried = new Set<string>();

  const override = (env[OVERRIDE_ENV_VAR] || "").trim();
  if (override && !path.isAbsolute(override)) {
    return {
      ok: null,
      healthy: [],
      failures: [
        {
          candidate: override,
          resolved: null,
          reason: `${OVERRIDE_ENV_VAR} must be an absolute path`,
        },
      ],
      overrideRequested: true,
    };
  }
  // Strict override: when the env var is set, that interpreter is the *only*
  // candidate. We do not fall back to PATH lookups — silently using a
  // different python would contradict the "pin" wording in docs.
  const ordered = override ? [override] : [...CANDIDATES];

  for (const candidate of ordered) {
    const resolved = path.isAbsolute(candidate) ? candidate : which(candidate);
    if (!resolved) {
      failures.push({ candidate, resolved: null, reason: "not on PATH" });
      continue;
    }
    if (tried.has(resolved)) continue;
    tried.add(resolved);

    const result = probeCandidate(candidate, resolved, probe);
    if (result.ok) {
      log(`  ${candidate} (${resolved}): version ${result.ok.version.join(".")} healthy`);
      healthy.push({ ...result.ok, candidate });
      continue;
    }
    failures.push(result.failure);
    log(`  ${candidate} (${resolved}): ${result.failure.reason}`);
  }

  return {
    ok: healthy[0] ?? null,
    healthy,
    failures,
    overrideRequested: override.length > 0,
  };
}

function probeCandidate(
  candidate: string,
  resolved: string,
  probe: NonNullable<PickHostPythonDeps["probe"]>,
):
  | { ok: Omit<PythonProbeOk, "candidate">; failure?: never }
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
  const version =
    Array.isArray(parsed.version) && parsed.version.length === 3 ? parsed.version : null;
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

export function formatHostPythonFailureMessage(
  failures: readonly PythonProbeFailure[],
  options: { overrideRequested?: boolean } = {},
): string {
  const ceiling = `${MAX_PYTHON_EXCLUSIVE[0]}.${MAX_PYTHON_EXCLUSIVE[1] - 1}`;
  const lines: string[] = [];
  if (options.overrideRequested) {
    lines.push(
      `${OVERRIDE_ENV_VAR} pins the Model Router interpreter, but that interpreter is not usable.`,
      `Need Python ${MIN_PYTHON_VERSION.join(".")}-${ceiling} with ${REQUIRED_STDLIB_MODULES.join(", ")} importable.`,
      "Probed:",
    );
  } else {
    lines.push(
      `No usable host Python interpreter found for Model Router.`,
      `Need Python ${MIN_PYTHON_VERSION.join(".")}-${ceiling} with ${REQUIRED_STDLIB_MODULES.join(", ")} importable.`,
      "Probed:",
    );
  }
  for (const f of failures) {
    lines.push(`  - ${f.candidate}${f.resolved ? ` (${f.resolved})` : ""}: ${f.reason}`);
  }
  if (options.overrideRequested) {
    lines.push(
      `Unset ${OVERRIDE_ENV_VAR}, or point it at an absolute path to a working python (for example /opt/homebrew/bin/python3.12).`,
    );
  } else {
    lines.push(
      "Install a supported interpreter (for example `brew install python@3.12` on macOS),",
      `or set ${OVERRIDE_ENV_VAR} to the absolute path of a known-good python.`,
    );
  }
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
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const spawnError =
    result.error instanceof Error ? `${result.error.name}: ${result.error.message}` : "";
  return {
    exit: result.status ?? -1,
    stdout,
    stderr: stderr || spawnError,
  };
}

function defaultLog(message: string): void {
  console.log(message);
}

/**
 * Prepare the Model Router venv. Iterates the priority-ordered list of probe-
 * clean host pythons and runs `python -m venv` on each; if creation fails (or
 * the venv python does not land on disk) it falls through to the next
 * candidate. Throws with the real reason — probe failures and per-candidate
 * venv failures both — when nothing produces a working venv.
 *
 * Returns the absolute path to the venv python binary on success.
 */
export function prepareModelRouterVenv(opts: {
  venvDir: string;
  log?: (message: string) => void;
  allowReplaceExisting?: boolean;
}): string {
  const log = opts.log ?? defaultLog;
  const allowReplaceExisting = opts.allowReplaceExisting ?? false;
  const { healthy, failures, overrideRequested } = pickHostPython({ log });
  if (healthy.length === 0) {
    throw new Error(formatHostPythonFailureMessage(failures, { overrideRequested }));
  }

  const venvPython = path.join(opts.venvDir, "bin", "python");
  fs.mkdirSync(path.dirname(opts.venvDir), { recursive: true });

  const venvFailures: string[] = [];
  for (const hostPython of healthy) {
    log(`  Preparing Model Router environment: ${opts.venvDir} (using ${hostPython.executable})`);
    const existedBefore = fs.existsSync(opts.venvDir);
    if (existedBefore && !allowReplaceExisting) {
      const detail =
        `refusing to replace existing Model Router virtual environment directory ${opts.venvDir}; ` +
        "remove it first, choose an empty NEMOCLAW_MODEL_ROUTER_VENV path, or unset NEMOCLAW_MODEL_ROUTER_VENV";
      venvFailures.push(`  - ${hostPython.executable}: ${detail}`);
      log(`  ${hostPython.executable}: ${detail}`);
      break;
    }
    // Remove only directories the caller has identified as owned by NemoClaw,
    // or partial venvs created by an earlier failed candidate in this call.
    if (fs.existsSync(opts.venvDir)) {
      fs.rmSync(opts.venvDir, { recursive: true, force: true });
    }
    // Spawn the absolute path so a PATH race between probe and use cannot
    // substitute a different interpreter.
    const venvResult = run([hostPython.executable, "-m", "venv", opts.venvDir], {
      ignoreError: true,
      timeout: 120_000,
    });
    if (venvResult.status === 0 && fs.existsSync(venvPython)) {
      return venvPython;
    }
    const stderrTail = (venvResult.stderr?.toString("utf-8") || "")
      .trim()
      .split("\n")
      .slice(-3)
      .join("\n");
    const detail = stderrTail || `venv exit ${venvResult.status}`;
    venvFailures.push(`  - ${hostPython.executable}: ${detail}`);
    log(`  ${hostPython.executable}: venv creation failed (${detail.split("\n")[0]})`);
    if (fs.existsSync(opts.venvDir)) {
      fs.rmSync(opts.venvDir, { recursive: true, force: true });
    }
  }

  // Preserve the probe-stage failures alongside the venv-stage failures so the
  // user sees every reason NemoClaw rejected an interpreter, not just the
  // venv-step reasons from the candidates that made it past the probe.
  const lines = ["Failed to create Model Router virtual environment with any healthy host Python."];
  if (failures.length > 0) {
    lines.push("Probe-stage failures:");
    for (const f of failures) {
      lines.push(`  - ${f.candidate}${f.resolved ? ` (${f.resolved})` : ""}: ${f.reason}`);
    }
  }
  lines.push("Venv-stage failures:", ...venvFailures);
  throw new Error(lines.join("\n"));
}
