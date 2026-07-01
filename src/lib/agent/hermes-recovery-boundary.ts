// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Hermes secret-boundary guards for the host-side recovery path.
//
// The Hermes startup entrypoint (agents/hermes/start.sh) already runs
// validate-hermes-env-secret-boundary.py at cold start. `sandbox recover` /
// `connect --probe-only` does NOT re-enter that entrypoint — it spawns a
// recovery shell directly. The helpers in this file emit shell snippets that
// re-run the same validator from the recovery shell so the documented secret
// boundary applies on every relaunch path: gateway recovery, dashboard-only
// recovery, and the manual copy-paste command surfaced when automatic recovery
// fails.
//
// Kept in its own module so this security-sensitive shell generation does not
// continue to grow agent/runtime.ts and so the regression-test surface stays
// focused. runtime.ts imports the public guards; tests exercise both the
// generated shell shape and the live shell execution against stubbed binaries.

import { shellQuote } from "../runner";

export const HERMES_SECRET_BOUNDARY_VALIDATOR_PATH =
  "/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py";

// Trusted absolute paths for the python3 interpreter that runs the validator,
// ordered most-preferred first. The picker selects the first executable match
// (first-wins) so the recovery path picks the same interpreter as
// `agents/hermes/hermes-wrapper.py:_TRUSTED_PYTHON3` and
// `agents/hermes/start.sh:resolve_trusted_python3` when several are present.
// Mirroring the wrapper's list also prevents an attacker who controls PATH in
// the recovery shell from bypassing the validator — bare `python3` would
// resolve via PATH and could be shadowed. Venv first matches the security
// principle of preferring the most controlled environment; fall back to
// system python3 when the sandbox image has no venv yet.
const HERMES_TRUSTED_PYTHON3_PATHS = [
  "/opt/hermes/.venv/bin/python3",
  "/usr/local/bin/python3",
  "/usr/bin/python3",
];

export const SECRET_BOUNDARY_REFUSED_MARKER = "SECRET_BOUNDARY_REFUSED";
export const SECRET_BOUNDARY_OK_MARKER = "SECRET_BOUNDARY_OK";
export const SECRET_BOUNDARY_VALIDATOR_MISSING_MARKER = "SECRET_BOUNDARY_VALIDATOR_MISSING";
export const SECRET_BOUNDARY_PYTHON3_MISSING_MARKER = "SECRET_BOUNDARY_PYTHON3_MISSING";

function buildTrustedPython3Picker(): string {
  // Emit a single `case` block that selects the first executable candidate
  // from HERMES_TRUSTED_PYTHON3_PATHS (first-wins, most-preferred first) so
  // the wrapper, start.sh, and this recovery snippet pick the same
  // interpreter when several are present.
  const branches = HERMES_TRUSTED_PYTHON3_PATHS.map(
    (candidate) =>
      `if [ -z "\${_NEMOCLAW_PYTHON3:-}" ] && [ -x ${shellQuote(candidate)} ]; then _NEMOCLAW_PYTHON3=${shellQuote(candidate)}; fi;`,
  ).join(" ");
  return `unset _NEMOCLAW_PYTHON3; ${branches}`;
}

function buildTrustedPython3Guard(): string {
  return `if [ -z "\${_NEMOCLAW_PYTHON3:-}" ]; then echo '[SECURITY] no python3 at a trusted absolute path' >&2; echo ${SECRET_BOUNDARY_PYTHON3_MISSING_MARKER}; exit 127; fi;`;
}

const HERMES_GATEWAY_PROC_PATTERN = "[h]ermes[[:space:]]+gateway([[:space:]]|$)";
const HERMES_DASHBOARD_PROC_PATTERN = "[h]ermes[[:space:]]+dashboard([[:space:]]|$)";
const HERMES_BOUNDARY_RECOVERY_LOG = "/tmp/gateway-recovery.log";

// Append-tee helper that opens the destination log with `O_NOFOLLOW`. Coreutils
// `tee -a` cannot pass that flag, so a symlink swapped in at the log path
// during the TOCTOU window between the `[ -L ... ]` precheck and the
// validator's first stderr line would let an attacker redirect the
// validator's `[SECURITY]` output to an attacker-chosen file. Running this
// through the same trusted python3 the picker resolved makes the open()
// itself reject the symlink atomically; if it does, the helper still
// streams stdin to stdout so the user-facing `[SECURITY]` lines surface
// even when the log write is refused.
const HERMES_LOG_TEE_NOFOLLOW_PYTHON = `import os, sys
src = sys.stdin.buffer
out = sys.stdout.buffer
err = sys.stderr.buffer
log_fd = -1
try:
    log_fd = os.open(sys.argv[1], os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
except OSError as exc:
    err.write(f"[SECURITY] Refusing recovery log write to {sys.argv[1]}: {exc.strerror}\\n".encode("utf-8", "replace"))
    err.flush()
while True:
    chunk = src.read(4096)
    if not chunk:
        break
    if log_fd >= 0:
        try:
            os.write(log_fd, chunk)
        except OSError:
            log_fd = -1
    out.write(chunk)
    out.flush()
if log_fd >= 0:
    os.close(log_fd)
`;

function buildLogTeeNoFollow(): string {
  return `"$_NEMOCLAW_PYTHON3" -I -c ${shellQuote(HERMES_LOG_TEE_NOFOLLOW_PYTHON)} ${shellQuote(HERMES_BOUNDARY_RECOVERY_LOG)}`;
}

function buildHermesBoundaryKillSnippet(): string {
  return [
    `pkill -TERM -f ${shellQuote(HERMES_GATEWAY_PROC_PATTERN)} 2>/dev/null || true;`,
    `pkill -TERM -f ${shellQuote(HERMES_DASHBOARD_PROC_PATTERN)} 2>/dev/null || true;`,
    "sleep 1;",
    `pkill -KILL -f ${shellQuote(HERMES_GATEWAY_PROC_PATTERN)} 2>/dev/null || true;`,
    `pkill -KILL -f ${shellQuote(HERMES_DASHBOARD_PROC_PATTERN)} 2>/dev/null || true;`,
  ].join(" ");
}

/**
 * Pipe a validator invocation's stderr through an O_NOFOLLOW append-tee so the
 * detailed `[SECURITY]` lines emitted by `validate-hermes-env-secret-boundary.py`
 * are persisted to `/tmp/gateway-recovery.log` inside the sandbox AND mirrored
 * back onto stderr. The recovery caller currently treats the command result as
 * a boolean, so without this duplication the documented
 * `[SECURITY] Refusing Hermes startup ...` line and the offending key never
 * surface anywhere a user can inspect after the sandbox recovers — failing the
 * issue's log-acceptance clause even when relaunch is correctly refused.
 *
 * SECURITY: coreutils `tee -a` cannot itself open the log file with
 * `O_NOFOLLOW`, so a symlink swapped in at the log path could redirect the
 * validator's `[SECURITY]` lines to an attacker-chosen file. The replacement
 * helper runs the trusted python3 the picker resolved and opens the log with
 * `O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW`; the kernel refuses to follow a
 * symlink at the final path component, closing the TOCTOU race the
 * `[ -L ... ]` precheck alone could not. The `[ -L ... ]` check is retained
 * as a fast-fail with a specific message so the refusal stays observable in
 * tests and surfaces a clear cause for users.
 */
function buildRecoveryLogSymlinkGuard(): string {
  return `if [ -L ${shellQuote(HERMES_BOUNDARY_RECOVERY_LOG)} ]; then echo '[SECURITY] Refusing Hermes recovery: ${HERMES_BOUNDARY_RECOVERY_LOG} is a symlink' >&2; exit 1; fi;`;
}

function buildHermesValidatorInvocation(args: string): string {
  return `"$_NEMOCLAW_PYTHON3" -I ${shellQuote(HERMES_SECRET_BOUNDARY_VALIDATOR_PATH)} ${args} 2> >(${buildLogTeeNoFollow()} >&2)`;
}

function buildHermesValidatorMissingLog(): string {
  const message = `[gateway-recovery] REFUSING: secret-boundary validator script ${HERMES_SECRET_BOUNDARY_VALIDATOR_PATH} is missing on this sandbox image; recovery cannot verify /sandbox/.hermes/.env. Re-image the sandbox with a current Hermes build.`;
  return `printf '%s\\n' ${shellQuote(message)} | ${buildLogTeeNoFollow()} >&2;`;
}

// Missing-validator recovery is fail-closed: the host CLI cannot prove the
// Hermes entrypoint's env-file boundary without this source validator, so older
// images must be re-imaged before gateway/dashboard recovery can proceed.

/**
 * Build the shell snippet that re-runs the documented Hermes secret-boundary
 * check against `/sandbox/.hermes/.env` before any in-sandbox Hermes process is
 * relaunched. The startup entrypoint already runs this validator, but
 * `sandbox recover` / `connect --probe-only` does not re-enter the entrypoint,
 * so without this guard the boundary would only apply on cold start.
 *
 * Fail-closed when the validator runs and refuses: kill any currently-running
 * Hermes gateway and dashboard so `/health` cannot keep answering with the
 * poisoned configuration, emit `SECRET_BOUNDARY_REFUSED` on stdout, and exit 1.
 * The validator's detailed `[SECURITY]` lines are appended to
 * `/tmp/gateway-recovery.log` so a user inspecting the sandbox after a refused
 * recovery can identify the offending key.
 *
 * Older sandbox images that do not yet bake the validator fail closed with a
 * re-image message, so recovery never reports success without re-checking the
 * documented env-file secret boundary.
 */
export function buildHermesEnvFileBoundaryGuard(): string {
  const validator = HERMES_SECRET_BOUNDARY_VALIDATOR_PATH;
  const kill = buildHermesBoundaryKillSnippet();
  const missingLog = buildHermesValidatorMissingLog();
  const picker = buildTrustedPython3Picker();
  const pythonGuard = buildTrustedPython3Guard();
  const symlinkGuard = buildRecoveryLogSymlinkGuard();
  const invocation = buildHermesValidatorInvocation("env-file /sandbox/.hermes/.env");
  return `${symlinkGuard} ${picker} ${pythonGuard} if [ ! -f ${shellQuote(validator)} ]; then ${missingLog} ${kill} echo SECRET_BOUNDARY_VALIDATOR_MISSING; exit 1; elif ! ${invocation}; then ${kill} echo SECRET_BOUNDARY_REFUSED; exit 1; fi;`;
}

/**
 * Build the shell snippet that runs the Hermes runtime-env boundary validator
 * against the recovery shell's environment. Wire this in AFTER any preload env
 * file (e.g. `/tmp/nemoclaw-proxy-env.sh`) has been sourced and BEFORE the
 * launch command, so the final environment the relaunched gateway will inherit
 * is the one checked.
 *
 * Same semantics as the env-file guard: fail-closed when the validator runs and
 * refuses, and fail-closed when the validator script is absent from an older
 * image.
 */
export function buildHermesRuntimeEnvBoundaryGuard(): string {
  const validator = HERMES_SECRET_BOUNDARY_VALIDATOR_PATH;
  const kill = buildHermesBoundaryKillSnippet();
  const missingLog = buildHermesValidatorMissingLog();
  const picker = buildTrustedPython3Picker();
  const pythonGuard = buildTrustedPython3Guard();
  const symlinkGuard = buildRecoveryLogSymlinkGuard();
  const invocation = buildHermesValidatorInvocation("runtime-env");
  return `${symlinkGuard} ${picker} ${pythonGuard} if [ ! -f ${shellQuote(validator)} ]; then ${missingLog} ${kill} echo SECRET_BOUNDARY_VALIDATOR_MISSING; exit 1; elif ! ${invocation}; then ${kill} echo SECRET_BOUNDARY_REFUSED; exit 1; fi;`;
}

/**
 * Build a standalone shell snippet that evaluates the Hermes env-file
 * secret-boundary contract without relaunching anything. Intended for the
 * `sandbox recover` / `connect --probe-only` probe path, where the gateway
 * is already running and the relaunch script is not reached: the host can
 * exec this snippet inside the sandbox, parse the marker on stdout, and
 * decide whether to refuse the probe.
 *
 * Marker contract on stdout (one of):
 *   - `SECRET_BOUNDARY_OK` — validator ran and accepted the env file.
 *   - `SECRET_BOUNDARY_REFUSED` — validator ran and refused; the snippet
 *     killed any running gateway/dashboard process before exiting non-zero.
 *   - `SECRET_BOUNDARY_VALIDATOR_MISSING` — validator script absent on this
 *     sandbox image; the snippet killed gateway/dashboard processes and exits
 *     non-zero so the caller can refuse recovery.
 *
 * Validator stderr (`[SECURITY] …` lines) is left on the exec command's
 * stderr; the caller surfaces it directly. This keeps the snippet
 * independent of any `/tmp/gateway-recovery.log` setup, which matters when
 * the snippet runs via `openshell sandbox exec` (root) rather than the
 * sandbox-user SSH recovery shell that the relaunch path uses.
 *
 * The kill snippet is intentionally invoked from a context the caller
 * arranges to have authority over: a sandbox-user SSH shell cannot signal
 * gateway-user processes (test/e2e-gateway-isolation.sh test 13), so a
 * refusal that did not also bring the listener down would log a refusal
 * while `/health` kept serving. Run this via the root sandbox-exec path so
 * the kill has authority.
 */
export function buildHermesEnvFileBoundaryStandaloneCheck(): string {
  const validator = HERMES_SECRET_BOUNDARY_VALIDATOR_PATH;
  const kill = buildHermesBoundaryKillSnippet();
  const picker = buildTrustedPython3Picker();
  const pythonGuard = buildTrustedPython3Guard();
  const invocation = `"$_NEMOCLAW_PYTHON3" -I ${shellQuote(validator)} env-file /sandbox/.hermes/.env`;
  return [
    picker,
    pythonGuard,
    `if [ ! -f ${shellQuote(validator)} ]; then`,
    `  ${kill}`,
    `  echo ${SECRET_BOUNDARY_VALIDATOR_MISSING_MARKER};`,
    `  exit 1;`,
    `fi;`,
    `if ${invocation}; then`,
    `  echo ${SECRET_BOUNDARY_OK_MARKER}; exit 0;`,
    `else`,
    `  ${kill}`,
    `  echo ${SECRET_BOUNDARY_REFUSED_MARKER};`,
    `  exit 1;`,
    `fi;`,
  ].join("\n");
}

export const __testing = {
  buildHermesEnvFileBoundaryGuard,
  buildHermesRuntimeEnvBoundaryGuard,
  buildHermesEnvFileBoundaryStandaloneCheck,
  buildHermesBoundaryKillSnippet,
  HERMES_GATEWAY_PROC_PATTERN,
  HERMES_DASHBOARD_PROC_PATTERN,
  HERMES_BOUNDARY_RECOVERY_LOG,
};
