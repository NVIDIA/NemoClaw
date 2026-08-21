// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../../name-validation";

/** Opt-out env var, shared with the connect-shell breadcrumb stanza. */
export const POLICY_HINT_SUPPRESS_ENV = "NEMOCLAW_NO_POLICY_HINT";

function displaySandboxName(sandboxName: string): string {
  const valid = sandboxName.length <= NAME_MAX_LENGTH && NAME_VALID_PATTERN.test(sandboxName);
  return valid ? sandboxName : "<name>";
}

/** Render the concise, denial-adjacent stderr hint. */
export function buildPolicyDenialExecHint(
  cliName: string,
  rawSandboxName: string,
  endpoint: string | null,
): string {
  const sandboxName = displaySandboxName(rawSandboxName);
  const target = endpoint ? ` for ${endpoint}` : "";
  return [
    `${cliName}: recent network policy denial detected${target} inside sandbox '${sandboxName}'.`,
    "  The sandbox's egress policy blocked this request; the tool above only saw the proxy's 403.",
    `  See the denied flow:    ${cliName} ${sandboxName} logs --tail 50`,
    `  Review applied presets: ${cliName} ${sandboxName} policy list`,
    `  Allow the host:         ${cliName} ${sandboxName} policy add <preset>`,
    `  Silence this hint:      export ${POLICY_HINT_SUPPRESS_ENV}=1`,
  ].join("\n");
}

/**
 * Whether a policy-denial probe is warranted after an exec. Successful
 * commands, transport failures, and user-suppressed hints skip all log I/O.
 */
export function shouldProbePolicyDenial(
  commandCode: number,
  hadInvocationError: boolean,
  env: NodeJS.ProcessEnv,
): boolean {
  if (commandCode === 0 || hadInvocationError) return false;
  const suppress = env[POLICY_HINT_SUPPRESS_ENV]?.toLowerCase();
  return !suppress || suppress === "0" || suppress === "false";
}

/** Placeholder used when the pending request cannot be named exactly. */
export const SCOPE_UPGRADE_REQUEST_PLACEHOLDER = "<requestId>";

// Matches the request-id shape OpenClaw publishes in pending.json and echoes in
// the failure text. Kept permissive on charset but strictly bounded so a hostile
// devices-list payload cannot smuggle shell metacharacters into the printed
// remedy line.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Whether the exec'd command was OpenClaw itself, the only scope-gated case. */
export function execCommandTargetsOpenClaw(command: readonly string[]): boolean {
  const executable = command[0];
  if (!executable) return false;
  return executable.split("/").pop() === "openclaw";
}

/**
 * Whether a pending-scope-upgrade probe is warranted after an exec. Reuses the
 * denial gate and adds the OpenClaw-command prefilter so ordinary in-sandbox
 * command failures cost no extra round trip.
 */
export function shouldProbeScopeUpgrade(
  commandCode: number,
  hadInvocationError: boolean,
  command: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  if (!execCommandTargetsOpenClaw(command)) return false;
  return shouldProbePolicyDenial(commandCode, hadInvocationError, env);
}

/**
 * Extract the single pending request id from `openclaw devices list --json`.
 * Returns the placeholder when a pending request exists but cannot be named
 * unambiguously, and null when nothing is pending.
 */
export function findPendingScopeUpgradeRequestId(devicesListOutput: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(devicesListOutput);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const pending = (parsed as { pending?: unknown }).pending;
  if (!Array.isArray(pending) || pending.length === 0) return null;
  if (pending.length > 1) return SCOPE_UPGRADE_REQUEST_PLACEHOLDER;
  const entry = pending[0];
  if (typeof entry !== "object" || entry === null) return SCOPE_UPGRADE_REQUEST_PLACEHOLDER;
  const requestId = (entry as { requestId?: unknown }).requestId;
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    return SCOPE_UPGRADE_REQUEST_PLACEHOLDER;
  }
  return requestId;
}

/** Render the remedy stanza for a gateway scope upgrade waiting on approval. */
export function buildScopeUpgradeExecHint(
  cliName: string,
  rawSandboxName: string,
  requestId: string,
): string {
  const sandboxName = displaySandboxName(rawSandboxName);
  return [
    `${cliName}: a device scope upgrade is waiting for approval inside sandbox '${sandboxName}'.`,
    "  The OpenClaw gateway refused the command until the requested scopes are approved.",
    `  Review pending requests: ${cliName} ${sandboxName} exec -- openclaw devices list`,
    `  Approve the request:     ${cliName} ${sandboxName} exec -- openclaw devices approve ${requestId}`,
    `  Silence this hint:       export ${POLICY_HINT_SUPPRESS_ENV}=1`,
  ].join("\n");
}
