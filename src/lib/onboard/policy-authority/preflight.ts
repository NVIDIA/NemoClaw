// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
    throw new Error(
      `Temporary sandbox policy cleanup failed while trying to ${operation}. Inspect and remove the temporary sandbox policy before retrying.`,
    );
  }
}

function attachCleanupFailure(primaryError: unknown, cleanupError: unknown): Error {
  const primaryMessage =
    primaryError instanceof Error ? primaryError.message : "Policy authority validation failed.";
  const cleanupMessage =
    cleanupError instanceof Error
      ? cleanupError.message
      : "Temporary sandbox policy cleanup failed. Inspect and remove the temporary sandbox policy before retrying.";
  const cause = new AggregateError(
    [primaryError, cleanupError],
    "Policy authority validation and temporary policy cleanup both failed.",
  );
  const message = `${primaryMessage} ${cleanupMessage}`;
  if (primaryError instanceof PolicyAuthorityRefusalError) {
    return new PolicyAuthorityRefusalError(message, primaryError.observedAuthority, { cause });
  }
  return new Error(message, { cause });
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
  let primaryError: unknown;
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
  } catch (error) {
    primaryError = error;
  }
  try {
    cleanupRequirement(requiredPolicy, input.operation);
  } catch (cleanupError) {
    if (primaryError === undefined) throw cleanupError;
    throw attachCleanupFailure(primaryError, cleanupError);
  }
  if (primaryError !== undefined) throw primaryError;
  return inspection;
}

type ProviderPolicyRequirements = {
  readonly gatewayName: string;
  readonly sandboxName: string | null;
  readonly agent: AgentDefinition | null;
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
    const agent = requirements.agent ?? runtime.agentDefs.loadAgent("openclaw");
    const sandboxName = requirements.sandboxName ?? getDefaultSandboxNameForAgent(agent);
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
            runtime.agentOnboard.getAgentPolicyPath(agent) ??
              path.join(runtime.ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
            [...requirements.selectedMessagingChannels],
            {
              directGpu: requirements.gpuPassthrough,
              additionalPresets: requiredOnboardPolicyPresets({
                additionalPresets: requirements.hermesToolGateways,
                provider: requirements.provider,
                hostLocalInferenceRouteOnly: requirements.hostLocalInferenceRouteOnly,
                webSearchConfig: requirements.webSearchConfig,
                agentName: agent.name,
                observabilityEnabled: requirements.observabilityEnabled,
              }),
              agentName: agent.name,
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
