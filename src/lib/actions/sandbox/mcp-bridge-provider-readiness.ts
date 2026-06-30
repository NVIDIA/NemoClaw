// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

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

const MCP_CREDENTIAL_SNAPSHOT_PATH_RE = /^\/tmp\/nemoclaw-mcp-provider-sync-[0-9a-f-]{36}$/;

function validateMcpCredentialSnapshotPath(snapshotPath: string): void {
  if (!MCP_CREDENTIAL_SNAPSHOT_PATH_RE.test(snapshotPath)) {
    throw new McpBridgeError("Invalid MCP credential revision snapshot path.");
  }
}

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
    '  case "$revision" in ""|*[!0-9]*) return 1 ;; *) return 0 ;; esac',
    "}",
  ];
}

/**
 * Capture only a validated OpenShell placeholder in a descriptor opened with
 * noclobber. Raw environment values are never written or printed. The file is
 * used solely to compare the supervisor's provider revision across fresh execs.
 */
export function buildMcpCredentialRevisionSnapshotCommand(
  envName: string,
  snapshotPath: string,
): string {
  validateMcpCredentialSnapshotPath(snapshotPath);
  return [
    ...mcpCredentialPlaceholderValidatorShell(envName),
    `snapshot=${shellQuote(snapshotPath)}`,
    "umask 077",
    "set -C",
    'exec 3>"$snapshot" || exit 1',
    "set +C",
    `value="\${${envName}-}"`,
    'if [ -n "$value" ]; then',
    '  valid_placeholder "$value" || exit 1',
    '  printf "%s" "$value" >&3',
    "fi",
  ].join("\n");
}

export function buildMcpCredentialReadinessCommand(
  envName: string,
  previousRevisionSnapshotPath?: string,
): string {
  if (previousRevisionSnapshotPath) {
    validateMcpCredentialSnapshotPath(previousRevisionSnapshotPath);
  }
  return [
    ...mcpCredentialPlaceholderValidatorShell(envName),
    `value="\${${envName}-}"`,
    'valid_placeholder "$value" || exit 1',
    ...(previousRevisionSnapshotPath
      ? [
          `snapshot=${shellQuote(previousRevisionSnapshotPath)}`,
          '[ -f "$snapshot" ] && [ ! -L "$snapshot" ] || exit 1',
          'prior="$(cat -- "$snapshot")" || exit 1',
          '[ -z "$prior" ] || valid_placeholder "$prior" || exit 1',
          '[ -z "$prior" ] || [ "$value" != "$prior" ] || exit 1',
        ]
      : []),
  ].join("\n");
}

export function snapshotMcpCredentialRevision(sandboxName: string, entry: McpBridgeEntry): string {
  assertAuthenticatedBridgeEntry(entry);
  const snapshotPath = `/tmp/nemoclaw-mcp-provider-sync-${crypto.randomUUID()}`;
  const result = executeMcpCredentialProofCommand(
    sandboxName,
    buildMcpCredentialRevisionSnapshotCommand(entry.env[0], snapshotPath),
  );
  if (!result || result.status !== 0) {
    throw new McpBridgeError(
      `Could not capture the current OpenShell credential revision for sandbox '${sandboxName}'.`,
    );
  }
  return snapshotPath;
}

export function removeMcpCredentialRevisionSnapshot(
  sandboxName: string,
  snapshotPath: string | undefined,
): void {
  if (!snapshotPath) return;
  validateMcpCredentialSnapshotPath(snapshotPath);
  executeSandboxExecCommand(sandboxName, `rm -f -- ${shellQuote(snapshotPath)}`);
}

export function waitForAttachedMcpCredential(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: { previousRevisionSnapshotPath?: string } = {},
): void {
  assertAuthenticatedBridgeEntry(entry);
  const envName = entry.env[0];
  const timeoutSeconds = Number.parseInt(
    process.env.NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS ?? "30",
    10,
  );
  const ready = waitUntil(
    () => {
      // Each exec is a fresh OpenShell process. A status-zero comparison proves
      // the supervisor has consumed the provider_env_revision without ever
      // printing either a placeholder or a credential value.
      const probe = executeMcpCredentialProofCommand(
        sandboxName,
        buildMcpCredentialReadinessCommand(envName, options.previousRevisionSnapshotPath),
      );
      return probe?.status === 0;
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
