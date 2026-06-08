// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Hermes secret-boundary guards for the host-side recovery path.
//
// The Hermes startup entrypoint (agents/hermes/start.sh) already runs
// validate-env-secret-boundary.py at cold start. `sandbox recover` /
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

const HERMES_GATEWAY_PROC_PATTERN = "[h]ermes[[:space:]]+gateway([[:space:]]|$)";
const HERMES_DASHBOARD_PROC_PATTERN = "[h]ermes[[:space:]]+dashboard([[:space:]]|$)";
const HERMES_BOUNDARY_RECOVERY_LOG = "/tmp/gateway-recovery.log";

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
 * Pipe a validator invocation's stderr through `tee` so the detailed `[SECURITY]`
 * lines emitted by `validate-env-secret-boundary.py` are persisted to
 * `/tmp/gateway-recovery.log` inside the sandbox AND mirrored back onto stderr.
 * The recovery caller currently treats the command result as a boolean, so
 * without this duplication the documented `[SECURITY] Refusing Hermes startup ...`
 * line and the offending key never surface anywhere a user can inspect after
 * the sandbox recovers — failing the issue's log-acceptance clause even when
 * relaunch is correctly refused.
 *
 * SECURITY: `tee -a` to `/tmp/gateway-recovery.log` is invoked here BEFORE
 * `buildGatewayLogSetup` runs, so the log path is not pre-opened with the
 * O_NOFOLLOW helper. This is safe today because non-OpenClaw recovery runs as
 * the sandbox user over SSH; the sandbox user owns `/tmp` and cannot win a
 * symlink race with itself for files under its own control. Do not move this
 * snippet into a root-exec recovery path without first prepending an
 * O_NOFOLLOW-prepared log file via the shared no-follow helper.
 */
function buildHermesValidatorInvocation(args: string): string {
  return `python3 ${shellQuote(HERMES_SECRET_BOUNDARY_VALIDATOR_PATH)} ${args} 2> >(tee -a ${shellQuote(HERMES_BOUNDARY_RECOVERY_LOG)} >&2)`;
}

function buildHermesValidatorMissingLog(): string {
  const message = `[gateway-recovery] WARNING: secret-boundary validator script ${HERMES_SECRET_BOUNDARY_VALIDATOR_PATH} missing on this sandbox image; skipping recovery boundary check. Production images bake the validator in; older images recover without it.`;
  return `printf '%s\\n' ${shellQuote(message)} | tee -a ${shellQuote(HERMES_BOUNDARY_RECOVERY_LOG)} >&2;`;
}

// REMOVAL CONDITION: the warn-and-skip path above is fail-open by design so
// that a newer NemoClaw CLI talking to an older Hermes sandbox image still
// recovers. Once the minimum supported Hermes image (currently the
// `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base` tag tracked by the production
// Dockerfile) is guaranteed to bake the validator in, flip the missing-file
// branch to fail-closed (kill + `echo SECRET_BOUNDARY_VALIDATOR_MISSING; exit
// 1;`) and update `runtime-hermes-secret-boundary-behavioural.test.ts` to
// assert the refusal. Track the cutoff against the base-image version pinned
// in `agents/hermes/Dockerfile`.

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
 * Older sandbox images that do not yet bake the validator in fall through with
 * a `[gateway-recovery] WARNING` line and the recovery proceeds, so a partial
 * image upgrade does not block recovery.
 */
export function buildHermesEnvFileBoundaryGuard(): string {
  const validator = HERMES_SECRET_BOUNDARY_VALIDATOR_PATH;
  const kill = buildHermesBoundaryKillSnippet();
  const missingLog = buildHermesValidatorMissingLog();
  const invocation = buildHermesValidatorInvocation("env-file /sandbox/.hermes/.env");
  return `if [ ! -f ${shellQuote(validator)} ]; then ${missingLog} elif ! ${invocation}; then ${kill} echo SECRET_BOUNDARY_REFUSED; exit 1; fi;`;
}

/**
 * Build the shell snippet that runs the Hermes runtime-env boundary validator
 * against the recovery shell's environment. Wire this in AFTER any preload env
 * file (e.g. `/tmp/nemoclaw-proxy-env.sh`) has been sourced and BEFORE the
 * launch command, so the final environment the relaunched gateway will inherit
 * is the one checked.
 *
 * Same semantics as the env-file guard: fail-closed when the validator runs and
 * refuses (kill + refuse + exit), warning-skip when the validator script is
 * absent from an older image.
 */
export function buildHermesRuntimeEnvBoundaryGuard(): string {
  const validator = HERMES_SECRET_BOUNDARY_VALIDATOR_PATH;
  const kill = buildHermesBoundaryKillSnippet();
  const missingLog = buildHermesValidatorMissingLog();
  const invocation = buildHermesValidatorInvocation("runtime-env");
  return `if [ ! -f ${shellQuote(validator)} ]; then ${missingLog} elif ! ${invocation}; then ${kill} echo SECRET_BOUNDARY_REFUSED; exit 1; fi;`;
}

export const __testing = {
  buildHermesEnvFileBoundaryGuard,
  buildHermesRuntimeEnvBoundaryGuard,
  buildHermesBoundaryKillSnippet,
  HERMES_GATEWAY_PROC_PATTERN,
  HERMES_DASHBOARD_PROC_PATTERN,
  HERMES_BOUNDARY_RECOVERY_LOG,
};
