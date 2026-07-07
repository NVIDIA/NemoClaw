// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { waitUntil } from "../../core/wait";
import { shellQuote } from "../../runner";
import type { McpBridgeEntry } from "../../state/registry";
import { McpBridgeError } from "./mcp-bridge-contracts";
import {
  assertAuthenticatedBridgeEntry,
  assertPersistedAuthenticatedBridgeEntry,
  validateMcpCredentialEnvName,
} from "./mcp-bridge-validation";
import { executeSandboxExecCommand } from "./process-recovery";

const MCP_CREDENTIAL_REVISION_OBSERVATION_RE = /^(?:absent|canonical|v[0-9]{1,20})$/;

export type McpCredentialRevisionObservation = "absent" | "canonical" | `v${number}`;

/**
 * Provider synchronization proofs must observe a fresh OpenShell-mediated exec
 * environment. A direct Docker exec does not receive OpenShell provider state
 * and could otherwise make an absent credential look successfully revoked.
 */
function executeMcpCredentialProofCommand(
  sandboxName: string,
  command: string,
): ReturnType<typeof executeSandboxExecCommand> {
  // OpenShell current main rejects CR/LF in each sandbox-exec argv element.
  // Transport the proof as base64 so the `sh -c` argument remains one line;
  // the decoded script still runs only inside the sandbox and contains no raw
  // credential value.
  const encodedCommand = Buffer.from(command, "utf8").toString("base64");
  const transportCommand = [
    "command -v base64 >/dev/null 2>&1 || { echo NEMOCLAW_BASE64_MISSING >&2; exit 127; }",
    `decoded="$(printf '%s' '${encodedCommand}' | base64 -d)" || exit 1`,
    `printf '%s' "$decoded" | sh`,
  ].join("; ");
  return executeSandboxExecCommand(sandboxName, transportCommand, undefined, {
    allowLocalDockerFallback: false,
  });
}

function mcpCredentialPlaceholderValidatorShell(envName: string): string[] {
  validateMcpCredentialEnvName(envName);
  const canonical = `openshell:resolve:env:${envName}`;
  const revisionPrefix = "openshell:resolve:env:v";
  const revisionSuffix = `_${envName}`;
  return [
    `canonical=${shellQuote(canonical)}`,
    `prefix=${shellQuote(revisionPrefix)}`,
    `suffix=${shellQuote(revisionSuffix)}`,
    "valid_placeholder() {",
    '  candidate="$1"',
    '  [ "$candidate" = "$canonical" ] && return 0',
    '  versioned="${candidate#"$prefix"}"',
    '  [ "$versioned" != "$candidate" ] || return 1',
    '  revision="${versioned%"$suffix"}"',
    '  [ "$revision" != "$versioned" ] || return 1',
    '  [ "$versioned" = "$revision$suffix" ] || return 1',
    '  case "$revision" in ""|*[!0-9]*) return 1 ;; esac',
    '  [ "${#revision}" -le 20 ] || return 1',
    "}",
  ];
}

/**
 * Emit only a bounded classification of the OpenShell placeholder observed by
 * a fresh exec. Raw environment values are never written or printed. Keeping
 * the observation on stdout lets the trusted host compare revisions without
 * relying on sandbox-writable state.
 */
export function buildMcpCredentialRevisionObservationCommand(envName: string): string {
  return [
    ...mcpCredentialPlaceholderValidatorShell(envName),
    `if [ -z "\${${envName}+x}" ]; then`,
    "  printf '%s\\n' absent",
    "  exit 0",
    "fi",
    `value="\${${envName}}"`,
    'valid_placeholder "$value" || exit 1',
    'if [ "$value" = "$canonical" ]; then',
    "  printf '%s\\n' canonical",
    "  exit 0",
    "fi",
    'versioned="${value#"$prefix"}"',
    'revision="${versioned%"$suffix"}"',
    "printf 'v%s\\n' \"$revision\"",
  ].join("\n");
}

function parseMcpCredentialRevisionObservation(
  output: string,
): McpCredentialRevisionObservation | null {
  const observation = output.trim();
  return MCP_CREDENTIAL_REVISION_OBSERVATION_RE.test(observation)
    ? (observation as McpCredentialRevisionObservation)
    : null;
}

function tryObserveMcpCredentialRevision(
  sandboxName: string,
  envName: string,
): McpCredentialRevisionObservation | null {
  const result = executeMcpCredentialProofCommand(
    sandboxName,
    buildMcpCredentialRevisionObservationCommand(envName),
  );
  if (!result || result.status !== 0) return null;
  return parseMcpCredentialRevisionObservation(result.stdout);
}

export function observeMcpCredentialRevision(
  sandboxName: string,
  entry: McpBridgeEntry,
): McpCredentialRevisionObservation {
  assertAuthenticatedBridgeEntry(entry);
  const observation = tryObserveMcpCredentialRevision(sandboxName, entry.env[0]);
  if (observation === null) {
    throw new McpBridgeError(
      `Could not observe the current OpenShell credential revision for sandbox '${sandboxName}'.`,
    );
  }
  return observation;
}

export function waitForAttachedMcpCredential(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: { previousRevision?: McpCredentialRevisionObservation } = {},
): void {
  assertAuthenticatedBridgeEntry(entry);
  const envName = entry.env[0];
  if (
    options.previousRevision !== undefined &&
    !MCP_CREDENTIAL_REVISION_OBSERVATION_RE.test(options.previousRevision)
  ) {
    throw new McpBridgeError("Invalid prior MCP credential revision observation.");
  }
  const timeoutSeconds = Number.parseInt(
    process.env.NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS ?? "30",
    10,
  );
  const ready = waitUntil(
    () => {
      // Each exec is a fresh OpenShell process. Only the bounded placeholder
      // classification crosses back to the host, where the comparison cannot
      // be influenced by a same-UID sandbox process rewriting a snapshot file.
      const observation = tryObserveMcpCredentialRevision(sandboxName, envName);
      return (
        observation !== null &&
        observation !== "absent" &&
        (options.previousRevision === undefined || observation !== options.previousRevision)
      );
    },
    Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 30,
    1_000,
  );
  if (!ready) {
    throw new McpBridgeError(
      `OpenShell did not synchronize the expected credential revision for placeholder '${envName}' into sandbox '${sandboxName}' after provider attachment or update.`,
    );
  }
}

export function buildMcpCredentialDetachedCommand(envName: string): string {
  validateMcpCredentialEnvName(envName);
  return `[ -z "\${${envName}+x}" ]`;
}

export function waitForDetachedMcpCredential(sandboxName: string, entry: McpBridgeEntry): void {
  assertPersistedAuthenticatedBridgeEntry(entry);
  const envName = entry.env[0];
  try {
    validateMcpCredentialEnvName(envName);
  } catch {
    // The exact provider attachment post-state was already checked by the
    // detach operation. Do not start a fresh child under a legacy loader,
    // shell, or compatibility env name merely to repeat that proof.
    return;
  }
  const timeoutSeconds = Number.parseInt(
    process.env.NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS ?? "30",
    10,
  );
  const revoked = waitUntil(
    () =>
      executeMcpCredentialProofCommand(sandboxName, buildMcpCredentialDetachedCommand(envName))
        ?.status === 0,
    Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 30,
    1_000,
  );
  if (!revoked) {
    throw new McpBridgeError(
      `OpenShell did not confirm credential '${envName}' was revoked from fresh execs in sandbox '${sandboxName}' after detach. Preserving MCP policy and ownership state.`,
    );
  }
}
