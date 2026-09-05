// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { readCandidateQualificationReceipt } from "../../agent/candidate";
import { cloneAndDeepFreeze } from "../../core/immutable";
import { getVersion } from "../../core/version";
import type { SandboxEntry } from "../../state/registry/types";
import { cloneSandboxWorkloadReceipt } from "../../state/registry/workload";
import type { ResolvedCorporateCa } from "../corporate-ca-types";
import {
  isCandidateManagedImageAgent,
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageAgent,
  type ManagedImageContractV1,
  parseManagedImageContractV1,
} from "../managed-image/contract";
import {
  type BuiltManagedStartupOnboardProfile,
  buildManagedStartupOnboardProfile,
  type ManagedStartupOnboardProfileInput,
} from "../managed-startup/onboard-profile";
import type {
  ManagedStartupProfile,
  ManagedStartupReasoningEffort,
} from "../managed-startup/profile";
import type { RuntimeProviderBundle } from "../runtime-provider/contract";
import { requireRuntimeProviderMutationAuthority } from "../runtime-provider/registry";
import {
  type ManagedWorkloadAuthority,
  type ManagedWorkloadReceipt,
  readManagedWorkloadAuthority,
} from "./authority";

export type { ManagedWorkloadReceipt } from "./authority";

import {
  liveE2eManagedImageCatalog,
  liveE2eManagedImageRevision,
  type PreparedSandboxWorkloadSource,
  prepareSandboxWorkloadSource,
  SandboxWorkloadPreparationError,
} from "./preparation";
import {
  type ManagedImageWorkloadSource,
  managedImageRuntimePlatform,
  resolveSandboxWorkloadSource,
  type SandboxWorkloadRuntimeCapabilities,
} from "./source";

const HOST_PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export interface ManagedWorkloadRebuildCatalogHandoff {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly agent: ManagedImageAgent;
  /** Exact authority retained until a replacement has become Ready. */
  readonly previousReceipt: ManagedWorkloadReceipt;
  readonly previousContract: ManagedImageContractV1;
  readonly previousProfile: ManagedStartupProfile;
  /** Exact current-release image selected from one complete all-agent catalog. */
  readonly replacement: PreparedSandboxWorkloadSource & {
    readonly source: ManagedImageWorkloadSource;
  };
  /** Validated public CA material retained across a profile-only rebuild. */
  readonly corporateCa: ResolvedCorporateCa | null;
}

export interface ManagedWorkloadRebuildHandoff extends ManagedWorkloadRebuildCatalogHandoff {
  /**
   * Fully rendered replacement profile. It is prepared before any provider or
   * registry mutation, then consumed verbatim by the staged replacement.
   */
  readonly replacementProfile: BuiltManagedStartupOnboardProfile;
}

export class ManagedWorkloadRebuildError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Managed workload rebuild preflight failed: ${message}`, options);
    this.name = "ManagedWorkloadRebuildError";
  }
}

function requireProviderBoundAuthority(
  authority: ManagedWorkloadAuthority,
  runtime: SandboxWorkloadRuntimeCapabilities,
  provider: RuntimeProviderBundle,
): void {
  if (runtime.driverName !== provider.identity.id) {
    throw new ManagedWorkloadRebuildError(
      `runtime '${runtime.driverName}' does not match provider '${provider.identity.id}'`,
    );
  }
  requireRuntimeProviderMutationAuthority(provider, "rebuild");
  if (!provider.workload.acceptsReceipt(authority.receipt)) {
    throw new ManagedWorkloadRebuildError(
      `provider '${provider.identity.id}' does not accept the durable workload receipt`,
    );
  }
  const runtimePlatform = managedImageRuntimePlatform(runtime);
  if (runtimePlatform === null) {
    throw new ManagedWorkloadRebuildError(
      `provider '${provider.identity.id}' has no unambiguous managed-image host platform`,
    );
  }
  if (authority.contract.platform !== runtimePlatform) {
    throw new ManagedWorkloadRebuildError(
      `the recorded workload targets '${authority.contract.platform}', but provider ` +
        `'${provider.identity.id}' requires '${runtimePlatform}'`,
    );
  }
}

export const managedWorkloadRebuildDependencies = {
  prepareSandboxWorkloadSource,
};

/**
 * Validate the old receipt and provider bundle, then resolve the current CLI
 * release as a complete all-agent catalog before any mutation. Managed rebuild
 * never falls back to a Dockerfile or a mutable tag.
 */
export async function prepareManagedWorkloadRebuildHandoff(
  entry: Pick<SandboxEntry, "agent" | "fromDockerfile" | "imageTag" | "workload">,
  options: {
    readonly runtime: SandboxWorkloadRuntimeCapabilities;
    readonly provider: RuntimeProviderBundle;
    readonly version?: string;
  },
): Promise<ManagedWorkloadRebuildCatalogHandoff | null> {
  const authority = readManagedWorkloadAuthority(entry);
  if (!authority) return null;
  requireProviderBoundAuthority(authority, options.runtime, options.provider);

  let replacement: PreparedSandboxWorkloadSource;
  if (isCandidateManagedImageAgent(authority.agent)) {
    // A candidate publishes outside the all-agent release cohort, so its
    // replacement comes from the protected qualification receipt rather than
    // the current release catalog.
    let contract;
    try {
      contract = readCandidateQualificationReceipt(authority.agent);
    } catch (error) {
      throw new ManagedWorkloadRebuildError(
        "the protected candidate qualification receipt is unavailable or invalid",
        { cause: error },
      );
    }
    try {
      replacement = {
        source: resolveSandboxWorkloadSource({
          agentName: authority.agent,
          legacyDockerfilePath: "managed-rebuild-must-not-stage-this-dockerfile",
          runtime: options.runtime,
          catalog: { [authority.agent]: contract },
          policy: "require-managed",
          candidateAgentsEnabled: true,
        }),
        release: contract.source.release,
        fallbackDiagnostic: null,
      };
    } catch (error) {
      throw new ManagedWorkloadRebuildError(
        "the accepted candidate image is not supported by the selected runtime",
        { cause: error },
      );
    }
  } else {
    const qualificationRevision = liveE2eManagedImageRevision(process.env);
    const liveCatalog = liveE2eManagedImageCatalog(process.env);
    if (qualificationRevision && liveCatalog) {
      throw new ManagedWorkloadRebuildError(
        "live E2E managed-image revision and catalog authority conflict",
      );
    }
    try {
      replacement = await managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource({
        agentName: authority.agent,
        legacyDockerfilePath: "managed-rebuild-must-not-stage-this-dockerfile",
        runtime: options.runtime,
        version: options.version ?? getVersion(),
        policy: "require-managed",
        ...(liveCatalog
          ? {
              ...(liveCatalog.catalog ? { catalog: liveCatalog.catalog } : {}),
              catalogPath: liveCatalog.path,
              expectedCatalogRevision: liveCatalog.revision,
            }
          : {}),
        ...(qualificationRevision ? { catalogRevision: qualificationRevision } : {}),
      });
    } catch (error) {
      throw new ManagedWorkloadRebuildError(
        "the selected managed-image catalog is unavailable or invalid",
        { cause: error },
      );
    }
  }
  if (replacement.source.kind !== "managed-image") {
    throw new ManagedWorkloadRebuildError(
      "the current release did not resolve to an immutable managed image",
    );
  }

  return cloneAndDeepFreeze({
    schemaVersion: 1 as const,
    providerId: options.provider.identity.id,
    agent: authority.agent,
    previousReceipt: authority.receipt,
    previousContract: authority.contract,
    previousProfile: authority.profile,
    replacement: {
      ...replacement,
      source: replacement.source,
    },
    corporateCa: authority.corporateCa,
  });
}

/** Revalidate the retained handoff against the live registry row and provider. */
export function managedWorkloadRebuildHandoffMatchesEntry(
  handoff: ManagedWorkloadRebuildCatalogHandoff,
  entry: Pick<SandboxEntry, "agent" | "fromDockerfile" | "imageTag" | "workload"> | null,
  provider: RuntimeProviderBundle,
): boolean {
  if (!entry || provider.identity.id !== handoff.providerId) return false;
  try {
    const current = readManagedWorkloadAuthority(entry);
    return (
      current !== null &&
      current.agent === handoff.agent &&
      provider.workload.acceptsReceipt(current.receipt) &&
      isDeepStrictEqual(current.receipt, handoff.previousReceipt) &&
      isDeepStrictEqual(current.contract, handoff.previousContract) &&
      isDeepStrictEqual(current.profile, handoff.previousProfile)
    );
  } catch {
    return false;
  }
}

export interface ManagedWorkloadRebuildProfileOverrides {
  readonly openClawContextWindow?: number;
  readonly openClawReasoning?: boolean;
  readonly openClawReasoningEffort?: ManagedStartupReasoningEffort;
}

/**
 * Keep the source sandbox's proxy contract while allowing every other
 * profile-backed rebuild setting to come from current authoritative intent.
 * Credential-bearing proxy values remain launch-only and are reacquired from
 * the operator environment only when the durable receipt requires replay.
 */
export function managedWorkloadRebuildProfileEnvironment(
  handoff: ManagedWorkloadRebuildCatalogHandoff,
  environment: NodeJS.ProcessEnv,
  overrides: ManagedWorkloadRebuildProfileOverrides = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    NEMOCLAW_PROXY_HOST: handoff.previousProfile.proxy.managedHost,
    NEMOCLAW_PROXY_PORT: String(handoff.previousProfile.proxy.managedPort),
  };
  const previous = handoff.previousProfile;
  if (previous.agent === "openclaw" && previous.agentConfig.agent === "openclaw") {
    const config = previous.agentConfig;
    const contextWindow = overrides.openClawContextWindow ?? previous.tuning.contextWindow;
    if (contextWindow !== null) result.NEMOCLAW_CONTEXT_WINDOW = String(contextWindow);
    if (previous.tuning.maxTokens !== null) {
      result.NEMOCLAW_MAX_TOKENS = String(previous.tuning.maxTokens);
    }
    const reasoning = overrides.openClawReasoning ?? previous.tuning.reasoning;
    if (reasoning !== null) result.NEMOCLAW_REASONING = String(reasoning);
    const reasoningEffort = overrides.openClawReasoningEffort ?? previous.tuning.reasoningEffort;
    if (reasoningEffort !== null) result.NEMOCLAW_REASONING_EFFORT = reasoningEffort;
    if (previous.inference.inputModalities !== null) {
      result.NEMOCLAW_INFERENCE_INPUTS = previous.inference.inputModalities.join(",");
    }
    result.NEMOCLAW_AGENT_TIMEOUT = String(config.agentTimeoutSeconds);
    if (config.heartbeatEvery !== null) {
      result.NEMOCLAW_AGENT_HEARTBEAT_EVERY = config.heartbeatEvery;
    }
    result.NEMOCLAW_EXTRA_AGENTS_JSON_B64 = Buffer.from(
      JSON.stringify(config.extraAgents),
      "utf8",
    ).toString("base64");
    result.NEMOCLAW_MINIMAL_BOOTSTRAP = config.minimalBootstrap ? "1" : "0";
    result.NEMOCLAW_OPENCLAW_OTEL = config.otel.enabled ? "1" : "0";
    result.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT = config.otel.endpointUrl;
    result.NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME = config.otel.serviceName;
    result.NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE = String(config.otel.sampleRate);
  } else if (previous.agent === "hermes" && previous.tuning.contextWindow !== null) {
    result.NEMOCLAW_CONTEXT_WINDOW = String(previous.tuning.contextWindow);
  }

  if (handoff.previousReceipt.credentialProxyReplayRequired) {
    for (const name of HOST_PROXY_ENV_NAMES) {
      const value = environment[name];
      if (value !== undefined) result[name] = value;
    }
    return result;
  }
  const proxy = handoff.previousProfile.proxy;
  if (proxy.hostHttpUrl) result.HTTP_PROXY = proxy.hostHttpUrl;
  if (proxy.hostHttpsUrl) result.HTTPS_PROXY = proxy.hostHttpsUrl;
  if (proxy.hostNoProxy.length > 0) result.NO_PROXY = proxy.hostNoProxy.join(",");
  return result;
}

type ManagedWorkloadRebuildProfileInput = Omit<
  ManagedStartupOnboardProfileInput,
  "agentName" | "environment" | "corporateCa"
>;

/**
 * Render every fallible replacement-profile input while the old workload is
 * authoritative. Mutable rebuild state is explicit; receipt-only tuning,
 * managed proxy intent, and public CA material come from validated authority.
 */
export function stageManagedWorkloadRebuildProfile(
  handoff: ManagedWorkloadRebuildCatalogHandoff,
  input: ManagedWorkloadRebuildProfileInput,
  environment: NodeJS.ProcessEnv = process.env,
  overrides: ManagedWorkloadRebuildProfileOverrides = {},
): ManagedWorkloadRebuildHandoff {
  let replacementProfile: BuiltManagedStartupOnboardProfile;
  try {
    replacementProfile = buildManagedStartupOnboardProfile({
      ...input,
      agentName: handoff.agent,
      environment: managedWorkloadRebuildProfileEnvironment(handoff, environment, overrides),
      corporateCa: handoff.corporateCa,
    });
  } catch (error) {
    throw new ManagedWorkloadRebuildError(
      `the replacement startup profile could not be rendered from authoritative rebuild state: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (
    replacementProfile.credentialProxyReplayRequired !==
    handoff.previousReceipt.credentialProxyReplayRequired
  ) {
    throw new ManagedWorkloadRebuildError(
      "the replacement startup profile changed the durable credential-proxy requirement",
    );
  }
  if (replacementProfile.profile.agent !== handoff.agent) {
    throw new ManagedWorkloadRebuildError(
      "the replacement startup profile does not match the selected managed-image agent",
    );
  }
  return cloneAndDeepFreeze({ ...handoff, replacementProfile });
}

/**
 * Bind a retained replacement contract to the selected provider capability.
 * The same immutable source resolver used by fresh onboarding performs the
 * check; no mutable release pointer is consulted.
 */
export function prepareSandboxWorkloadSourceFromRebuildHandoff(
  handoff: ManagedWorkloadRebuildCatalogHandoff,
  runtime: SandboxWorkloadRuntimeCapabilities,
  provider: RuntimeProviderBundle,
): PreparedSandboxWorkloadSource {
  if (runtime.driverName !== provider.identity.id || handoff.providerId !== provider.identity.id) {
    throw new SandboxWorkloadPreparationError(
      "the rebuild handoff does not belong to the selected runtime provider",
    );
  }
  let source;
  try {
    source = resolveSandboxWorkloadSource({
      agentName: handoff.agent,
      legacyDockerfilePath: "",
      runtime,
      catalog: { [handoff.agent]: handoff.replacement.source.contract },
      policy: "require-managed",
      candidateAgentsEnabled: isCandidateManagedImageAgent(handoff.agent),
    });
  } catch (error) {
    throw new SandboxWorkloadPreparationError(
      "the recorded managed workload is not supported by the selected runtime",
      { cause: error },
    );
  }
  if (source.kind !== "managed-image") {
    throw new SandboxWorkloadPreparationError(
      "the recorded managed workload did not resolve to an immutable image",
    );
  }
  if (
    source.reference !== handoff.replacement.source.reference ||
    source.contract.source.cohort !== handoff.replacement.source.contract.source.cohort ||
    source.contract.source.revision !== handoff.replacement.source.contract.source.revision
  ) {
    throw new SandboxWorkloadPreparationError(
      "the recorded managed workload changed during source resolution",
    );
  }
  if (
    source.contract.capabilityContractVersion !== MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION ||
    source.contract.startupProfileContractVersion !== MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION
  ) {
    throw new SandboxWorkloadPreparationError(
      "the recorded managed workload uses an unsupported contract version",
    );
  }
  return { source, release: handoff.replacement.release, fallbackDiagnostic: null };
}

/**
 * Materialize the exact durable replacement receipt only after the profile is
 * completely rendered. The receipt remains a shared-image authority and is
 * never eligible for per-sandbox image deletion.
 */
export function buildManagedWorkloadRebuildReceipt(
  handoff: ManagedWorkloadRebuildHandoff,
  provider: RuntimeProviderBundle,
): ManagedWorkloadReceipt {
  if (handoff.providerId !== provider.identity.id) {
    throw new ManagedWorkloadRebuildError(
      "the replacement receipt does not belong to the selected provider",
    );
  }
  let contract: ManagedImageContractV1;
  try {
    contract = parseManagedImageContractV1(
      handoff.replacement.source.contract,
      handoff.agent,
      handoff.previousContract.platform,
    );
  } catch (error) {
    throw new ManagedWorkloadRebuildError(
      "the replacement image contract does not match the exact rebuild agent and platform",
      { cause: error },
    );
  }
  if (handoff.replacement.source.reference !== contract.reference) {
    throw new ManagedWorkloadRebuildError(
      "the replacement image source does not match its immutable image contract",
    );
  }
  const profile = handoff.replacementProfile;
  if (profile.profile.agent !== handoff.agent) {
    throw new ManagedWorkloadRebuildError(
      "the replacement startup profile does not match the exact rebuild agent",
    );
  }
  const receipt: ManagedWorkloadReceipt = {
    schemaVersion: 1,
    kind: "managed-image",
    reference: contract.reference,
    platform: contract.platform,
    release: contract.source.release,
    sourceRevision: contract.source.revision,
    sourceCohort: contract.source.cohort,
    capabilityContractVersion: contract.capabilityContractVersion,
    startupProfileContractVersion: contract.startupProfileContractVersion,
    encodedProfile: profile.encodedProfile,
    startupProfileSha256: profile.startupProfileSha256,
    credentialProxyReplayRequired: profile.credentialProxyReplayRequired,
    ...(profile.corporateCaB64 === undefined ? {} : { corporateCaB64: profile.corporateCaB64 }),
    shared: true,
  };
  const validatedReceipt = cloneSandboxWorkloadReceipt(receipt);
  if (validatedReceipt?.kind !== "managed-image" || !isDeepStrictEqual(validatedReceipt, receipt)) {
    throw new ManagedWorkloadRebuildError(
      "the replacement startup profile and image contract do not form valid durable authority",
    );
  }
  if (!provider.workload.acceptsReceipt(validatedReceipt)) {
    throw new ManagedWorkloadRebuildError(
      `provider '${provider.identity.id}' rejected the replacement workload receipt`,
    );
  }
  return cloneAndDeepFreeze(validatedReceipt);
}
