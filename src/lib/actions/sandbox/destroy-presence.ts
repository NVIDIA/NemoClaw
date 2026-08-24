// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  OPENSHELL_MANAGED_BY_LABEL,
  OPENSHELL_MANAGED_BY_VALUE,
  OPENSHELL_SANDBOX_ID_LABEL,
  OPENSHELL_SANDBOX_NAME_LABEL,
  removeExactOpenShellDockerSandboxContainer,
} from "../../onboard/openshell-docker-sandbox-containers";
import { sanitizeReadinessText } from "../../readiness/sanitize";
import {
  type DockerSandboxIdentityObservation,
  inspectDockerSandboxIdentities,
} from "../../adapters/docker/inspect";
import {
  classifyOpenShellSandboxPresence,
  type OpenShellSandboxPresence,
} from "../../adapters/openshell/sandbox-presence";

/** Workspace label OpenShell stamps on every managed sandbox container. */
export const OPENSHELL_SANDBOX_WORKSPACE_LABEL = "openshell.ai/sandbox-workspace";

const IDENTITY_VALUE_MAX_LENGTH = 256;
const IDENTITY_DIAGNOSTIC_MAX_LENGTH = 500;

/** One container carrying the destroy target's `sandbox-name` label. */
export type SandboxNameLabeledContainer = {
  id: string;
  managedBy: string;
  workspace: string;
  sandboxId: string;
};

/** Verdict for whether destroy resolved one complete managed container identity. */
export type DestroyContainerIdentityVerdict =
  | { status: "clear"; identity: SandboxNameLabeledContainer | null }
  | { status: "probe-failed"; detail: string }
  | {
      status: "ambiguous";
      sandboxName: string;
      reason: string;
      foreign: SandboxNameLabeledContainer[];
      managed: SandboxNameLabeledContainer[];
    };

export type AssertUnambiguousDestroyIdentityDeps = {
  providerId: string;
  redact: (detail: string) => string;
  cliName?: string;
  classify?: (sandboxName: string) => DestroyContainerIdentityVerdict;
  error?: (message: string) => void;
};

export type DestroyContainerIdentityProof = {
  identity: SandboxNameLabeledContainer | null | undefined;
};

function observeDockerSandboxIdentities(sandboxName: string): DockerSandboxIdentityObservation {
  return inspectDockerSandboxIdentities(`${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}`, {
    managedBy: OPENSHELL_MANAGED_BY_LABEL,
    workspace: OPENSHELL_SANDBOX_WORKSPACE_LABEL,
    sandboxId: OPENSHELL_SANDBOX_ID_LABEL,
  });
}

/** Read the host observation consumed by the pure identity classifier. */
export function observeDestroyContainerIdentity(
  sandboxName: string,
): DockerSandboxIdentityObservation {
  return observeDockerSandboxIdentities(sandboxName);
}

/** Retire only the provider runtime bound to the pre-destroy identity proof. */
export function removeExactDestroyContainerIdentity(
  sandboxName: string,
  expectedIdentity: SandboxNameLabeledContainer,
  log: (message: string) => void,
): void {
  removeExactOpenShellDockerSandboxContainer(sandboxName, expectedIdentity.id, log);
}

/**
 * Classify every Docker container carrying `openshell.ai/sandbox-name=<name>`.
 * The query intentionally does not filter by managed-by so a foreign container
 * borrowing the mutable name remains visible and makes destroy fail closed.
 */
export function classifyDestroyContainerIdentity(
  sandboxName: string,
  observation: DockerSandboxIdentityObservation,
): DestroyContainerIdentityVerdict {
  if (observation.status === "probe-failed") {
    return {
      status: "probe-failed",
      detail:
        sanitizeReadinessText(observation.detail, IDENTITY_DIAGNOSTIC_MAX_LENGTH) ||
        "docker ps did not complete successfully",
    };
  }

  const { malformedRows, rows } = observation;
  const managed = rows.filter((row) => row.managedBy === OPENSHELL_MANAGED_BY_VALUE);
  const foreign = rows.filter((row) => row.managedBy !== OPENSHELL_MANAGED_BY_VALUE);

  if (malformedRows > 0) {
    return {
      status: "ambiguous",
      sandboxName,
      reason: `Docker returned ${String(malformedRows)} malformed container identity row(s)`,
      foreign,
      managed,
    };
  }
  if (rows.length === 0) return { status: "clear", identity: null };
  if (foreign.length > 0) {
    return {
      status: "ambiguous",
      sandboxName,
      reason:
        `${String(foreign.length)} container(s) carry the '${OPENSHELL_SANDBOX_NAME_LABEL}=` +
        `${sandboxName}' label without the '${OPENSHELL_MANAGED_BY_LABEL}=` +
        `${OPENSHELL_MANAGED_BY_VALUE}' marker`,
      foreign,
      managed,
    };
  }
  if (managed.length !== 1) {
    return {
      status: "ambiguous",
      sandboxName,
      reason:
        `${String(managed.length)} managed containers carry the ` +
        `'${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}' label; expected exactly one`,
      foreign,
      managed,
    };
  }

  const [identity] = managed;
  if (!identity.workspace || !identity.sandboxId) {
    const missingLabels = [
      identity.workspace ? null : OPENSHELL_SANDBOX_WORKSPACE_LABEL,
      identity.sandboxId ? null : OPENSHELL_SANDBOX_ID_LABEL,
    ].filter((label): label is string => label !== null);
    return {
      status: "ambiguous",
      sandboxName,
      reason: `the managed container is missing ${missingLabels.join(" and ")}`,
      foreign,
      managed,
    };
  }
  return { status: "clear", identity };
}

/** Require the same immutable container row, including the already-absent state. */
export function isSameDestroyContainerIdentity(
  expected: SandboxNameLabeledContainer | null,
  verdict: DestroyContainerIdentityVerdict,
): boolean {
  if (verdict.status !== "clear") return false;
  if (expected === null || verdict.identity === null) return expected === verdict.identity;
  return (
    expected.id === verdict.identity.id &&
    expected.managedBy === verdict.identity.managedBy &&
    expected.workspace === verdict.identity.workspace &&
    expected.sandboxId === verdict.identity.sandboxId
  );
}

/** Human-readable lines describing an ambiguous-identity refusal. */
export function formatAmbiguousDestroyIdentity(
  verdict: Extract<DestroyContainerIdentityVerdict, { status: "ambiguous" }>,
  cliName: string,
): string[] {
  const display = (value: string, fallback = "<none>"): string =>
    sanitizeReadinessText(value || fallback, IDENTITY_VALUE_MAX_LENGTH);
  const displayLabel = (value: string): string => JSON.stringify(display(value));
  const describe = (row: SandboxNameLabeledContainer): string =>
    `${display(row.id).slice(0, 12)} (${OPENSHELL_MANAGED_BY_LABEL}=${displayLabel(row.managedBy)}, ` +
    `${OPENSHELL_SANDBOX_WORKSPACE_LABEL}=${displayLabel(row.workspace)}, ` +
    `${OPENSHELL_SANDBOX_ID_LABEL}=${displayLabel(row.sandboxId)})`;
  const sandboxName = display(verdict.sandboxName);
  const lines = [
    `Refusing to destroy sandbox '${sandboxName}': ${sanitizeReadinessText(verdict.reason, IDENTITY_DIAGNOSTIC_MAX_LENGTH)}.`,
    "NemoClaw could not verify one complete container identity for this sandbox name, so destroy fails closed.",
  ];
  for (const row of verdict.foreign) {
    lines.push(`  Conflicting container: ${describe(row)}`);
  }
  for (const row of verdict.managed) {
    lines.push(`  Managed sandbox container: ${describe(row)}`);
  }
  lines.push(
    "Inspect containers with the sandbox-name label. Resolve the conflict through the workflow " +
      `that owns the container, then rerun '${display(cliName)} ${sandboxName} destroy'.`,
  );
  return lines;
}

/**
 * Fail closed when a Docker sandbox name does not resolve to one complete
 * container identity. Other runtime providers own their identity checks.
 */
export function assertUnambiguousDestroyContainerIdentity(
  sandboxName: string,
  deps: AssertUnambiguousDestroyIdentityDeps,
): DestroyContainerIdentityProof | false {
  const classify =
    deps.classify ??
    ((name: string) =>
      classifyDestroyContainerIdentity(name, observeDestroyContainerIdentity(name)));
  const error = deps.error ?? ((message: string) => console.error(`  ${message}`));
  if (deps.providerId !== "docker") return { identity: undefined };

  const verdict = classify(sandboxName);
  if (verdict.status === "ambiguous") {
    for (const line of formatAmbiguousDestroyIdentity(verdict, deps.cliName ?? "nemoclaw")) {
      error(line);
    }
    return false;
  }
  if (verdict.status === "probe-failed") {
    error(
      `Refusing to destroy sandbox '${sandboxName}': Docker container identity could not be ` +
        `inspected (${deps.redact(verdict.detail)}). No sandbox resources were removed. ` +
        "Correct the reported Docker error, then rerun the destroy command.",
    );
    return false;
  }
  return { identity: verdict.identity };
}

/** Compare provider-owned identity proofs across two destroy checkpoints. */
export function isSameDestroyContainerIdentityProof(
  expected: DestroyContainerIdentityProof,
  actual: DestroyContainerIdentityProof,
): boolean {
  if (expected.identity === undefined || actual.identity === undefined) {
    return expected.identity === actual.identity;
  }
  return isSameDestroyContainerIdentity(expected.identity, {
    status: "clear",
    identity: actual.identity,
  });
}

export type DestroySandboxPresence = OpenShellSandboxPresence;

export function classifyDestroySandboxPresence(
  sandboxName: string,
  result: { status: number | null; stdout?: string; stderr?: string },
): DestroySandboxPresence {
  return classifyOpenShellSandboxPresence(sandboxName, result);
}
