// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../runner";
import type { McpBridgeEntry } from "../../state/registry";
import { McpBridgeError } from "./mcp-bridge-contracts";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import { waitForMcpBridgeCondition } from "./mcp-bridge/timing";
import {
  assertAuthenticatedBridgeEntry,
  assertPersistedAuthenticatedBridgeEntry,
  validateMcpCredentialEnvName,
} from "./mcp-bridge-validation";
import { executeSandboxExecCommand } from "./process-recovery";

const MCP_CREDENTIAL_REVISION_OBSERVATION_RE = /^(?:absent|canonical|v[0-9]{1,20})$/;

export type McpCredentialRevisionObservation = "absent" | "canonical" | `v${number}`;
export type McpAttachedCredentialRevision = Exclude<
  McpCredentialRevisionObservation,
  "absent" | "canonical"
>;

export function mcpAdapterCredentialRevisionUnavailableError(server: string): McpBridgeError {
  return new McpBridgeError(
    `OpenShell did not expose a revision-scoped credential while reconciling MCP adapter '${server}'.`,
  );
}

export function mcpAdapterCredentialRevisionUnstableError(server: string): McpBridgeError {
  return new McpBridgeError(
    `OpenShell credential revision did not stabilize while reconciling MCP adapter '${server}'.`,
  );
}

type McpCredentialRevisionAttempt =
  | { kind: "observation"; observation: McpCredentialRevisionObservation }
  | { kind: "transport-unavailable" }
  | { kind: "command-failed"; status: number }
  | { kind: "invalid-output" };

/**
 * Provider synchronization proofs must observe a fresh OpenShell-mediated exec
 * environment. A direct Docker exec does not receive OpenShell provider state
 * and could otherwise make an absent credential look successfully revoked.
 */
function executeMcpCredentialProofCommand(
  sandboxName: string,
  command: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): ReturnType<typeof executeSandboxExecCommand> {
  // OpenShell preserves the proof as one multiline command argument. The
  // script classifies placeholder shape/revision only and never prints a raw
  // credential value or writes sandbox state.
  return executeSandboxExecCommand(sandboxName, command, undefined, {
    allowLocalDockerFallback: false,
    runtimeSelection,
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
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): McpCredentialRevisionAttempt {
  const result = executeMcpCredentialProofCommand(
    sandboxName,
    buildMcpCredentialRevisionObservationCommand(envName),
    runtimeSelection,
  );
  if (!result) return { kind: "transport-unavailable" };
  if (result.status !== 0) return { kind: "command-failed", status: result.status };
  const observation = parseMcpCredentialRevisionObservation(result.stdout);
  return observation === null ? { kind: "invalid-output" } : { kind: "observation", observation };
}

function describeMcpCredentialRevisionAttempt(attempt: McpCredentialRevisionAttempt): string {
  switch (attempt.kind) {
    case "observation":
      return attempt.observation;
    case "transport-unavailable":
      return "transport-unavailable";
    case "command-failed":
      return `proof-command-exit-${attempt.status}`;
    case "invalid-output":
      return "invalid-bounded-output";
  }
}

export function observeMcpCredentialRevision(
  sandboxName: string,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): McpCredentialRevisionObservation {
  assertAuthenticatedBridgeEntry(entry);
  const attempt = tryObserveMcpCredentialRevision(sandboxName, entry.env[0], runtimeSelection);
  if (attempt.kind !== "observation") {
    throw new McpBridgeError(
      `Could not observe the current OpenShell credential revision for sandbox '${sandboxName}'.`,
    );
  }
  return attempt.observation;
}

export function waitForAttachedMcpCredential(
  sandboxName: string,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  options: {
    previousRevision?: McpCredentialRevisionObservation;
    refreshAfterObservedAbsence?: () => void;
  } = {},
): McpAttachedCredentialRevision {
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
  let refreshedAfterObservedAbsence = false;
  let lastAttempt: McpCredentialRevisionAttempt = { kind: "transport-unavailable" };
  let candidateRevision: McpAttachedCredentialRevision | undefined;
  let attachedRevision: McpAttachedCredentialRevision | undefined;
  const ready = waitForMcpBridgeCondition(
    () => {
      // Each exec is a fresh OpenShell process. Only the bounded placeholder
      // classification crosses back to the host, where the comparison cannot
      // be influenced by a same-UID sandbox process rewriting a snapshot file.
      let attempt = tryObserveMcpCredentialRevision(sandboxName, envName, runtimeSelection);
      lastAttempt = attempt;
      if (
        attempt.kind === "observation" &&
        attempt.observation === "absent" &&
        !refreshedAfterObservedAbsence &&
        options.refreshAfterObservedAbsence
      ) {
        refreshedAfterObservedAbsence = true;
        options.refreshAfterObservedAbsence();
        attempt = tryObserveMcpCredentialRevision(sandboxName, envName, runtimeSelection);
        lastAttempt = attempt;
      }
      const observation = attempt.kind === "observation" ? attempt.observation : null;
      // The startup command can expose the identityless canonical placeholder
      // before the process supervisor receives the attached provider snapshot.
      // Endpoint-bound credentials become usable only when a fresh exec sees
      // the revision-scoped placeholder issued by that snapshot.
      const attached =
        observation !== null &&
        observation !== "absent" &&
        observation !== "canonical" &&
        (options.previousRevision === undefined || observation !== options.previousRevision);
      if (!attached) {
        candidateRevision = undefined;
        return false;
      }
      if (candidateRevision !== observation) {
        candidateRevision = observation;
        return false;
      }
      // OpenShell can briefly project the revision that preceded a post-policy
      // provider refresh. Require the same revision from two consecutive fresh
      // execs so the adapter cannot be committed with a placeholder that is
      // already being replaced by the provider sidecar.
      attachedRevision = observation;
      return true;
    },
    Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 30,
    1_000,
  );
  if (!ready) {
    throw new McpBridgeError(
      `OpenShell did not synchronize the expected credential revision for placeholder '${envName}' into sandbox '${sandboxName}' after provider attachment or update (last bounded observation: ${describeMcpCredentialRevisionAttempt(lastAttempt)}; post-absence provider refresh attempted: ${refreshedAfterObservedAbsence ? "yes" : "no"}).`,
    );
  }
  if (attachedRevision === undefined) {
    throw new McpBridgeError(
      `OpenShell reported credential readiness without a usable revision for placeholder '${envName}' in sandbox '${sandboxName}'.`,
    );
  }
  return attachedRevision;
}

export function buildMcpCredentialDetachedCommand(envName: string): string {
  validateMcpCredentialEnvName(envName);
  return `[ -z "\${${envName}+x}" ]`;
}

export function waitForDetachedMcpCredential(
  sandboxName: string,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
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
  const revoked = waitForMcpBridgeCondition(
    () =>
      executeMcpCredentialProofCommand(
        sandboxName,
        buildMcpCredentialDetachedCommand(envName),
        runtimeSelection,
      )
        ?.status === 0,
    Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 30,
    1_000,
  );
  if (!revoked) {
    throw new McpBridgeError(
      `OpenShell did not confirm credential '${envName}' was revoked from fresh execs in sandbox '${sandboxName}' after detach. Preserving the MCP bridge lifecycle record.`,
    );
  }
}
