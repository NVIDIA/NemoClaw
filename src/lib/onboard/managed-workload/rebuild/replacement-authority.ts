// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxPolicyAuthority } from "../../../adapters/openshell/policy-authority";
import { inspectOpenShellSandboxIdentityFingerprint } from "../../../adapters/openshell/policy-authority";
import { cloneAndDeepFreeze } from "../../../core/immutable";
import {
  verifyCreatedSandboxPolicyRegistration,
  type CreatedSandboxPolicyRegistrationInput,
} from "../../sandbox-create/policy-creation-receipt";
import type { VerifiedSandboxPolicyBoundary } from "../../types";
import type { ReboundManagedWorkloadReplacement } from "./contract";
import { ManagedWorkloadRebuildTransactionError } from "./contract";

export interface ManagedWorkloadReplacementPolicyAuthorityInput {
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly policySourcePath: string;
  readonly route: CreatedSandboxPolicyRegistrationInput["route"];
  readonly plannedAuthority: Exclude<SandboxPolicyAuthority, "owner-unknown">;
}

export interface ManagedWorkloadReplacementAuthorityDependencies {
  readonly inspectSandboxIdentity?: typeof inspectOpenShellSandboxIdentityFingerprint;
  readonly verifyCreatedPolicy?: typeof verifyCreatedSandboxPolicyRegistration;
}

function verificationFailure(message: string, cause?: unknown): never {
  throw new ManagedWorkloadRebuildTransactionError("registry-commit", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Bind replacement publication to one live gateway, sandbox identity, and
 * effective policy. The identity-policy-identity sequence runs immediately
 * before the registry CAS and never derives authority from the previous row.
 */
export function verifyManagedWorkloadReplacementAuthority(input: {
  readonly sandboxName: string;
  readonly replacement: ReboundManagedWorkloadReplacement;
  readonly policy: ManagedWorkloadReplacementPolicyAuthorityInput;
  readonly dependencies?: ManagedWorkloadReplacementAuthorityDependencies;
}): VerifiedSandboxPolicyBoundary {
  const inspectIdentity =
    input.dependencies?.inspectSandboxIdentity ?? inspectOpenShellSandboxIdentityFingerprint;
  const verifyPolicy =
    input.dependencies?.verifyCreatedPolicy ?? verifyCreatedSandboxPolicyRegistration;
  const identityInput = {
    sandboxName: input.sandboxName,
    gatewayName: input.policy.gatewayName,
  };
  const requireExactIdentity = (timing: "before" | "after"): void => {
    let observed: string;
    try {
      observed = inspectIdentity(identityInput);
    } catch (error) {
      verificationFailure(
        `the replacement sandbox identity could not be verified ${timing} policy verification`,
        error,
      );
    }
    if (observed !== input.replacement.liveIdentityFingerprint) {
      verificationFailure(`the replacement sandbox identity changed ${timing} policy verification`);
    }
  };

  requireExactIdentity("before");
  let registration: ReturnType<typeof verifyCreatedSandboxPolicyRegistration>;
  const policyInput: CreatedSandboxPolicyRegistrationInput = {
    sandboxName: input.sandboxName,
    gatewayName: input.policy.gatewayName,
    gatewayPort: input.policy.gatewayPort,
    lifecycleGeneration: input.replacement.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: input.replacement.liveIdentityFingerprint,
    policySourcePath: input.policy.policySourcePath,
    route: input.policy.route,
    plannedAuthority: input.policy.plannedAuthority,
    operation: `publish replacement sandbox '${input.sandboxName}'`,
  };
  try {
    registration = verifyPolicy(policyInput);
  } catch (error) {
    verificationFailure("the replacement sandbox policy authority could not be verified", error);
  }
  requireExactIdentity("after");

  return cloneAndDeepFreeze({
    registration,
    sandboxName: input.sandboxName,
    gatewayName: input.policy.gatewayName,
    gatewayPort: input.policy.gatewayPort,
    lifecycleGeneration: input.replacement.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: input.replacement.liveIdentityFingerprint,
    route: input.policy.route,
  });
}
