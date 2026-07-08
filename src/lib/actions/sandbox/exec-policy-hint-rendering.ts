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
    `  Review applied presets: ${cliName} ${sandboxName} policy-list`,
    `  Allow the host:         ${cliName} ${sandboxName} policy-add <preset>`,
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
