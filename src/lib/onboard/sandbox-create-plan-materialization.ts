// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { InitialSandboxPolicy } from "./initial-policy";
import { hasConfiguredMessagingCredential, type MessagingTokenDef } from "./messaging-prep";
import { filterMessagingProvidersForSandboxCreate } from "./sandbox-create-intent";
import type {
  MaterializeSandboxCreatePlanInput,
  SandboxCreateIntent,
  SandboxCreateMessagingProviderRequest,
} from "./sandbox-create-intent-types";
import { containerPathsOverlap } from "./host-mount/path-overlap";
import { normalizeSandboxGpuDeviceForCdi } from "./sandbox-gpu-create";
import { prepareSandboxGpuRoutePolicies } from "./sandbox-gpu-route-policy";

type PrepareInitialSandboxCreatePolicy =
  typeof import("./initial-policy").prepareInitialSandboxCreatePolicy;

const DCODE_MCP_SNAPSHOT_TMPFS_MOUNT = {
  type: "tmpfs",
  target: "/run/nemoclaw-dcode-mcp",
  // Docker applies nosuid and nodev to tmpfs mounts by default and rejects
  // both when they are repeated in structured MountTmpfsOptions.
  options: ["noexec"],
  size_bytes: 1_048_576,
  mode: 0o1777,
} as const;

function buildSandboxDriverConfig(
  intent: SandboxCreateIntent,
  managedStateMount: MaterializeSandboxCreatePlanInput["managedStateMount"],
): string | null {
  const cdiDevice = normalizeSandboxGpuDeviceForCdi(intent.sandboxGpuDevice);
  if (cdiDevice && (!intent.policy.options.directGpu || !intent.gpuCreateArgs.includes("--gpu"))) {
    throw new Error("Sandbox GPU device selection requires the OpenShell GPU request.");
  }
  const dockerMounts: Array<Record<string, unknown>> = (intent.hostMounts ?? []).map(
    ({ source, target }) => ({ type: "bind", source, target, read_only: true }),
  );
  if (managedStateMount) {
    const conflictingHostMount = intent.hostMounts?.find(({ target }) =>
      containerPathsOverlap(target, managedStateMount.target),
    );
    if (conflictingHostMount) {
      throw new Error(
        `Host mount target '${conflictingHostMount.target}' conflicts with the managed Hermes state root '${managedStateMount.target}'.`,
      );
    }
    dockerMounts.unshift({ ...managedStateMount });
  }
  const podmanMounts: Array<Record<string, unknown>> = [];
  if (intent.policy.options.agentName === "langchain-deepagents-code") {
    dockerMounts.unshift(DCODE_MCP_SNAPSHOT_TMPFS_MOUNT);
    podmanMounts.push(DCODE_MCP_SNAPSHOT_TMPFS_MOUNT);
  }
  if (dockerMounts.length === 0 && !cdiDevice) return null;
  return JSON.stringify({
    docker: {
      ...(cdiDevice ? { cdi_devices: [cdiDevice] } : {}),
      ...(dockerMounts.length > 0 ? { mounts: dockerMounts } : {}),
    },
    ...(podmanMounts.length > 0 || cdiDevice
      ? {
          podman: {
            ...(cdiDevice ? { cdi_devices: [cdiDevice] } : {}),
            ...(podmanMounts.length > 0 ? { mounts: podmanMounts } : {}),
          },
        }
      : {}),
  });
}

export type SandboxCreatePlan = {
  activeMessagingChannels: string[];
  initialSandboxPolicy: InitialSandboxPolicy;
  createArgs: string[];
  messagingProviders: string[];
  gpuRoutePlan: SandboxCreateIntent["gpuRoutePlan"];
  compatibilityPolicyPath: string | null;
  sandboxGpuLogMessage: string | null;
  /** One-shot provider activation owned by the post-create verification boundary. */
  activateDeferredProviderEffects:
    | ((revalidateSandboxIdentity: (operation: string) => void) => readonly string[])
    | null;
};

function sameProviderNames(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((providerName, index) => providerName === right[index])
  );
}

export function selectHermesPortableExtraProviderPlan(
  hermesPortable: boolean,
  requested: readonly string[] | undefined,
  planOrdinary: () => {
    readonly extraProviders: readonly string[];
    readonly staleExtraProviders: readonly string[];
  },
): { readonly extraProviders: readonly string[]; readonly staleExtraProviders: readonly string[] } {
  if (hermesPortable) {
    return { extraProviders: [...(requested ?? [])], staleExtraProviders: [] };
  }
  return requested ? { extraProviders: [...requested], staleExtraProviders: [] } : planOrdinary();
}

export async function selectHermesPortableMessagingCapabilities(
  hermesPortable: boolean,
  rebindOrdinary: () => Promise<{
    readonly messagingTokenDefs: MessagingTokenDef[];
    readonly hasMessagingTokens: boolean;
  }>,
): Promise<{
  readonly messagingTokenDefs: MessagingTokenDef[];
  readonly hasMessagingTokens: boolean;
}> {
  return hermesPortable
    ? { messagingTokenDefs: [], hasMessagingTokens: false }
    : await rebindOrdinary();
}

export function applyOrdinaryExtraProviderReconciliation(
  hermesPortable: boolean,
  reconcile: () => void,
): void {
  if (!hermesPortable) reconcile();
}

function getInitialSandboxCreatePolicy(
  ...args: Parameters<PrepareInitialSandboxCreatePolicy>
): ReturnType<PrepareInitialSandboxCreatePolicy> {
  const { prepareInitialSandboxCreatePolicy } =
    require("./initial-policy") as typeof import("./initial-policy");
  return prepareInitialSandboxCreatePolicy(...args);
}

function getHermesPortableInitialSandboxPolicy(
  ...args: Parameters<typeof import("./initial-policy").planHermesPortableInitialSandboxPolicy>
): ReturnType<typeof import("./initial-policy").planHermesPortableInitialSandboxPolicy> {
  const { planHermesPortableInitialSandboxPolicy } =
    require("./initial-policy") as typeof import("./initial-policy");
  return planHermesPortableInitialSandboxPolicy(...args);
}

export function prepareSandboxCreatePolicy(
  intent: SandboxCreateIntent,
  prepareInitialSandboxCreatePolicy: PrepareInitialSandboxCreatePolicy = getInitialSandboxCreatePolicy,
  messagingConfig?: MaterializeSandboxCreatePlanInput["messagingConfig"],
): {
  readonly initialSandboxPolicy: InitialSandboxPolicy;
  readonly compatibilityPolicyPath: string | null;
} {
  return prepareSandboxGpuRoutePolicies(
    intent.policy.basePolicyPath,
    [...intent.policy.activeMessagingChannels],
    {
      directGpu: intent.policy.options.directGpu,
      hostGpuAvailable: intent.policy.options.hostGpuAvailable,
      additionalPresets: intent.policy.options.hostLocalInferenceRouteOnly
        ? intent.policy.options.additionalPresets.filter((name) => name !== "local-inference")
        : [...intent.policy.options.additionalPresets],
      agentName: intent.policy.options.agentName,
      // Channel presets bind `{sandboxName}-<channel>-bridge`; without the name,
      // composing them throws.
      sandboxName: intent.sandboxName,
      policyTier: intent.policy.options.policyTier,
      messagingConfig,
    },
    intent.gpuRoutePlan,
    prepareInitialSandboxCreatePolicy,
  );
}

function messagingProviderRequestKey(
  request: Pick<SandboxCreateMessagingProviderRequest, "name" | "envKey">,
): string {
  // Tuple encoding stays collision-free even if either value contains a separator.
  return JSON.stringify([request.name, request.envKey]);
}

export function validateSandboxCreateIntentBindings(
  intent: SandboxCreateIntent,
  messagingTokenDefs: readonly MessagingTokenDef[],
): MessagingTokenDef[] {
  const disabledChannelNames = new Set(intent.disabledChannelNames);
  const activeChannelNames = new Set(intent.policy.activeMessagingChannels);
  const enabledRequests = intent.messagingProviderRequests.filter(
    ({ channel }) =>
      !channel || (activeChannelNames.has(channel) && !disabledChannelNames.has(channel)),
  );
  const intentRequestKeys = new Set(
    intent.messagingProviderRequests.map(messagingProviderRequestKey),
  );
  const tokenDefsByRequest = new Map(
    messagingTokenDefs.map((tokenDef) => [messagingProviderRequestKey(tokenDef), tokenDef]),
  );

  if (tokenDefsByRequest.size !== messagingTokenDefs.length) {
    throw new Error(
      "Cannot materialize sandbox create intent; duplicate credential bindings found.",
    );
  }
  if (
    messagingTokenDefs.some(
      (tokenDef) => !intentRequestKeys.has(messagingProviderRequestKey(tokenDef)),
    )
  ) {
    throw new Error("Cannot materialize sandbox create intent; credential binding set changed.");
  }

  return enabledRequests.map((request) => {
    const tokenDef = tokenDefsByRequest.get(messagingProviderRequestKey(request));
    if (!tokenDef) {
      throw new Error(
        `Cannot materialize sandbox create intent; missing credential binding '${request.envKey}' for provider '${request.name}'.`,
      );
    }
    if (hasConfiguredMessagingCredential(tokenDef) !== request.credentialConfigured) {
      throw new Error(
        `Cannot materialize sandbox create intent; credential availability changed for provider '${request.name}'.`,
      );
    }
    // Default providers omit this field; normalize an empty or missing binding
    // to the intent's `undefined` representation before comparing.
    const boundProviderType = tokenDef.providerType || undefined;
    if (boundProviderType !== request.providerType) {
      throw new Error(
        `Cannot materialize sandbox create intent; provider type changed for '${request.name}'.`,
      );
    }
    return tokenDef;
  });
}

function assertCredentialBindingProvidersAttached(
  policy: InitialSandboxPolicy,
  createProviders: ReadonlySet<string>,
): void {
  for (const provider of policy.credentialBindingProviders ?? []) {
    if (createProviders.has(provider)) continue;
    policy.cleanup?.();
    throw new Error(
      `Cannot create sandbox; create-time policy requires credential provider '${provider}', but the sandbox create plan does not attach it.`,
    );
  }
}

function buildCreateProviderSet(
  intent: SandboxCreateIntent,
  messagingProviders: readonly string[],
  hermesToolGatewayProvider: string | null,
): Set<string> {
  return new Set(
    [
      intent.inferenceProvider,
      ...messagingProviders,
      hermesToolGatewayProvider,
      ...intent.extraProviders,
    ].filter((provider): provider is string => Boolean(provider)),
  );
}

function assertDeferredProviderPlanSupported(
  intent: SandboxCreateIntent,
  messagingProviders: readonly string[],
  initialSandboxPolicy: InitialSandboxPolicy,
): void {
  const requiresProviderAttachment =
    Boolean(intent.inferenceProvider) ||
    messagingProviders.length > 0 ||
    intent.extraProviders.length > 0 ||
    intent.hermesToolGateways.length > 0;
  if (!requiresProviderAttachment) return;
  initialSandboxPolicy.cleanup?.();
  throw new Error(
    `Cannot create sandbox '${intent.sandboxName}' with deferred providers because OpenShell cannot bind provider attachment to a verified immutable sandbox identity. No sandbox was created; use an OpenShell release with identity-bound provider attachment before retrying.`,
  );
}

/** Materialize policy, route metadata, resources, and providers from a secretless intent. */
export function materializeSandboxCreatePlan({
  intent,
  fromRef,
  policylessCreate = false,
  deferSandboxEffectsUntilIdentityVerification = false,
  managedStateMount,
  messagingTokenDefs,
  messagingConfig,
  runProviderPreDeleteCleanup,
  upsertMessagingProviders,
  getHermesToolGatewayProviderName,
  discloseInitialSandboxPolicy,
  prepareInitialSandboxCreatePolicy = getInitialSandboxCreatePolicy,
}: MaterializeSandboxCreatePlanInput): SandboxCreatePlan {
  const enabledMessagingTokenDefs = validateSandboxCreateIntentBindings(intent, messagingTokenDefs);
  const driverConfig = buildSandboxDriverConfig(intent, managedStateMount);
  const { initialSandboxPolicy, compatibilityPolicyPath } = prepareSandboxCreatePolicy(
    intent,
    prepareInitialSandboxCreatePolicy,
    messagingConfig,
  );
  const createArgs = [
    "--from",
    fromRef,
    "--name",
    intent.sandboxName,
    ...(!policylessCreate ? ["--policy", initialSandboxPolicy.policyPath] : []),
    ...(driverConfig ? ["--driver-config-json", driverConfig] : []),
    ...intent.gpuCreateArgs,
    ...intent.resourceCreateArgs,
  ];

  let hermesToolGatewayProvider: string | null | undefined;
  const resolveHermesToolGatewayProvider = (): string | null => {
    if (hermesToolGatewayProvider !== undefined) return hermesToolGatewayProvider;
    hermesToolGatewayProvider =
      intent.hermesToolGateways.length > 0
        ? getHermesToolGatewayProviderName(intent.sandboxName)
        : null;
    return hermesToolGatewayProvider;
  };
  const plannedMessagingProviders = filterMessagingProvidersForSandboxCreate(
    [
      ...enabledMessagingTokenDefs.filter(hasConfiguredMessagingCredential).map(({ name }) => name),
      ...intent.reusableMessagingProviders,
    ],
    intent.messagingProviderRequests,
    intent.policy.activeMessagingChannels,
    intent.disabledChannelNames,
  );
  if (deferSandboxEffectsUntilIdentityVerification) {
    assertDeferredProviderPlanSupported(intent, plannedMessagingProviders, initialSandboxPolicy);
  }
  if (!policylessCreate) {
    assertCredentialBindingProvidersAttached(
      initialSandboxPolicy,
      buildCreateProviderSet(intent, plannedMessagingProviders, resolveHermesToolGatewayProvider()),
    );
    try {
      discloseInitialSandboxPolicy?.(initialSandboxPolicy);
    } catch (error) {
      initialSandboxPolicy.cleanup?.();
      throw error;
    }
  }

  const activateProviderEffects = (
    revalidateSandboxIdentity?: (operation: string) => void,
  ): readonly string[] => {
    runProviderPreDeleteCleanup(revalidateSandboxIdentity);
    const activatedMessagingProviders = filterMessagingProvidersForSandboxCreate(
      [
        ...upsertMessagingProviders(enabledMessagingTokenDefs, {
          replaceExisting: true,
          allowedSandboxes: [intent.sandboxName],
          ...(revalidateSandboxIdentity ? { revalidateSandboxIdentity } : {}),
        }),
        ...intent.reusableMessagingProviders,
      ],
      intent.messagingProviderRequests,
      intent.policy.activeMessagingChannels,
      intent.disabledChannelNames,
    );
    const createProviders = buildCreateProviderSet(
      intent,
      activatedMessagingProviders,
      resolveHermesToolGatewayProvider(),
    );
    if (!policylessCreate) {
      assertCredentialBindingProvidersAttached(initialSandboxPolicy, createProviders);
    }
    if (!sameProviderNames(activatedMessagingProviders, plannedMessagingProviders)) {
      throw new Error(
        `Provider activation for sandbox '${intent.sandboxName}' did not match its verified create plan.`,
      );
    }
    return [...createProviders];
  };
  if (!deferSandboxEffectsUntilIdentityVerification) {
    for (const provider of activateProviderEffects()) {
      createArgs.push("--provider", provider);
    }
  }

  return {
    activeMessagingChannels: [...intent.policy.activeMessagingChannels],
    initialSandboxPolicy,
    createArgs,
    messagingProviders: plannedMessagingProviders,
    gpuRoutePlan: intent.gpuRoutePlan,
    compatibilityPolicyPath,
    sandboxGpuLogMessage: intent.sandboxGpuLogMessage,
    activateDeferredProviderEffects: deferSandboxEffectsUntilIdentityVerification
      ? activateProviderEffects
      : null,
  };
}

/** Build the schema-5 create plan without provider, filesystem, Docker, or prebuild effects. */
export function materializeHermesPortableCreatePlan(input: {
  readonly intent: SandboxCreateIntent;
  readonly fromRef: string;
}): SandboxCreatePlan {
  const { intent, fromRef } = input;
  if (
    intent.policy.options.agentName !== "hermes" ||
    !["none", "native-only"].includes(intent.gpuRoutePlan) ||
    (intent.hostMounts?.length ?? 0) > 0 ||
    intent.policy.activeMessagingChannels.length > 0 ||
    intent.messagingProviderRequests.length > 0 ||
    intent.reusableMessagingProviders.length > 0 ||
    intent.extraProviders.length > 0 ||
    intent.staleExtraProviders.length > 0 ||
    intent.hermesToolGateways.length > 0
  ) {
    throw new Error(
      "Hermes portable create intent includes an effect that is not owned by its schema-5 receipt.",
    );
  }
  const initialSandboxPolicy = getHermesPortableInitialSandboxPolicy(
    intent.policy.basePolicyPath,
    [...intent.policy.activeMessagingChannels],
    {
      directGpu: intent.policy.options.directGpu,
      hostGpuAvailable: intent.policy.options.hostGpuAvailable,
      additionalPresets: intent.policy.options.hostLocalInferenceRouteOnly
        ? intent.policy.options.additionalPresets.filter((name) => name !== "local-inference")
        : [...intent.policy.options.additionalPresets],
      agentName: "hermes",
      policyTier: intent.policy.options.policyTier,
    },
  );
  const driverConfig = buildSandboxDriverConfig(intent, null);
  const createArgs = [
    "--from",
    fromRef,
    "--name",
    intent.sandboxName,
    "--policy",
    initialSandboxPolicy.policyPath,
    ...(driverConfig ? ["--driver-config-json", driverConfig] : []),
    ...intent.gpuCreateArgs,
    ...intent.resourceCreateArgs,
  ];
  if (intent.inferenceProvider) createArgs.push("--provider", intent.inferenceProvider);
  return {
    activeMessagingChannels: [],
    initialSandboxPolicy,
    createArgs,
    messagingProviders: [],
    gpuRoutePlan: intent.gpuRoutePlan,
    compatibilityPolicyPath: null,
    sandboxGpuLogMessage: intent.sandboxGpuLogMessage,
    activateDeferredProviderEffects: null,
  };
}
