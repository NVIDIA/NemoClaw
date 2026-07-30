// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { getVersion } from "../../core/version";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry/types";
import { cloneSandboxWorkloadReceipt } from "../../state/registry/workload";
import type { ResolvedCorporateCa } from "../corporate-ca-types";
import {
  isShippedManagedImageAgent,
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORMS,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageContractV1,
  parseManagedImageContractV1,
  type ShippedManagedImageAgent,
} from "../managed-image/contract";
import { validateManagedStartupCorporateCaTransport } from "../managed-startup/application";
import {
  type BuiltManagedStartupOnboardProfile,
  buildManagedStartupOnboardProfile,
  type ManagedStartupOnboardProfileInput,
} from "../managed-startup/onboard-profile";
import {
  decodeManagedStartupProfile,
  type ManagedStartupProfile,
  type ManagedStartupReasoningEffort,
} from "../managed-startup/profile";
import {
  type PreparedSandboxWorkloadSource,
  prepareSandboxWorkloadSource,
  SandboxWorkloadPreparationError,
} from "./preparation";
import {
  type ManagedImageWorkloadSource,
  resolveSandboxWorkloadSource,
  type SandboxWorkloadRuntimeCapabilities,
} from "./source";

const MANAGED_REFERENCE_PREFIX = "ghcr.io/nvidia/nemoclaw/";
const HOST_PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

type ManagedWorkloadReceipt = Extract<SandboxWorkloadReceipt, { kind: "managed-image" }>;

export interface ManagedWorkloadRebuildCatalogHandoff {
  readonly schemaVersion: 1;
  readonly agent: ShippedManagedImageAgent;
  /** Pre-delete and rollback authority for the workload that is being replaced. */
  readonly previousReceipt: ManagedWorkloadReceipt;
  readonly previousContract: ManagedImageContractV1;
  readonly previousProfile: ManagedStartupProfile;
  /** Exact current-release image selected from one complete all-agent catalog. */
  readonly replacement: PreparedSandboxWorkloadSource & {
    readonly source: ManagedImageWorkloadSource;
  };
  /** Validated CA material retained across a profile-only rebuild. */
  readonly corporateCa: ResolvedCorporateCa | null;
}

export interface ManagedWorkloadRebuildHandoff extends ManagedWorkloadRebuildCatalogHandoff {
  /**
   * Fully rendered replacement profile. It is prepared before the outer
   * rebuild mutates the registry or destroys the old sandbox, then consumed
   * verbatim by inner onboarding.
   */
  readonly replacementProfile: BuiltManagedStartupOnboardProfile;
}

export class ManagedWorkloadRebuildError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Managed workload rebuild preflight failed: ${message}`, options);
    this.name = "ManagedWorkloadRebuildError";
  }
}

function isManagedImageReference(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(MANAGED_REFERENCE_PREFIX);
}

function exactAgent(value: string): ShippedManagedImageAgent {
  if (isShippedManagedImageAgent(value)) return value;
  throw new ManagedWorkloadRebuildError(`'${value}' is not a shipped managed-image agent`);
}

function contractFromReceipt(
  receipt: ManagedWorkloadReceipt,
  agent: ShippedManagedImageAgent,
): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digest = receipt.reference.slice(`${image}@`.length);
  return parseManagedImageContractV1(
    {
      contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
      agent,
      // Managed-image receipts predating the multi-architecture contract were
      // published only for linux/amd64. New receipts always persist platform.
      platform: receipt.platform ?? MANAGED_IMAGE_PLATFORMS[0],
      image,
      digest,
      reference: receipt.reference,
      source: {
        repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
        revision: receipt.sourceRevision,
        release: receipt.release,
        cohort: receipt.sourceCohort,
      },
      startupProfileContractVersion: receipt.startupProfileContractVersion,
      capabilityContractVersion: receipt.capabilityContractVersion,
    },
    agent,
  );
}

function validateCorporateCaTransport(
  receipt: ManagedWorkloadReceipt,
  profile: ManagedStartupProfile,
): ResolvedCorporateCa | null {
  let bytes: Buffer | null;
  try {
    bytes = validateManagedStartupCorporateCaTransport(receipt.corporateCaB64, profile);
  } catch (error) {
    throw new ManagedWorkloadRebuildError(
      "the corporate CA transport does not match the recorded startup profile",
      { cause: error },
    );
  }
  return bytes === null
    ? null
    : {
        pem: bytes.toString("utf8"),
        sourcePath: "managed-workload-rebuild-receipt",
        sourceEnv: "managed-workload-rebuild-receipt",
      };
}

/**
 * Validate the immutable workload and canonical secret-free startup profile
 * recorded for the sandbox being replaced.
 */
function readManagedWorkloadRebuildAuthority(
  entry: Pick<SandboxEntry, "agent" | "fromDockerfile" | "imageTag" | "workload">,
): {
  agent: ShippedManagedImageAgent;
  receipt: ManagedWorkloadReceipt;
  contract: ManagedImageContractV1;
  profile: ManagedStartupProfile;
  corporateCa: ResolvedCorporateCa | null;
} | null {
  const recordedWorkload = entry.workload;
  const managedLooking =
    isManagedImageReference(entry.imageTag) ||
    (recordedWorkload !== undefined && recordedWorkload.kind === "managed-image");
  if (!managedLooking) return null;

  const cloned = cloneSandboxWorkloadReceipt(recordedWorkload);
  if (cloned?.kind !== "managed-image") {
    throw new ManagedWorkloadRebuildError(
      "the managed image has no valid durable workload receipt",
    );
  }
  if (entry.imageTag !== cloned.reference) {
    throw new ManagedWorkloadRebuildError(
      "the registry image reference does not match the durable workload receipt",
    );
  }
  if (entry.fromDockerfile) {
    throw new ManagedWorkloadRebuildError(
      "a managed image receipt cannot be combined with a custom Dockerfile",
    );
  }

  const agent = exactAgent(entry.agent?.trim() || "openclaw");
  const contract = contractFromReceipt(cloned, agent);
  let profile: ManagedStartupProfile;
  try {
    profile = decodeManagedStartupProfile(cloned.encodedProfile);
  } catch (error) {
    throw new ManagedWorkloadRebuildError("the recorded startup profile is invalid", {
      cause: error,
    });
  }
  if (profile.agent !== agent) {
    throw new ManagedWorkloadRebuildError(
      `the recorded startup profile belongs to '${profile.agent}', not '${agent}'`,
    );
  }
  const corporateCa = validateCorporateCaTransport(cloned, profile);

  return {
    agent,
    receipt: cloned,
    contract,
    profile,
    corporateCa,
  };
}

export const managedWorkloadRebuildDependencies = {
  prepareSandboxWorkloadSource,
};

/**
 * Validate the old receipt, then resolve the current CLI release as a complete
 * all-agent catalog before any mutation. Managed rebuild never falls back to a
 * Dockerfile and never turns an upgrade into reuse of the stale image.
 */
export async function prepareManagedWorkloadRebuildHandoff(
  entry: Pick<SandboxEntry, "agent" | "fromDockerfile" | "imageTag" | "workload">,
  options: {
    readonly runtime: SandboxWorkloadRuntimeCapabilities;
    readonly version?: string;
  },
): Promise<ManagedWorkloadRebuildCatalogHandoff | null> {
  const authority = readManagedWorkloadRebuildAuthority(entry);
  if (!authority) return null;

  let replacement: PreparedSandboxWorkloadSource;
  try {
    replacement = await managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource({
      agentName: authority.agent,
      legacyDockerfilePath: "managed-rebuild-must-not-stage-this-dockerfile",
      runtime: options.runtime,
      version: options.version ?? getVersion(),
      policy: "require-managed",
    });
  } catch (error) {
    throw new ManagedWorkloadRebuildError(
      "the current release's complete managed-image catalog is unavailable or invalid",
      { cause: error },
    );
  }
  if (replacement.source.kind !== "managed-image") {
    throw new ManagedWorkloadRebuildError(
      "the current release did not resolve to an immutable managed image",
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
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

/** Revalidate the retained handoff against the live registry row. */
export function managedWorkloadRebuildHandoffMatchesEntry(
  handoff: ManagedWorkloadRebuildCatalogHandoff,
  entry: Pick<SandboxEntry, "agent" | "fromDockerfile" | "imageTag" | "workload"> | null,
): boolean {
  if (!entry) return false;
  try {
    const current = readManagedWorkloadRebuildAuthority(entry);
    return (
      current !== null &&
      current.agent === handoff.agent &&
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
 * profile-backed rebuild setting to be resolved from current authoritative
 * intent. Credential-bearing proxy values remain launch-only and must be
 * reacquired separately during preflight.
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
    if (contextWindow !== null) {
      result.NEMOCLAW_CONTEXT_WINDOW = String(contextWindow);
    }
    if (previous.tuning.maxTokens !== null) {
      result.NEMOCLAW_MAX_TOKENS = String(previous.tuning.maxTokens);
    }
    const reasoning = overrides.openClawReasoning ?? previous.tuning.reasoning;
    if (reasoning !== null) {
      result.NEMOCLAW_REASONING = String(reasoning);
    }
    const reasoningEffort = overrides.openClawReasoningEffort ?? previous.tuning.reasoningEffort;
    if (reasoningEffort !== null) {
      result.NEMOCLAW_REASONING_EFFORT = reasoningEffort;
    }
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
  "agentName" | "environment" | "corporateCaOverride"
>;

/**
 * Render every fallible replacement-profile input while the old sandbox is
 * still intact. Mutable rebuild state is supplied explicitly by the caller;
 * receipt-only tuning, managed proxy, host-proxy intent, and CA material are
 * reconstructed from the validated previous profile.
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
      corporateCaOverride: handoff.corporateCa,
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
  return Object.freeze({
    ...handoff,
    replacementProfile,
  });
}

/**
 * Bind the receipt-derived contract to the selected driver capability. This
 * uses the same managed workload source resolver as fresh onboarding and never
 * consults a mutable release pointer.
 */
export function prepareSandboxWorkloadSourceFromRebuildHandoff(
  handoff: ManagedWorkloadRebuildCatalogHandoff,
  runtime: SandboxWorkloadRuntimeCapabilities,
): PreparedSandboxWorkloadSource {
  let source;
  try {
    source = resolveSandboxWorkloadSource({
      agentName: handoff.agent,
      legacyDockerfilePath: "",
      runtime,
      catalog: { [handoff.agent]: handoff.replacement.source.contract },
      policy: "require-managed",
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
  return {
    source,
    release: handoff.replacement.release,
    fallbackDiagnostic: null,
  };
}
