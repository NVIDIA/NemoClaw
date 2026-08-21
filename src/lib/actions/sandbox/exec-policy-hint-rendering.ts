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

/**
 * Literal placeholder for the request the operator must choose. NemoClaw cannot
 * correlate a pending request with the failed command, the expected device, or
 * an acceptable scope set, so it never resolves this to a concrete id: naming
 * one would present an unrelated `operator.admin` request as this command's
 * remedy and turn the operator into a confused deputy. The operator reads the
 * id from `devices list` and decides.
 */
export const SCOPE_UPGRADE_REQUEST_PLACEHOLDER = "<requestId>";

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
 * Whether `openclaw devices list --json` reports at least one pending request.
 * This is a presence check only. No field of the payload is read, so nothing
 * from the sandbox reaches the rendered hint.
 */
export function hasPendingDeviceRequest(devicesListOutput: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(devicesListOutput);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const pending = (parsed as { pending?: unknown }).pending;
  return Array.isArray(pending) && pending.length > 0;
}

/**
 * Render the review stanza for a gateway scope upgrade waiting on approval.
 * The approve line carries the literal placeholder, never a resolved id; see
 * SCOPE_UPGRADE_REQUEST_PLACEHOLDER.
 */
export function buildScopeUpgradeExecHint(cliName: string, rawSandboxName: string): string {
  const sandboxName = displaySandboxName(rawSandboxName);
  return [
    `${cliName}: a device scope upgrade is waiting for approval inside sandbox '${sandboxName}'.`,
    "  The OpenClaw gateway refused the command until the requested scopes are approved.",
    `  Review pending requests: ${cliName} ${sandboxName} exec -- openclaw devices list`,
    `  Approve the one you recognize, after checking its device and requested scopes:`,
    `                           ${cliName} ${sandboxName} exec -- openclaw devices approve ${SCOPE_UPGRADE_REQUEST_PLACEHOLDER}`,
    `  Silence this hint:       export ${POLICY_HINT_SUPPRESS_ENV}=1`,
  ].join("\n");
}
