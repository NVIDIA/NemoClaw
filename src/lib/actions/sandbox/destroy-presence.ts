// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  OPENSHELL_SANDBOX_ID_LABEL,
  OPENSHELL_SANDBOX_NAME_LABEL,
  OPENSHELL_SANDBOX_WORKSPACE_LABEL,
  inspectDockerSandboxNameLabeledContainers,
  resolveOpenShellSandboxOwnershipLabel,
} from "../../onboard/openshell-docker-sandbox-containers";
import { fingerprintOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
import { sanitizeReadinessText } from "../../readiness/sanitize";
import type { SandboxEntry } from "../../state/registry";
import type { RuntimeProviderDestroyIdentityReceipt } from "../../onboard/runtime-provider/contract";
import {
  type DockerSandboxIdentityObservation,
} from "../../adapters/docker/inspect";
import {
  registeredRuntimeProviderSupportsContainerEngineOperation,
  resolveRegisteredRuntimeProvider,
} from "../../onboard/runtime-provider/selection";
import {
  classifyOpenShellSandboxPresence,
  type OpenShellSandboxPresence,
} from "../../adapters/openshell/sandbox-presence";

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
  sandbox?: SandboxEntry | null;
  captureProviderIdentity?: (
    sandbox: SandboxEntry,
    sandboxName: string,
  ) => RuntimeProviderDestroyIdentityReceipt;
  captureProviderIdentityByName?: (sandboxName: string) => RuntimeProviderDestroyIdentityReceipt;
  retainedSandboxIdentityFingerprint?: string;
  cliName?: string;
  classify?: (
    sandboxName: string,
    retainedSandboxIdentityFingerprint?: string,
  ) => DestroyContainerIdentityVerdict;
  error?: (message: string) => void;
};

export type DestroyContainerIdentityProof = {
  // `undefined` delegates identity gating to the runtime provider. An empty
  // array records confirmed Docker absence; other arrays contain the exact
  // immutable Docker identities qualified for this destroy operation.
  identities?: readonly SandboxNameLabeledContainer[];
  providerIdentity?: RuntimeProviderDestroyIdentityReceipt;
};
/** Read the host observation consumed by the pure identity classifier. */
export function observeDestroyContainerIdentity(
  sandboxName: string,
): DockerSandboxIdentityObservation {
  return inspectDockerSandboxNameLabeledContainers(sandboxName);
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
  const ownership = resolveOpenShellSandboxOwnershipLabel();
  const managed = rows.filter((row) => row.managedBy === ownership.value);
  const foreign = rows.filter((row) => row.managedBy !== ownership.value);

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
        `${sandboxName}' label without the '${ownership.label}=${ownership.value}' marker`,
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

/** Human-readable lines describing an ambiguous-identity refusal. */
export function formatAmbiguousDestroyIdentity(
  verdict: Extract<DestroyContainerIdentityVerdict, { status: "ambiguous" }>,
  cliName: string,
): string[] {
  const ownership = resolveOpenShellSandboxOwnershipLabel();
  const display = (value: string, fallback = "<none>"): string =>
    sanitizeReadinessText(value || fallback, IDENTITY_VALUE_MAX_LENGTH);
  const displayLabel = (value: string): string => JSON.stringify(display(value));
  const describe = (row: SandboxNameLabeledContainer): string =>
    `${display(row.id).slice(0, 12)} (${ownership.label}=${displayLabel(row.managedBy)}, ` +
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
  const provider = resolveRegisteredRuntimeProvider(deps.providerId);
  const providerCapture =
    provider?.cleanup.supported === true ? provider.cleanup.captureDestroyIdentity : undefined;
  const captureProviderIdentity =
    deps.captureProviderIdentity ??
    (providerCapture
      ? (sandbox: SandboxEntry, name: string) => providerCapture({ sandbox, sandboxName: name })
      : undefined);
  const captureProviderIdentityByName =
    deps.captureProviderIdentityByName ??
    (provider?.cleanup.supported === true
      ? provider.cleanup.captureDestroyIdentityByName
      : undefined);
  if (
    !provider ||
    !registeredRuntimeProviderSupportsContainerEngineOperation(
      deps.providerId,
      "gateway-inspection",
    )
  ) {
    return { identities: undefined };
  }
  let providerOwnsIdentity =
    deps.captureProviderIdentity !== undefined || deps.captureProviderIdentityByName !== undefined;
  try {
    providerOwnsIdentity ||= Boolean(
      provider.gateway.prepareHostRuntime({
        environment: process.env,
        platform: process.platform,
      }).socketPath !== null,
    );
  } catch {
    return { identities: undefined };
  }
  const error = deps.error ?? ((message: string) => console.error(`  ${message}`));
  if (providerOwnsIdentity) {
    try {
      const providerIdentity =
        deps.sandbox && captureProviderIdentity
          ? captureProviderIdentity(deps.sandbox, sandboxName)
          : captureProviderIdentityByName?.(sandboxName);
      return providerIdentity ? { identities: undefined, providerIdentity } : { identities: undefined };
    } catch (captureError) {
      const detail = deps.redact(
        captureError instanceof Error ? captureError.message : String(captureError),
      );
      error(
        `Refusing to destroy sandbox '${sandboxName}': Runtime provider identity could not be inspected (${detail}). No sandbox resources were removed.`,
      );
      return false;
    }
  }
  const classify =
    deps.classify ??
    ((name: string, retainedSandboxIdentityFingerprint?: string) =>
      classifyDestroyContainerIdentity(
        name,
        observeDestroyContainerIdentity(name),
        retainedSandboxIdentityFingerprint,
      ));
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
  return {
    identities:
      verdict.status === "recovery"
        ? verdict.identities
        : verdict.identity === null
          ? []
          : [verdict.identity],
  };
}

/** Compare provider-owned identity proofs across two destroy checkpoints. */
export function isSameDestroyContainerIdentityProof(
  expected: DestroyContainerIdentityProof,
  actual: DestroyContainerIdentityProof,
): boolean {
  if (expected.providerIdentity || actual.providerIdentity) {
    const left = expected.providerIdentity;
    const right = actual.providerIdentity;
    return (
      left !== undefined &&
      right !== undefined &&
      left.schemaVersion === right.schemaVersion &&
      left.providerId === right.providerId &&
      left.resourceHandle === right.resourceHandle &&
      left.ownershipSha256 === right.ownershipSha256
    );
  }
  const expectedIdentities = expected.identities;
  const actualIdentities = actual.identities;
  if (expectedIdentities === undefined || actualIdentities === undefined) {
    return expectedIdentities === actualIdentities;
  }
  if (expectedIdentities.length !== actualIdentities.length) return false;
  return expectedIdentities.every((identity, index) => {
    const candidate = actualIdentities[index];
    return (
      candidate !== undefined &&
      identity.id === candidate.id &&
      identity.managedBy === candidate.managedBy &&
      identity.workspace === candidate.workspace &&
      identity.sandboxId === candidate.sandboxId
    );
  });
}

export type DestroySandboxPresence = OpenShellSandboxPresence;

export function classifyDestroySandboxPresence(
  sandboxName: string,
  result: { status: number | null; stdout?: string; stderr?: string },
): DestroySandboxPresence {
  return classifyOpenShellSandboxPresence(sandboxName, result);
}
