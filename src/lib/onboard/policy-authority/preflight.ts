// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { AgentDefinition } from "../../agent/defs";
import {
  assertExternalPolicyRequirements,
  assertObservedPolicyRequirements,
  assertOpenShellGatewayPortBinding,
  assertRecordedPolicyAuthority,
  inspectActiveGlobalPolicy,
  inspectOpenShellSandboxIdentityFingerprint,
  inspectSandboxPolicyAuthority,
  PolicyAuthorityRefusalError,
  type SandboxPolicyAuthority,
  type SandboxPolicyAuthorityInspection,
} from "../../adapters/openshell/policy-authority";
import {
  assertNemoClawPolicyCreationReceiptMatches,
  parseOpenShellPolicy,
} from "../../policy/merge";
import type { SandboxEntry } from "../../state/registry";
import { type InitialSandboxPolicy, prepareInitialSandboxCreatePolicy } from "../initial-policy";
import { requiredObservabilityPolicyPresets } from "../observability-policy-presets";
import { type WebSearchConfig, webSearchProviderForConfig } from "../policy-presets";
import { getDefaultSandboxNameForAgent } from "../sandbox-agent";

const { LOCAL_INFERENCE_POLICY_PROVIDERS } = require("../providers") as {
  LOCAL_INFERENCE_POLICY_PROVIDERS: string[];
};

type PolicyAuthorityInspectionDeps = {
  readonly inspectActiveGlobalPolicy?: typeof inspectActiveGlobalPolicy;
  readonly inspectOpenShellSandboxIdentityFingerprint?: typeof inspectOpenShellSandboxIdentityFingerprint;
  readonly assertOpenShellGatewayPortBinding?: typeof assertOpenShellGatewayPortBinding;
  readonly inspectSandboxPolicyAuthority?: typeof inspectSandboxPolicyAuthority;
};

type RecordedPolicyAuthority = Exclude<SandboxPolicyAuthority, "owner-unknown">;

export type QualifiedSandboxPolicyAuthority =
  | { readonly authority: "nemoclaw-managed" }
  | {
      readonly authority: "externally-managed";
      readonly inspection: SandboxPolicyAuthorityInspection;
    };

/** Bind the global policy authority before provider selection can mutate gateway state. */
export function qualifyGlobalPolicyAuthority(
  input: {
    readonly gatewayName: string;
    readonly recordedAuthority?: SandboxPolicyAuthority | null;
    readonly operation: string;
  },
  deps: Pick<PolicyAuthorityInspectionDeps, "inspectActiveGlobalPolicy"> = {},
): QualifiedSandboxPolicyAuthority {
  const presence = (deps.inspectActiveGlobalPolicy ?? inspectActiveGlobalPolicy)({
    gatewayName: input.gatewayName,
  });
  const authority: RecordedPolicyAuthority =
    presence.state === "active" ? "externally-managed" : "nemoclaw-managed";
  if (input.recordedAuthority) {
    assertRecordedPolicyAuthority(input.recordedAuthority, authority, input.operation);
  }
  return presence.state === "active"
    ? { authority: "externally-managed", inspection: presence.inspection }
    : { authority: "nemoclaw-managed" };
}

function parseRequiredPolicy(content: string, operation: string): Record<string, unknown> {
  try {
    return parseOpenShellPolicy(content).policy;
  } catch {
    throw new Error(`Refusing to ${operation}: the required sandbox policy is invalid.`);
  }
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
    readonly recordedSandbox?: SandboxEntry | null;
    readonly readRecordedSandbox?: (sandboxName: string) => SandboxEntry | null;
    readonly prepareRequiredPolicy: () => InitialSandboxPolicy;
    readonly operation: string;
  },
  deps: PolicyAuthorityInspectionDeps = {},
): QualifiedSandboxPolicyAuthority {
  const sandboxInspection = input.liveExists
    ? (deps.inspectSandboxPolicyAuthority ?? inspectSandboxPolicyAuthority)({
        sandboxName: input.sandboxName,
        gatewayName: input.gatewayName,
      })
    : null;
  let inspection: QualifiedSandboxPolicyAuthority;
  if (!sandboxInspection) {
    inspection = qualifyGlobalPolicyAuthority(
      { gatewayName: input.gatewayName, operation: input.operation },
      deps,
    );
  } else if (sandboxInspection.authority === "externally-managed") {
    inspection = { authority: "externally-managed", inspection: sandboxInspection };
  } else if (sandboxInspection.authority === "owner-unknown") {
    inspection = qualifyRecordedSandboxPolicyAuthority(
      {
        sandboxName: input.sandboxName,
        gatewayName: input.gatewayName,
        recordedSandbox: input.recordedSandbox ?? null,
        readRecordedSandbox: input.readRecordedSandbox,
        inspection: sandboxInspection,
        operation: input.operation,
      },
      deps,
    );
  } else {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${input.operation}: the observed sandbox policy authority is invalid.`,
    );
  }

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
    const observed = inspection.inspection;
    const assertRequirements =
      observed.authority === "owner-unknown"
        ? assertObservedPolicyRequirements
        : assertExternalPolicyRequirements;
    assertRequirements({
      inspection: observed,
      requiredPolicy: parsedPolicy,
      operation: input.operation,
      sandboxName: input.sandboxName,
    });
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown;
  try {
    cleanupRequirement(requiredPolicy, input.operation);
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError !== undefined) {
    if (cleanupError !== undefined) {
      throw attachCleanupFailure(primaryError, cleanupError);
    }
    throw primaryError;
  }
  if (cleanupError !== undefined) throw cleanupError;
  return inspection;
}

function qualifyRecordedSandboxPolicyAuthority(
  input: {
    readonly sandboxName: string;
    readonly gatewayName: string;
    readonly recordedSandbox: SandboxEntry | null;
    readonly readRecordedSandbox?: (sandboxName: string) => SandboxEntry | null;
    readonly inspection: SandboxPolicyAuthorityInspection;
    readonly operation: string;
  },
  deps: PolicyAuthorityInspectionDeps,
): QualifiedSandboxPolicyAuthority {
  const recorded = input.recordedSandbox;
  const gatewayPort = recorded?.gatewayPort;
  if (
    !recorded?.policyAuthority ||
    recorded.pendingRouteReservation === true ||
    recorded.gatewayName !== input.gatewayName ||
    typeof gatewayPort !== "number" ||
    !Number.isSafeInteger(gatewayPort) ||
    typeof recorded.lifecycleGeneration !== "string" ||
    typeof recorded.lifecycleLiveIdentityFingerprint !== "string"
  ) {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${input.operation}: sandbox-scoped policy ownership is not durably verified.`,
      "owner-unknown",
    );
  }
  const inspectIdentity =
    deps.inspectOpenShellSandboxIdentityFingerprint ?? inspectOpenShellSandboxIdentityFingerprint;
  (deps.assertOpenShellGatewayPortBinding ?? assertOpenShellGatewayPortBinding)({
    gatewayName: input.gatewayName,
    gatewayPort,
  });
  const beforeIdentity = inspectIdentity({
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
  });
  if (beforeIdentity !== recorded.lifecycleLiveIdentityFingerprint) {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${input.operation}: the live sandbox identity does not match the recorded lifecycle.`,
      "owner-unknown",
    );
  }
  const confirmedInspection = (
    deps.inspectSandboxPolicyAuthority ?? inspectSandboxPolicyAuthority
  )({ sandboxName: input.sandboxName, gatewayName: input.gatewayName });
  const afterIdentity = inspectIdentity({
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
  });
  if (
    beforeIdentity !== afterIdentity ||
    confirmedInspection.authority !== "owner-unknown" ||
    confirmedInspection.policyIdentity.hash !== input.inspection.policyIdentity.hash ||
    confirmedInspection.policyIdentity.activeVersion !== input.inspection.policyIdentity.activeVersion
  ) {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${input.operation}: the sandbox or policy identity changed during verification.`,
      "owner-unknown",
    );
  }
  if (recorded.policyAuthority === "nemoclaw-managed") {
    try {
      assertNemoClawPolicyCreationReceiptMatches(recorded.policyCreationReceipt, {
        origin: "sandbox-create",
        gatewayName: input.gatewayName,
        gatewayPort,
        sandboxName: input.sandboxName,
        lifecycleGeneration: recorded.lifecycleGeneration,
        sandboxIdentityFingerprint: afterIdentity,
        policyHash: confirmedInspection.policyIdentity.hash,
        policyVersion: confirmedInspection.policyIdentity.activeVersion,
      });
    } catch {
      throw new PolicyAuthorityRefusalError(
        `Refusing to ${input.operation}: the NemoClaw policy creation receipt does not match the live sandbox policy.`,
        "owner-unknown",
      );
    }
  }
  const confirmedRecorded = input.readRecordedSandbox
    ? input.readRecordedSandbox(input.sandboxName)
    : recorded;
  if (
    !confirmedRecorded ||
    confirmedRecorded.pendingRouteReservation === true ||
    confirmedRecorded.policyAuthority !== recorded.policyAuthority ||
    !isDeepStrictEqual(confirmedRecorded.policyCreationReceipt, recorded.policyCreationReceipt) ||
    confirmedRecorded.lifecycleGeneration !== recorded.lifecycleGeneration ||
    confirmedRecorded.lifecycleLiveIdentityFingerprint !==
      recorded.lifecycleLiveIdentityFingerprint ||
    confirmedRecorded.gatewayName !== recorded.gatewayName ||
    confirmedRecorded.gatewayPort !== recorded.gatewayPort
  ) {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${input.operation}: the recorded sandbox policy boundary changed during live verification.`,
      "owner-unknown",
    );
  }
  if (recorded.policyAuthority === "nemoclaw-managed") {
    return { authority: "nemoclaw-managed" };
  }
  return {
    authority: "externally-managed",
    inspection: confirmedInspection,
  };
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
        recordedSandbox: observed.existingEntry,
        readRecordedSandbox: (name) => runtime.inspectSandboxForCreate(name).existingEntry,
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
        current.policyAuthority =
          inspection.authority === "externally-managed" ? "externally-managed" : null;
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
