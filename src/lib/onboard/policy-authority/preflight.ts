// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { AgentDefinition } from "../../agent/defs";
import {
  assertExternalPolicyRequirements,
  assertRecordedPolicyAuthority,
  inspectGlobalPolicyAuthority,
  inspectSandboxPolicyAuthority,
  PolicyAuthorityRefusalError,
  type SandboxPolicyAuthority,
  type SandboxPolicyAuthorityInspection,
} from "../../adapters/openshell/policy-authority";
import type { SandboxEntry } from "../../state/registry";
import { assertPolicyRequirementContainment } from "../../policy/merge";
import { type InitialSandboxPolicy, prepareInitialSandboxCreatePolicy } from "../initial-policy";
import { requiredObservabilityPolicyPresets } from "../observability-policy-presets";
import { type WebSearchConfig, webSearchProviderForConfig } from "../policy-presets";
import { getDefaultSandboxNameForAgent } from "../sandbox-agent";

const { LOCAL_INFERENCE_POLICY_PROVIDERS } = require("../providers") as {
  LOCAL_INFERENCE_POLICY_PROVIDERS: string[];
};

type PolicyAuthorityInspectionDeps = {
  readonly inspectGlobalPolicyAuthority?: typeof inspectGlobalPolicyAuthority;
  readonly inspectSandboxPolicyAuthority?: typeof inspectSandboxPolicyAuthority;
};

export interface ApfInterceptorPolicyVerification {
  /** APF mode records the observed policy as read-only without claiming APF provenance. */
  readonly authority: "externally-managed";
}

/** Bind the global policy authority before provider selection can mutate gateway state. */
export function qualifyGlobalPolicyAuthority(
  input: {
    readonly gatewayName: string;
    readonly recordedAuthority?: SandboxPolicyAuthority | null;
    readonly operation: string;
  },
  deps: Pick<PolicyAuthorityInspectionDeps, "inspectGlobalPolicyAuthority"> = {},
): SandboxPolicyAuthorityInspection {
  const inspection = (deps.inspectGlobalPolicyAuthority ?? inspectGlobalPolicyAuthority)({
    gatewayName: input.gatewayName,
  });
  if (input.recordedAuthority) {
    assertRecordedPolicyAuthority(input.recordedAuthority, inspection.authority, input.operation);
  }
  return inspection;
}

function parseRequiredPolicy(content: string, operation: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch {
    throw new Error(`Refusing to ${operation}: the required sandbox policy is invalid.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Refusing to ${operation}: the required sandbox policy is invalid.`);
  }
  return parsed as Record<string, unknown>;
}

function readInitialPolicy(policy: InitialSandboxPolicy, operation: string): string {
  if (policy.sourceBytes) return policy.sourceBytes.toString("utf8");
  try {
    return fs.readFileSync(policy.policyPath, "utf8");
  } catch {
    throw new Error(`Refusing to ${operation}: the required sandbox policy is unreadable.`);
  }
}

function cleanupRequirement(policy: InitialSandboxPolicy, operation: string): void {
  if (policy.cleanup && policy.cleanup() !== true) {
    throw new Error(`Refusing to ${operation}: the temporary sandbox policy could not be removed.`);
  }
}

function canonicalPolicyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalPolicyValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalPolicyValue((value as Record<string, unknown>)[key])]),
  );
}

function effectivePolicyFingerprint(policy: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalPolicyValue(policy)), "utf8")
    .digest("hex");
}

function assertValidObservedEffectivePolicy(policy: Record<string, unknown>): void {
  if (Object.keys(policy).length === 0) {
    throw new Error("the observed effective policy is missing");
  }
  if (
    Object.hasOwn(policy, "version") &&
    (typeof policy.version !== "number" || !Number.isInteger(policy.version) || policy.version < 1)
  ) {
    throw new Error("the observed effective policy version is invalid");
  }
  if (
    Object.hasOwn(policy, "network_policies") &&
    (typeof policy.network_policies !== "object" ||
      policy.network_policies === null ||
      Array.isArray(policy.network_policies))
  ) {
    throw new Error("the observed effective network policy is invalid");
  }
}

/**
 * Verify the effective policy selected by APF-compatible sandbox creation.
 *
 * The operator selection is not provenance. OpenShell 0.0.85 exposes no
 * client-verifiable APF receipt, so this boundary proves only sandbox-scoped
 * effective-policy metadata for the exact sandbox, required-policy containment,
 * and in-process stability.
 */
export function createApfInterceptorPolicyVerifier(
  input: {
    readonly sandboxName: string;
    readonly gatewayName: string;
    readonly prepareRequiredPolicy: () => InitialSandboxPolicy;
  },
  deps: Pick<PolicyAuthorityInspectionDeps, "inspectSandboxPolicyAuthority"> = {},
): (operation: string) => ApfInterceptorPolicyVerification {
  let verifiedEffectivePolicyFingerprint: string | null = null;
  return (operation): ApfInterceptorPolicyVerification => {
    const inspection = (deps.inspectSandboxPolicyAuthority ?? inspectSandboxPolicyAuthority)({
      sandboxName: input.sandboxName,
      gatewayName: input.gatewayName,
    });
    if (inspection.authority !== "nemoclaw-managed") {
      throw new PolicyAuthorityRefusalError(
        `Refusing to ${operation}: APF-interceptor mode requires one sandbox-scoped effective policy; a global policy source is ambiguous.`,
      );
    }

    const requiredPolicy = input.prepareRequiredPolicy();
    let verification: ApfInterceptorPolicyVerification;
    try {
      const parsedPolicy = parseRequiredPolicy(
        readInitialPolicy(requiredPolicy, operation),
        operation,
      );
      try {
        assertValidObservedEffectivePolicy(inspection.effectivePolicy);
        assertPolicyRequirementContainment(inspection, parsedPolicy);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "the policy requirement is invalid";
        throw new PolicyAuthorityRefusalError(
          `Refusing to ${operation} for sandbox ${JSON.stringify(input.sandboxName)}: ${detail}. The observed policy remains read-only.`,
        );
      }
      const observedFingerprint = effectivePolicyFingerprint(inspection.effectivePolicy);
      if (
        verifiedEffectivePolicyFingerprint !== null &&
        observedFingerprint !== verifiedEffectivePolicyFingerprint
      ) {
        throw new PolicyAuthorityRefusalError(
          `Refusing to ${operation} for sandbox ${JSON.stringify(input.sandboxName)}: the observed effective policy changed after APF-interceptor verification.`,
        );
      }
      verifiedEffectivePolicyFingerprint ??= observedFingerprint;
      verification = { authority: "externally-managed" };
    } catch (verificationError) {
      try {
        cleanupRequirement(requiredPolicy, operation);
      } catch (cleanupError) {
        throw new AggregateError(
          [verificationError, cleanupError],
          `Refusing to ${operation}: policy verification and temporary policy cleanup both failed.`,
        );
      }
      throw verificationError;
    }
    try {
      cleanupRequirement(requiredPolicy, operation);
    } catch (cleanupError) {
      throw new AggregateError(
        [cleanupError],
        `Refusing to ${operation}: temporary policy cleanup failed after policy verification.`,
      );
    }
    return verification;
  };
}

/** Resolve and verify policy authority before sandbox lifecycle effects. */
export function qualifySandboxPolicyAuthority(
  input: {
    readonly sandboxName: string;
    readonly gatewayName: string;
    readonly liveExists: boolean;
    readonly recordedAuthorities: readonly (SandboxPolicyAuthority | null | undefined)[];
    readonly prepareRequiredPolicy: () => InitialSandboxPolicy;
    readonly operation: string;
  },
  deps: PolicyAuthorityInspectionDeps = {},
): SandboxPolicyAuthorityInspection {
  const sandboxInspection = input.liveExists
    ? (deps.inspectSandboxPolicyAuthority ?? inspectSandboxPolicyAuthority)({
        sandboxName: input.sandboxName,
        gatewayName: input.gatewayName,
      })
    : null;
  const globalInspection = (deps.inspectGlobalPolicyAuthority ?? inspectGlobalPolicyAuthority)({
    gatewayName: input.gatewayName,
  });
  if (sandboxInspection) {
    assertRecordedPolicyAuthority(
      sandboxInspection.authority,
      globalInspection.authority,
      input.operation,
    );
  }
  const inspection = sandboxInspection ?? globalInspection;

  for (const recorded of input.recordedAuthorities) {
    if (recorded) {
      assertRecordedPolicyAuthority(recorded, inspection.authority, input.operation);
    }
  }
  if (inspection.authority !== "externally-managed") return inspection;

  const requiredPolicy = input.prepareRequiredPolicy();
  try {
    const parsedPolicy = parseRequiredPolicy(
      readInitialPolicy(requiredPolicy, input.operation),
      input.operation,
    );
    for (const observed of sandboxInspection
      ? [sandboxInspection, globalInspection]
      : [globalInspection]) {
      assertExternalPolicyRequirements({
        inspection: observed,
        requiredPolicy: parsedPolicy,
        operation: input.operation,
        sandboxName: input.sandboxName,
      });
    }
  } finally {
    cleanupRequirement(requiredPolicy, input.operation);
  }
  return inspection;
}

type ProviderPolicyRequirements = {
  readonly gatewayName: string;
  readonly sandboxName: string | null;
  readonly agent: AgentDefinition;
  readonly selectedMessagingChannels: readonly string[];
  readonly hermesToolGateways: readonly string[];
  readonly gpuPassthrough: boolean;
  readonly provider: string | null;
  readonly hostLocalInferenceRouteOnly?: boolean;
  readonly webSearchConfig: WebSearchConfig | null;
  readonly observabilityEnabled: boolean;
  readonly operation: string;
};

type RevalidatedPolicyContext = Omit<
  ProviderPolicyRequirements,
  "agent" | "gatewayName" | "observabilityEnabled" | "operation"
> & {
  readonly agent: AgentDefinition | null;
  readonly session: { readonly observabilityEnabled?: boolean | null } | null;
};

/** Include every selected feature that adds a network policy requirement. */
export function requiredOnboardPolicyPresets(input: {
  readonly additionalPresets: readonly string[];
  readonly provider: string | null;
  readonly webSearchConfig: WebSearchConfig | null;
  readonly agentName: string | null | undefined;
  readonly observabilityEnabled: boolean;
  readonly hostLocalInferenceRouteOnly?: boolean;
}): string[] {
  const required = new Set(input.additionalPresets);
  if (
    input.provider &&
    !input.hostLocalInferenceRouteOnly &&
    LOCAL_INFERENCE_POLICY_PROVIDERS.includes(input.provider)
  ) {
    required.add("local-inference");
  }
  if (input.webSearchConfig) {
    required.add(webSearchProviderForConfig(input.webSearchConfig));
  }
  for (const preset of requiredObservabilityPolicyPresets(
    input.agentName,
    input.observabilityEnabled,
  )) {
    required.add(preset);
  }
  return [...required];
}

/** Keep gateway and provider authority checks out of the onboarding entry point. */
type PolicyAuthoritySession = {
  policyAuthority?: SandboxPolicyAuthority | null;
  policyPresets?: string[] | null;
};

export function createOnboardPolicyAuthorityBindings<Session extends PolicyAuthoritySession>(
  runtime: {
    readonly GATEWAY_NAME: string;
    readonly ROOT: string;
    readonly agentDefs: {
      readonly loadAgent: (name: string) => AgentDefinition;
    };
    readonly agentOnboard: {
      readonly getAgentPolicyPath: (agent: AgentDefinition) => string | null;
    };
    readonly inspectSandboxForCreate: (sandboxName: string) => {
      readonly existingEntry: SandboxEntry | null;
      readonly liveExists: boolean;
    };
    readonly onboardSession: {
      loadSession(): Session | null;
      updateSession(mutator: (session: Session) => void): Session | Promise<Session>;
    };
  },
  policyTier: string | null | undefined,
  inspectionDeps: PolicyAuthorityInspectionDeps = {},
): {
  readonly bindPolicyAuthority: (gatewayName: string, session: Session | null) => Promise<Session>;
  readonly preflightPolicyRequirements: (requirements: ProviderPolicyRequirements) => void;
  readonly revalidatePolicyRequirements: (
    context: RevalidatedPolicyContext,
    operation: string,
  ) => void;
} {
  const preflightPolicyRequirements = (requirements: ProviderPolicyRequirements): void => {
    const sandboxName =
      requirements.sandboxName ?? getDefaultSandboxNameForAgent(requirements.agent);
    const observed = runtime.inspectSandboxForCreate(sandboxName);
    qualifySandboxPolicyAuthority(
      {
        sandboxName,
        gatewayName: requirements.gatewayName,
        liveExists: observed.liveExists,
        recordedAuthorities: [
          observed.existingEntry?.policyAuthority,
          runtime.onboardSession.loadSession()?.policyAuthority,
        ],
        operation: requirements.operation,
        prepareRequiredPolicy: () =>
          prepareInitialSandboxCreatePolicy(
            runtime.agentOnboard.getAgentPolicyPath(requirements.agent) ??
              path.join(runtime.ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
            [...requirements.selectedMessagingChannels],
            {
              directGpu: requirements.gpuPassthrough,
              additionalPresets: requiredOnboardPolicyPresets({
                additionalPresets: requirements.hermesToolGateways,
                provider: requirements.provider,
                hostLocalInferenceRouteOnly: requirements.hostLocalInferenceRouteOnly,
                webSearchConfig: requirements.webSearchConfig,
                agentName: requirements.agent.name,
                observabilityEnabled: requirements.observabilityEnabled,
              }),
              agentName: requirements.agent.name,
              policyTier: observed.existingEntry?.policyTier ?? policyTier,
              baselineExclusions: observed.existingEntry?.baselineExclusions ?? [],
            },
          ),
      },
      inspectionDeps,
    );
  };
  return {
    async bindPolicyAuthority(gatewayName, session) {
      const inspection = qualifyGlobalPolicyAuthority(
        {
          gatewayName,
          recordedAuthority: session?.policyAuthority,
          operation: "continue onboarding after gateway setup",
        },
        inspectionDeps,
      );
      return runtime.onboardSession.updateSession((current) => {
        current.policyAuthority = inspection.authority;
        if (inspection.authority === "externally-managed") current.policyPresets = null;
      });
    },
    preflightPolicyRequirements,
    revalidatePolicyRequirements(context, operation) {
      preflightPolicyRequirements({
        gatewayName: runtime.GATEWAY_NAME,
        sandboxName: context.sandboxName,
        agent: context.agent ?? runtime.agentDefs.loadAgent("openclaw"),
        selectedMessagingChannels: context.selectedMessagingChannels,
        hermesToolGateways: context.hermesToolGateways,
        gpuPassthrough: context.gpuPassthrough,
        provider: context.provider,
        hostLocalInferenceRouteOnly: context.hostLocalInferenceRouteOnly,
        webSearchConfig: context.webSearchConfig,
        observabilityEnabled: context.session?.observabilityEnabled === true,
        operation,
      });
    },
  };
}
