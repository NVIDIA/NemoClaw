// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type { SandboxPolicyAuthority } from "../adapters/openshell/policy-authority";
import type { AgentDefinition } from "../agent/defs";
import type { InferenceEndpointSource, InferenceSelection } from "../inference/selection";
import { inferenceSelectionRegistryFields, normalizeInferenceSelection } from "../inference/selection";
import { type WebSearchConfig, webSearchProviderForConfig } from "../inference/web-search";
import * as onboardSession from "../state/onboard-session";
import type { OpenClawImagePluginInstall } from "../state/openclaw-plugin-restore";
import type {
  BaselineExclusionEntry,
  SandboxEntry,
  SandboxMcpState,
  SandboxMessagingState,
} from "../state/registry";
import * as registry from "../state/registry";
import {
  cloneSandboxHostLocalInferenceProvenance,
  cloneSandboxHostLocalInferenceReceipt,
  requireSandboxHostLocalInferenceProvenance,
} from "../state/registry/host-local-inference";
import type { QualifiedSandboxInferenceRouteReservation } from "../state/registry/route-reservation";
import { cloneSandboxWorkloadReceipt } from "../state/registry/workload";
import { DEFAULT_TOOL_DISCLOSURE, type ToolDisclosure } from "../tool-disclosure";
import type { DcodeAutoApprovalMode } from "./dcode-auto-approval";
import { cloneSandboxHostMounts } from "../state/registry/host-mount";
import { resolveOnboardHermesApiPort } from "./hermes-api-port";
import { isManagedImageAgent, MANAGED_IMAGE_REPOSITORIES } from "./managed-image/contract";
import {
  getHermesDashboardRegistryFields,
  type HermesDashboardOnboardState,
} from "./hermes-dashboard";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  RuntimeProviderBundleRegistry,
  RuntimeProviderSelectionError,
  requireRuntimeProviderBundleForSandbox,
  requireRuntimeProviderMutationAuthority,
} from "./runtime-provider/access";
import { getRequestedSandboxAgentName, getSandboxAgentRegistryFields } from "./sandbox-agent";
import {
  classifyPortableLifecycleReceipt,
  portableLifecycleReceiptMatchesGeneration,
} from "./experimental/portable-runtime-receipt-readiness";

export type CreatedSandboxRuntimeFields = Pick<
  SandboxEntry,
  | "gpuEnabled"
  | "hostGpuDetected"
  | "sandboxGpuEnabled"
  | "sandboxGpuMode"
  | "sandboxGpuDevice"
  | "sandboxGpuProof"
  | "openshellDriver"
  | "openshellVersion"
>;

export interface CreatedSandboxRegistryEntryInput {
  sandboxName: string;
  inferenceSelection: InferenceSelection;
  runtimeFields: CreatedSandboxRuntimeFields;
  agent: AgentDefinition | null | undefined;
  agentVersionKnown: boolean;
  imageTag: string | null;
  workload?: SandboxEntry["workload"];
  hostLocalInferenceReceipt?: SandboxEntry["hostLocalInferenceReceipt"];
  hostLocalInferenceProvenance?: SandboxEntry["hostLocalInferenceProvenance"];
  openclawImagePluginInstalls?: readonly OpenClawImagePluginInstall[];
  appliedPolicies: string[];
  policyAuthority?: SandboxPolicyAuthority;
  toolDisclosure?: ToolDisclosure;
  observabilityEnabled?: boolean;
  dcodeAutoApprovalMode?: DcodeAutoApprovalMode;
  policyTier?: SandboxEntry["policyTier"];
  baselineExclusions?: readonly BaselineExclusionEntry[];
  webSearchEnabled?: boolean;
  webSearchProvider?: SandboxEntry["webSearchProvider"];
  fromDockerfile?: string | null;
  hermesAuthMethod?: "oauth" | "api_key" | null;
  plannedMessagingState: SandboxMessagingState | undefined;
  /**
   * Durable MCP rebuild manifest carried across an already-absent sandbox.
   * The caller must only supply state captured from the same sandbox name.
   */
  preservedMcpState?: SandboxMcpState;
  hermesToolGateways: string[];
  hermesDashboardState: HermesDashboardOnboardState;
  /** Host port this sandbox exposes its OpenAI-compatible API on. */
  hermesApiPort?: number | null;
  /** True only when schema-5 receipt authority owns this Hermes registration. */
  hermesPortableLifecycle?: boolean;
  dashboardPort: number;
  dashboardRemoteBindPrepared?: boolean;
  lifecycleGeneration?: string;
  lifecycleLiveIdentityFingerprint?: string;
  gatewayName: string;
  gatewayPort: number;
  hostMounts?: readonly import("../state/registry/types").SandboxHostMount[];
}

export interface CreatedSandboxRegistrationInput extends CreatedSandboxRegistryEntryInput {
  portableLifecycle?: boolean;
  environment?: NodeJS.ProcessEnv;
  classifyPortableLifecycleReceipt?: typeof classifyPortableLifecycleReceipt;
  inferenceRouteReservation?: QualifiedSandboxInferenceRouteReservation;
  reservationSessionId?: string;
  registerSandbox?(
    entry: SandboxEntry,
    routeReservation?: QualifiedSandboxInferenceRouteReservation,
    options?: { pending?: boolean; reservationSessionId?: string },
  ): SandboxEntry | void;
  runtimeProviders?: RuntimeProviderBundleRegistry;
}

export function creationFidelity(
  webSearchConfig: WebSearchConfig | null,
  fromDockerfile: string | null,
  hermesAuthMethod: "oauth" | "api_key" | null,
  dashboardRemoteBindPrepared?: boolean,
  baselineExclusions?: readonly BaselineExclusionEntry[],
): Pick<
  SandboxEntry,
  | "webSearchEnabled"
  | "webSearchProvider"
  | "fromDockerfile"
  | "hermesAuthMethod"
  | "dashboardRemoteBindPrepared"
  | "baselineExclusions"
> {
  return {
    webSearchEnabled: webSearchConfig?.fetchEnabled === true,
    webSearchProvider: webSearchConfig ? webSearchProviderForConfig(webSearchConfig) : null,
    fromDockerfile,
    hermesAuthMethod,
    dashboardRemoteBindPrepared: dashboardRemoteBindPrepared === true,
    baselineExclusions: baselineExclusions?.map((exclusion) => ({ ...exclusion })),
  };
}

/** Snapshot complete exclusion records before a destructive create removes registry state. */
export function baselineExclusionsForCreate(sandboxName: string): BaselineExclusionEntry[] {
  const transition = registry.getBaselineExclusionTransition(sandboxName);
  if (transition) {
    const key = transition.exclusion.key;
    throw new Error(
      `Baseline policy ${transition.operation} for '${key}' needs repair before sandbox creation. Re-run 'policy ${transition.operation} ${key}' first.`,
    );
  }
  return registry.getBaselineExclusions(sandboxName).map((exclusion) => ({ ...exclusion }));
}

/**
 * Re-read exclusion intent at the destructive create edge and prove it still
 * matches the already-resolved policy plan. The sandbox mutation lock is the
 * caller's serialization boundary; this comparison catches stale plans and
 * any direct registry writer that bypassed that lock.
 */
export function assertBaselineExclusionsMatchCreateIntent(
  sandboxName: string,
  planned: readonly BaselineExclusionEntry[],
): BaselineExclusionEntry[] {
  const current = baselineExclusionsForCreate(sandboxName);
  if (!isDeepStrictEqual(current, [...planned])) {
    throw new Error(
      `Baseline policy exclusions for '${sandboxName}' changed while sandbox creation was being prepared. Retry so the replacement policy uses current registry intent.`,
    );
  }
  return current;
}

export function selection(
  sandboxName: string,
  provider: string,
  model: string,
  preferredInferenceApi: string | null,
  endpointSource: InferenceEndpointSource | null,
): InferenceSelection {
  const session = onboardSession.loadSession();
  const sessionMatches =
    session?.sandboxName === sandboxName &&
    session.provider === provider &&
    session.model === model;
  return inferenceSelectionRegistryFields({
    provider,
    model,
    endpointUrl: sessionMatches ? (session.endpointUrl ?? null) : null,
    endpointSource: sessionMatches ? endpointSource : null,
    credentialEnv: sessionMatches ? (session.credentialEnv ?? null) : null,
    preferredInferenceApi,
    compatibleEndpointReasoning: sessionMatches
      ? (session.compatibleEndpointReasoning ?? null)
      : null,
    compatibleEndpointReasoningEffort: sessionMatches
      ? (session.compatibleEndpointReasoningEffort ?? null)
      : null,
    nimContainer: sessionMatches ? (session.nimContainer ?? null) : null,
  });
}

export function buildCreatedSandboxRegistryEntry(
  input: CreatedSandboxRegistryEntryInput,
): SandboxEntry {
  const session = onboardSession.loadSession();
  const servingProfileProvenance =
    session?.sandboxName === input.sandboxName
      ? (session.servingProfileProvenance ?? undefined)
      : undefined;
  const messagingState =
    input.plannedMessagingState?.plan.sandboxName === input.sandboxName
      ? input.plannedMessagingState
      : undefined;
  const workload = cloneSandboxWorkloadReceipt(input.workload);
  if (input.workload !== undefined && workload === undefined) {
    throw new RuntimeProviderSelectionError(
      "Sandbox workload ownership receipt failed closed validation.",
    );
  }
  const hostLocalInferenceReceipt = cloneSandboxHostLocalInferenceReceipt(
    input.hostLocalInferenceReceipt,
  );
  if (input.hostLocalInferenceReceipt !== undefined && hostLocalInferenceReceipt === undefined) {
    throw new RuntimeProviderSelectionError(
      "Sandbox host-local inference receipt failed closed validation.",
    );
  }
  const hostLocalInferenceProvenance = cloneSandboxHostLocalInferenceProvenance(
    input.hostLocalInferenceProvenance,
  );
  if (
    input.hostLocalInferenceProvenance !== undefined &&
    (!hostLocalInferenceProvenance || typeof hostLocalInferenceReceipt !== "string")
  ) {
    throw new RuntimeProviderSelectionError(
      "Sandbox host-local inference provenance failed closed validation.",
    );
  }
  if (hostLocalInferenceProvenance && typeof hostLocalInferenceReceipt === "string") {
    requireSandboxHostLocalInferenceProvenance(
      hostLocalInferenceProvenance,
      hostLocalInferenceReceipt,
    );
  }
  const agentFields = getSandboxAgentRegistryFields(input.agent, input.agentVersionKnown);
  if (workload?.kind === "managed-image") {
    const requestedAgent = getRequestedSandboxAgentName(input.agent);
    if (
      !isManagedImageAgent(requestedAgent) ||
      !workload.reference.startsWith(`${MANAGED_IMAGE_REPOSITORIES[requestedAgent]}@sha256:`)
    ) {
      throw new RuntimeProviderSelectionError(
        "Sandbox agent identity does not match its managed workload receipt.",
      );
    }
    agentFields.agent = requestedAgent;
  }

  return {
    name: input.sandboxName,
    servingProfileProvenance,
    ...inferenceSelectionRegistryFields(input.inferenceSelection),
    ...input.runtimeFields,
    ...agentFields,
    imageTag: input.imageTag,
    workload,
    ...(hostLocalInferenceReceipt !== undefined ? { hostLocalInferenceReceipt } : {}),
    ...(hostLocalInferenceProvenance ? { hostLocalInferenceProvenance } : {}),
    ...(input.openclawImagePluginInstalls !== undefined
      ? {
          openclawImagePluginInstalls: input.openclawImagePluginInstalls.map((install) => ({
            ...install,
            ...(install.loadPaths !== undefined ? { loadPaths: [...install.loadPaths] } : {}),
          })),
        }
      : {}),
    policies: input.appliedPolicies,
    ...(input.policyAuthority !== undefined ? { policyAuthority: input.policyAuthority } : {}),
    baselineExclusions: input.baselineExclusions?.map((exclusion) => ({ ...exclusion })),
    toolDisclosure: input.toolDisclosure ?? DEFAULT_TOOL_DISCLOSURE,
    observabilityEnabled: input.observabilityEnabled === true,
    ...(input.dcodeAutoApprovalMode !== undefined
      ? { dcodeAutoApprovalMode: input.dcodeAutoApprovalMode }
      : {}),
    ...(input.policyTier !== undefined ? { policyTier: input.policyTier } : {}),
    webSearchEnabled: input.webSearchEnabled === true,
    webSearchProvider:
      input.webSearchEnabled === true ? (input.webSearchProvider ?? "brave") : null,
    fromDockerfile: input.fromDockerfile ?? null,
    hermesAuthMethod: input.hermesAuthMethod ?? null,
    messaging: messagingState,
    mcp: input.preservedMcpState,
    hermesToolGateways:
      input.hermesToolGateways.length > 0 ? [...input.hermesToolGateways] : undefined,
    ...getHermesDashboardRegistryFields(input.hermesDashboardState),
    hermesApiPort:
      input.agent?.name === "hermes"
        ? input.hermesPortableLifecycle === true
          ? undefined
          : (input.hermesApiPort ??
            resolveOnboardHermesApiPort(input.sandboxName, {
              // Registration follows a successful create/recreate that applied this environment.
              allowRegisteredOverride: true,
            }))
        : undefined,
    dashboardPort: input.dashboardPort,
    dashboardRemoteBindPrepared: input.dashboardRemoteBindPrepared === true,
    lifecycleGeneration: input.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: input.lifecycleLiveIdentityFingerprint,
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
    ...(input.hostMounts && input.hostMounts.length > 0
      ? { hostMounts: cloneSandboxHostMounts(input.hostMounts) }
      : {}),
  };
}

/** Load the immutable choices needed by command-level resume validation. */
export function loadOnboardCommandResumeSession(): {
  servingProfileProvenance: onboardSession.Session["servingProfileProvenance"];
  vllmGpuDevice: onboardSession.Session["vllmGpuDevice"];
} | null {
  const session = onboardSession.loadSession();
  return session
    ? {
        servingProfileProvenance: session.servingProfileProvenance,
        vllmGpuDevice: session.vllmGpuDevice,
      }
    : null;
}

export function registerCreatedSandbox(input: CreatedSandboxRegistrationInput): SandboxEntry {
  const pending = input.inferenceRouteReservation?.entry ?? registry.getSandbox(input.sandboxName);
  const pendingRoute =
    input.reservationSessionId && pending
      ? registry.normalizeSandboxInferenceRouteSelection(normalizeInferenceSelection(pending))
      : null;
  const pendingHostLocalInferenceReceipt =
    input.hostLocalInferenceReceipt !== undefined
      ? input.hostLocalInferenceReceipt
      : pending?.hostLocalInferenceReceipt;
  const pendingHostLocalInferenceProvenance =
    input.hostLocalInferenceProvenance !== undefined
      ? input.hostLocalInferenceProvenance
      : pending?.hostLocalInferenceProvenance;
  const entry = buildCreatedSandboxRegistryEntry({
    ...input,
    inferenceSelection: pendingRoute
      ? { ...input.inferenceSelection, ...pendingRoute }
      : input.inferenceSelection,
    ...(pendingHostLocalInferenceReceipt === undefined
      ? {}
      : { hostLocalInferenceReceipt: pendingHostLocalInferenceReceipt }),
    ...(pendingHostLocalInferenceProvenance === undefined
      ? {}
      : { hostLocalInferenceProvenance: pendingHostLocalInferenceProvenance }),
  });
  if (input.portableLifecycle === true) {
    if (getRequestedSandboxAgentName(input.agent) !== "openclaw") {
      throw new RuntimeProviderSelectionError(
        "Portable lifecycle registration requires the OpenClaw agent.",
      );
    }
    const receipt = (input.classifyPortableLifecycleReceipt ?? classifyPortableLifecycleReceipt)(
      input.sandboxName,
      { env: input.environment ?? process.env },
    );
    if (!portableLifecycleReceiptMatchesGeneration(receipt, input.lifecycleGeneration)) {
      throw new RuntimeProviderSelectionError(
        "Portable OpenClaw registration requires a current lifecycle receipt that matches the registry generation.",
      );
    }
    entry.agent = "openclaw";
  }
  const provider = requireRuntimeProviderBundleForSandbox(
    entry,
    input.runtimeProviders ?? CURRENT_RUNTIME_PROVIDER_BUNDLES,
  );
  requireRuntimeProviderMutationAuthority(provider, "registration");
  if (!provider.workload.acceptsReceipt(entry.workload)) {
    throw new RuntimeProviderSelectionError(
      `Runtime provider '${provider.identity.id}' does not accept the registered workload receipt.`,
    );
  }
  const writeRegistry = input.registerSandbox ?? registry.registerSandbox;
  const pendingOptions = input.reservationSessionId
    ? { pending: true as const, reservationSessionId: input.reservationSessionId }
    : undefined;
  const registered =
    input.inferenceRouteReservation || pendingOptions
      ? writeRegistry(entry, input.inferenceRouteReservation, pendingOptions)
      : writeRegistry(entry);
  return registered ?? entry;
}
