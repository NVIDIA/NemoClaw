// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  OPENSHELL_MANAGED_BY_LABEL,
  OPENSHELL_MANAGED_BY_VALUE,
  OPENSHELL_SANDBOX_ID_LABEL,
  OPENSHELL_SANDBOX_NAME_LABEL,
  removeExactOpenShellDockerSandboxContainers,
} from "../../onboard/openshell-docker-sandbox-containers";
import { fingerprintOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
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
  | { status: "recovery"; identities: SandboxNameLabeledContainer[] }
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
  retainedSandboxIdentityFingerprint?: string;
  cliName?: string;
  classify?: (
    sandboxName: string,
    retainedSandboxIdentityFingerprint?: string,
  ) => DestroyContainerIdentityVerdict;
  error?: (message: string) => void;
};

export type DestroyContainerIdentityProof =
  | { identity: SandboxNameLabeledContainer | null | undefined }
  | { identities: readonly SandboxNameLabeledContainer[] };

/** Normalize the legacy single-container proof and recovery set proof. */
export function getDestroyContainerIdentities(
  proof: DestroyContainerIdentityProof,
): readonly SandboxNameLabeledContainer[] | undefined {
  if ("identities" in proof) return proof.identities;
  if (proof.identity === undefined) return undefined;
  return proof.identity === null ? [] : [proof.identity];
}

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

/** Retire the exact container set qualified from one retained recovery fingerprint. */
export function removeExactDestroyContainerIdentities(
  sandboxName: string,
  expectedIdentities: readonly SandboxNameLabeledContainer[],
  log: (message: string) => void,
): void {
  removeExactOpenShellDockerSandboxContainers(
    sandboxName,
    expectedIdentities.map((identity) => identity.id),
    log,
  );
}

/**
 * Classify every Docker container carrying `openshell.ai/sandbox-name=<name>`.
 * The query intentionally does not filter by managed-by so a foreign container
 * borrowing the mutable name remains visible and makes destroy fail closed.
 */
export function classifyDestroyContainerIdentity(
  sandboxName: string,
  observation: DockerSandboxIdentityObservation,
  retainedSandboxIdentityFingerprint?: string,
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
  if (managed.length > 0 && retainedSandboxIdentityFingerprint !== undefined) {
    const identityMatches = managed.every(
      (row) =>
        row.workspace.length > 0 &&
        row.sandboxId.length > 0 &&
        fingerprintOpenShellSandboxId(row.sandboxId) === retainedSandboxIdentityFingerprint,
    );
    const oneWorkspace = new Set(managed.map((row) => row.workspace)).size === 1;
    if (!identityMatches || !oneWorkspace) {
      return {
        status: "ambiguous",
        sandboxName,
        reason: "one or more managed containers do not match the retained sandbox identity",
        foreign,
        managed,
      };
    }
    if (managed.length > 1) {
      return {
        status: "recovery",
        identities: [...managed].sort((left, right) => left.id.localeCompare(right.id)),
      };
    }
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
    ((name: string, retainedSandboxIdentityFingerprint?: string) =>
      classifyDestroyContainerIdentity(
        name,
        observeDestroyContainerIdentity(name),
        retainedSandboxIdentityFingerprint,
      ));
  const error = deps.error ?? ((message: string) => console.error(`  ${message}`));
  if (deps.providerId !== "docker") return { identity: undefined };

  const verdict = deps.retainedSandboxIdentityFingerprint
    ? classify(sandboxName, deps.retainedSandboxIdentityFingerprint)
    : classify(sandboxName);
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
  return verdict.status === "recovery"
    ? { identities: verdict.identities }
    : { identity: verdict.identity };
}

/** Compare provider-owned identity proofs across two destroy checkpoints. */
export function isSameDestroyContainerIdentityProof(
  expected: DestroyContainerIdentityProof,
  actual: DestroyContainerIdentityProof,
): boolean {
  const expectedIdentities = getDestroyContainerIdentities(expected);
  const actualIdentities = getDestroyContainerIdentities(actual);
  if (expectedIdentities === undefined || actualIdentities === undefined) {
    return expectedIdentities === actualIdentities;
  }
  if (expectedIdentities.length !== actualIdentities.length) return false;
  return expectedIdentities.every((identity, index) => {
    const candidate = actualIdentities[index];
    return candidate !== undefined && isSameDestroyContainerIdentity(identity, {
      status: "clear",
      identity: candidate,
    });
  });
}

export type DestroySandboxPresence = OpenShellSandboxPresence;

export function classifyDestroySandboxPresence(
  sandboxName: string,
  result: { status: number | null; stdout?: string; stderr?: string },
): DestroySandboxPresence {
  return classifyOpenShellSandboxPresence(sandboxName, result);
}
