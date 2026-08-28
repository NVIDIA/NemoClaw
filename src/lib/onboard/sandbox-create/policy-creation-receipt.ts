// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";

import {
  assertExternalPolicyRequirements,
  assertObservedPolicyRequirements,
  assertOpenShellGatewayPortBinding,
  captureSandboxBasePolicy,
  inspectOpenShellSandboxPolicyReadiness,
  inspectSandboxPolicyAuthority,
  PolicyAuthorityRefusalError,
  type SandboxPolicyAuthority,
} from "../../adapters/openshell/policy-authority";
import { waitUntil } from "../../core/wait";
import type { NemoClawPolicyCreationReceipt } from "../../policy/merge";
import { normalizePendingSandboxPolicyVerification } from "../../state/registry-normalization";
import type { PendingSandboxPolicyVerification } from "../../state/registry/types";
import {
  assertNemoClawPolicyCreationReceiptMatches,
  parseNemoClawPolicyCreationReceipt,
  parseOpenShellPolicy,
  withoutProviderComposedPolicies,
} from "../../policy/merge";
import type { SelectedDockerGpuRoute } from "../docker-gpu-route";
import { isOpenShellGpuBaselineEnrichment } from "../sandbox-gpu-route-policy";
import type { VerifiedSandboxPolicyBoundary, VerifiedSandboxPolicyRegistration } from "../types";

export interface CreatedSandboxPolicyReceiptInput {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string;
  readonly lifecycleLiveIdentityFingerprint: string;
  readonly policySourcePath: string;
  readonly route: SelectedDockerGpuRoute;
}

export interface CreatedSandboxPolicyReceiptDeps {
  readonly readFile?: typeof fs.readFileSync;
  readonly inspectPolicyReadiness?: typeof inspectOpenShellSandboxPolicyReadiness;
  readonly sleep?: (seconds: number) => void;
}

const POLICY_READINESS_MAX_OBSERVATIONS = 5;
const POLICY_READINESS_POLL_INTERVAL_SECONDS = 1;

export interface CreatedSandboxPolicyRegistrationInput extends CreatedSandboxPolicyReceiptInput {
  readonly plannedAuthority: Exclude<SandboxPolicyAuthority, "owner-unknown">;
  readonly operation: string;
}

/** Flatten one in-memory verified boundary into its non-authorizing durable checkpoint. */
export function pendingSandboxPolicyVerificationForBoundary(
  boundary: VerifiedSandboxPolicyBoundary,
): PendingSandboxPolicyVerification {
  const common = {
    schemaVersion: 1 as const,
    state: "verified-create" as const,
    gatewayName: boundary.gatewayName,
    gatewayPort: boundary.gatewayPort,
    sandboxName: boundary.sandboxName,
    lifecycleGeneration: boundary.lifecycleGeneration,
    sandboxIdentityFingerprint: boundary.lifecycleLiveIdentityFingerprint,
    ...(boundary.createAttemptNonce ? { createAttemptNonce: boundary.createAttemptNonce } : {}),
    route: boundary.route,
  };
  const registration = boundary.registration;
  if (registration.policyAuthority === "nemoclaw-managed") {
    return {
      ...common,
      policyAuthority: "nemoclaw-managed",
      observedPolicyAuthority: "owner-unknown",
      policyHash: registration.policyCreationReceipt.policyHash,
      policyVersion: registration.policyCreationReceipt.policyVersion,
      policyCreationReceipt: registration.policyCreationReceipt,
    };
  }
  return {
    ...common,
    policyAuthority: "externally-managed",
    observedPolicyAuthority: registration.observedPolicyAuthority,
    policyHash: registration.policyIdentity.hash,
    policyVersion: registration.policyIdentity.activeVersion,
  };
}

/** Restore only the non-authorizing policy boundary captured by a durable create checkpoint. */
export function verifiedSandboxPolicyBoundaryFromPendingCheckpoint(
  value: unknown,
): VerifiedSandboxPolicyBoundary {
  const checkpoint = normalizePendingSandboxPolicyVerification(value);
  if (!checkpoint) {
    throw new PolicyAuthorityRefusalError(
      "Cannot resume sandbox creation without a complete verified policy checkpoint.",
    );
  }
  const common = {
    sandboxName: checkpoint.sandboxName,
    gatewayName: checkpoint.gatewayName,
    gatewayPort: checkpoint.gatewayPort,
    lifecycleGeneration: checkpoint.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: checkpoint.sandboxIdentityFingerprint,
    ...(checkpoint.createAttemptNonce ? { createAttemptNonce: checkpoint.createAttemptNonce } : {}),
    route: checkpoint.route,
  };
  if (checkpoint.policyAuthority === "nemoclaw-managed") {
    return {
      ...common,
      registration: {
        policyAuthority: "nemoclaw-managed",
        policyCreationReceipt: checkpoint.policyCreationReceipt,
        observedPolicyAuthority: "owner-unknown",
      },
    };
  }
  return {
    ...common,
    registration: {
      policyAuthority: "externally-managed",
      policyCreationReceipt: null,
      observedPolicyAuthority: checkpoint.observedPolicyAuthority,
      policyIdentity: {
        hash: checkpoint.policyHash,
        activeVersion: checkpoint.policyVersion,
      },
    },
  };
}

function refusal(reason: string): never {
  throw new PolicyAuthorityRefusalError(
    `Cannot record NemoClaw policy ownership: ${reason}. The sandbox remains owner-unknown and policy mutation is disabled.`,
  );
}

function basePolicyFromEffectivePolicy(
  policy: ReturnType<typeof parseOpenShellPolicy>["policy"],
): ReturnType<typeof parseOpenShellPolicy>["policy"] {
  const networkPolicies = policy.network_policies;
  if (!networkPolicies || typeof networkPolicies !== "object" || Array.isArray(networkPolicies)) {
    return policy;
  }
  return {
    ...policy,
    network_policies: withoutProviderComposedPolicies(networkPolicies as never),
  };
}

function waitForCreatedSandboxPolicyReadiness(
  input: CreatedSandboxPolicyReceiptInput,
  policyVersion: number,
  deps: CreatedSandboxPolicyReceiptDeps,
  reject: (reason: string) => never = refusal,
): void {
  const inspectReadiness = deps.inspectPolicyReadiness ?? inspectOpenShellSandboxPolicyReadiness;
  const sleep = deps.sleep;
  const lastObservation = {
    reason: "policy-version-pending" as "sandbox-not-ready" | "policy-version-pending",
  };
  const ready = waitUntil(
    () => {
      const readiness = inspectReadiness({
        sandboxName: input.sandboxName,
        gatewayName: input.gatewayName,
        sandboxIdentityFingerprint: input.lifecycleLiveIdentityFingerprint,
        policyVersion,
      });
      if (readiness.state === "ready") return true;
      lastObservation.reason = readiness.reason;
      return false;
    },
    {
      maxAttempts: POLICY_READINESS_MAX_OBSERVATIONS,
      initialIntervalMs: POLICY_READINESS_POLL_INTERVAL_SECONDS * 1_000,
      maxIntervalMs: POLICY_READINESS_POLL_INTERVAL_SECONDS * 1_000,
      backoffFactor: 1,
      sleep: (milliseconds) => {
        if (!sleep) reject("the bounded policy readiness check could not continue");
        sleep(milliseconds / 1_000);
      },
    },
  );
  if (!ready) {
    reject(
      lastObservation.reason === "sandbox-not-ready"
        ? "the exact sandbox did not reach Ready during policy verification"
        : "the exact sandbox did not activate the verified policy version",
    );
  }
}

/**
 * Bind one successful create to its exact sandbox and effective policy.
 * Policy bytes are compared in memory and never enter the receipt or error.
 */
export function verifyCreatedSandboxPolicyCreationReceipt(
  input: CreatedSandboxPolicyReceiptInput,
  deps: CreatedSandboxPolicyReceiptDeps = {},
): NemoClawPolicyCreationReceipt {
  assertOpenShellGatewayPortBinding({
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
  });
  const readFile = deps.readFile ?? fs.readFileSync;
  let intendedPolicy: ReturnType<typeof parseOpenShellPolicy>["policy"];
  try {
    intendedPolicy = parseOpenShellPolicy(readFile(input.policySourcePath, "utf8")).policy;
  } catch {
    refusal("the intended base policy could not be read");
  }

  const before = inspectSandboxPolicyAuthority({
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
  });
  waitForCreatedSandboxPolicyReadiness(input, before.policyIdentity.activeVersion, deps);
  let liveBasePolicy: ReturnType<typeof parseOpenShellPolicy>["policy"];
  try {
    liveBasePolicy = parseOpenShellPolicy(
      captureSandboxBasePolicy(input.sandboxName, input.gatewayName),
    ).policy;
  } catch {
    refusal("the live base policy could not be compared");
  }
  const observedBasePolicy = basePolicyFromEffectivePolicy(before.effectivePolicy);
  if (!isDeepStrictEqual(observedBasePolicy, liveBasePolicy)) {
    refusal("the policy evidence changed during receipt verification");
  }
  const after = inspectSandboxPolicyAuthority({
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
  });
  if (before.authority !== "owner-unknown" || after.authority !== "owner-unknown") {
    refusal("OpenShell does not report the verified policy as sandbox-scoped");
  }
  if (
    before.policyIdentity.hash !== after.policyIdentity.hash ||
    before.policyIdentity.activeVersion !== after.policyIdentity.activeVersion
  ) {
    refusal("the effective policy identity changed during receipt verification");
  }
  if (
    !isDeepStrictEqual(intendedPolicy, liveBasePolicy) &&
    !(
      input.route !== "none" &&
      isOpenShellGpuBaselineEnrichment(intendedPolicy, liveBasePolicy, input.route)
    )
  ) {
    refusal("the live base policy does not match the policy supplied by this create transaction");
  }
  try {
    return parseNemoClawPolicyCreationReceipt({
      schemaVersion: 1,
      origin: "sandbox-create",
      gatewayName: input.gatewayName,
      gatewayPort: input.gatewayPort,
      sandboxName: input.sandboxName,
      lifecycleGeneration: input.lifecycleGeneration,
      sandboxIdentityFingerprint: input.lifecycleLiveIdentityFingerprint,
      policyHash: after.policyIdentity.hash,
      policyVersion: after.policyIdentity.activeVersion,
    });
  } catch {
    refusal("the verified sandbox or policy identity is incomplete");
  }
}

function readRequiredPolicy(
  policySourcePath: string,
  operation: string,
  deps: CreatedSandboxPolicyReceiptDeps,
): ReturnType<typeof parseOpenShellPolicy>["policy"] {
  try {
    return parseOpenShellPolicy((deps.readFile ?? fs.readFileSync)(policySourcePath, "utf8"))
      .policy;
  } catch {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${operation}: the required sandbox policy could not be read.`,
    );
  }
}

function verifyReadOnlyPolicyBoundary(
  input: Omit<CreatedSandboxPolicyRegistrationInput, "plannedAuthority">,
  deps: CreatedSandboxPolicyReceiptDeps,
  observedAuthority: "externally-managed" | "owner-unknown",
): VerifiedSandboxPolicyRegistration {
  assertOpenShellGatewayPortBinding({
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
  });
  const requiredPolicy = readRequiredPolicy(input.policySourcePath, input.operation, deps);
  const before = inspectSandboxPolicyAuthority({
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
  });
  if (before.authority !== observedAuthority) {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${input.operation}: the created sandbox policy authority does not match the selected read-only policy source.`,
      before.authority,
    );
  }
  const assertRequirements =
    observedAuthority === "owner-unknown"
      ? assertObservedPolicyRequirements
      : assertExternalPolicyRequirements;
  assertRequirements({
    inspection: before,
    requiredPolicy,
    operation: input.operation,
    sandboxName: input.sandboxName,
  });
  waitForCreatedSandboxPolicyReadiness(
    input,
    before.policyIdentity.activeVersion,
    deps,
    (reason) => {
      throw new PolicyAuthorityRefusalError(
        `Refusing to ${input.operation}: ${reason}.`,
        before.authority,
      );
    },
  );
  const after = inspectSandboxPolicyAuthority({
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
  });
  if (
    after.authority !== before.authority ||
    after.policyIdentity.hash !== before.policyIdentity.hash ||
    after.policyIdentity.activeVersion !== before.policyIdentity.activeVersion
  ) {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${input.operation}: the effective sandbox policy changed during verification.`,
      after.authority,
    );
  }
  assertRequirements({
    inspection: after,
    requiredPolicy,
    operation: input.operation,
    sandboxName: input.sandboxName,
  });
  return {
    policyAuthority: "externally-managed",
    policyCreationReceipt: null,
    observedPolicyAuthority: observedAuthority,
    policyIdentity: { ...before.policyIdentity },
  };
}

/** Verify a policyless APF-selected create without claiming APF provenance. */
export function verifyCreatedApfInterceptorPolicyRegistration(
  input: Omit<CreatedSandboxPolicyRegistrationInput, "plannedAuthority">,
  deps: CreatedSandboxPolicyReceiptDeps = {},
): VerifiedSandboxPolicyRegistration {
  return verifyReadOnlyPolicyBoundary(input, deps, "owner-unknown");
}

/** Prove the post-create policy before any unrelated create effects run. */
export function verifyCreatedSandboxPolicyRegistration(
  input: CreatedSandboxPolicyRegistrationInput,
  deps: CreatedSandboxPolicyReceiptDeps = {},
): VerifiedSandboxPolicyRegistration {
  if (input.plannedAuthority === "nemoclaw-managed") {
    return {
      policyAuthority: "nemoclaw-managed",
      policyCreationReceipt: verifyCreatedSandboxPolicyCreationReceipt(input, deps),
      observedPolicyAuthority: "owner-unknown",
    };
  }
  return verifyReadOnlyPolicyBoundary(input, deps, "externally-managed");
}

type CreatedSandboxPolicyRevalidationInput = Omit<
  CreatedSandboxPolicyRegistrationInput,
  "plannedAuthority"
> & {
  readonly registration: VerifiedSandboxPolicyRegistration;
};

function revalidateCreatedSandboxPolicyRegistrationInternal(
  input: CreatedSandboxPolicyRevalidationInput,
  deps: CreatedSandboxPolicyReceiptDeps,
): VerifiedSandboxPolicyRegistration {
  assertOpenShellGatewayPortBinding({
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
  });
  const before = inspectSandboxPolicyAuthority({
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
  });
  const registration = input.registration;
  if (before.authority !== registration.observedPolicyAuthority) {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${input.operation}: the effective sandbox policy authority changed after verification.`,
      before.authority,
    );
  }
  if (registration.policyAuthority === "nemoclaw-managed") {
    try {
      assertNemoClawPolicyCreationReceiptMatches(registration.policyCreationReceipt, {
        origin: "sandbox-create",
        gatewayName: input.gatewayName,
        gatewayPort: input.gatewayPort,
        sandboxName: input.sandboxName,
        lifecycleGeneration: input.lifecycleGeneration,
        sandboxIdentityFingerprint: input.lifecycleLiveIdentityFingerprint,
        policyHash: before.policyIdentity.hash,
        policyVersion: before.policyIdentity.activeVersion,
      });
    } catch (error) {
      throw new PolicyAuthorityRefusalError(
        `Refusing to ${input.operation}: the NemoClaw policy creation receipt no longer matches the live sandbox policy.`,
        "owner-unknown",
        { cause: error },
      );
    }
    return registration;
  }
  if (
    before.policyIdentity.hash !== registration.policyIdentity.hash ||
    before.policyIdentity.activeVersion !== registration.policyIdentity.activeVersion
  ) {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${input.operation}: the effective sandbox policy identity changed after verification.`,
      before.authority,
    );
  }
  const requiredPolicy = readRequiredPolicy(input.policySourcePath, input.operation, deps);
  const assertRequirements =
    registration.observedPolicyAuthority === "owner-unknown"
      ? assertObservedPolicyRequirements
      : assertExternalPolicyRequirements;
  assertRequirements({
    inspection: before,
    requiredPolicy,
    operation: input.operation,
    sandboxName: input.sandboxName,
  });
  return registration;
}

/** Revalidate one in-memory gate result against the exact live policy identity. */
export function revalidateCreatedSandboxPolicyRegistration(
  input: CreatedSandboxPolicyRevalidationInput,
  deps: CreatedSandboxPolicyReceiptDeps = {},
): VerifiedSandboxPolicyRegistration {
  return revalidateCreatedSandboxPolicyRegistrationInternal(input, deps);
}
