// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import {
  customAttachmentFromPrepared,
  isNativeCustomProvider,
  verifyNativeCustomProviderAttachment,
  detachNativeCustomProvider,
  ensureNativeCustomProviderAttached,
  normalizeNativeCustomProviderAttachment,
  withNativeCustomLifecycle,
  type NativeCustomProfile,
  type NativeCustomProviderAttachment,
} from "../../inference/native-custom";
import { InferenceSetError } from "../inference-set-error";
import { reconcileNativeCustomSandboxPolicy } from "../../inference/native-custom/network-policy";

import type { InferenceSetOptions, InferenceSetDeps, InferenceSetResult } from "../inference-set";
import type { requireInferenceSetRuntimeAuthority } from "../inference-set-provider";
import type { InferenceMutation } from "../inference-set-gateway-restart";
import { finalizeInferenceMutation } from "../inference-set-gateway-restart";
import type { SandboxEntry } from "../../state/registry";
import type * as onboardSession from "../../state/onboard-session";
import { isDeepStrictEqual } from "node:util";
import {
  prepareInferenceSetRoute,
  usesLoopbackNoAuthProxyRoute,
} from "../inference-set-route-containment";
import {
  resolveAgentInferenceApi,
  getSandboxInferenceConfig,
  normalizeNativeNvidiaProviderAttachment,
  detachNativeNvidiaProvider,
  ensureNativeNvidiaProviderAttached,
} from "../../inference/config";
import { verifyNativeNvidiaProviderAttachment } from "../../inference/native-nvidia";
import {
  prepareNativeCustomInference,
  restoreNativeCustomInference,
} from "../../inference/native-custom/transport";
import { resolveNativeCustomCredentialReference } from "../../inference/native-custom/credential-reference";
import { parseTrustedPrivateInferenceHostsFromEnv } from "../../inference/endpoint-ssrf-preflight";
import {
  inferenceSelectionRegistryFields,
  type ReasoningEffortRequest,
} from "../../inference/selection";

type NativeCustomSwitchOperations = Pick<
  typeof import("../inference-set"),
  | "assertReasoningEffortRoute"
  | "resolveMatchingAgentConfigTarget"
  | "readInSandboxConfigOrFail"
  | "patchHermesInferenceConfig"
  | "patchOpenClawInferenceConfig"
  | "resolveHermesContextWindowForSwitch"
  | "resolveOpenClawContextWindowForSwitch"
  | "writeOpenClawInferenceConfigNatively"
  | "updateMatchingOnboardSession"
>;

/** Persist immutable ownership before granting one sandbox access to the endpoint. */
export async function prepareNativeCustomSelection(input: {
  prepared: NativeCustomProfile;
  gatewayName: string;
  sandboxName: string;
  adapter: OpenShellProviderAdapter;
  credentialValue: string | null;
  beforeAttach?: (receipt: NativeCustomProviderAttachment) => Promise<void>;
  recordedAttachment?: NativeCustomProviderAttachment;
  readAuthority: (
    gatewayName: string,
    providerName: string,
  ) => NativeCustomProviderAttachment | undefined;
  writeAuthority: (gatewayName: string, receipt: NativeCustomProviderAttachment) => void;
}): Promise<{ attachment: NativeCustomProviderAttachment; attachmentChanged: boolean }> {
  if (input.prepared.sandboxName !== input.sandboxName)
    throw new InferenceSetError(
      "Native custom selection belongs to another sandbox. No provider was changed.",
    );
  const gatewayAuthority = input.readAuthority(input.gatewayName, input.prepared.providerName);
  const recorded =
    input.recordedAttachment?.providerName === input.prepared.providerName
      ? input.recordedAttachment
      : undefined;
  const expected = gatewayAuthority ?? recorded;
  if (
    (gatewayAuthority &&
      (!normalizeNativeCustomProviderAttachment(gatewayAuthority) ||
        gatewayAuthority.providerName !== input.prepared.providerName ||
        gatewayAuthority.profileId !== input.prepared.profile.id)) ||
    (recorded && !normalizeNativeCustomProviderAttachment(recorded)) ||
    (gatewayAuthority && recorded && gatewayAuthority.providerId !== recorded.providerId)
  )
    throw new InferenceSetError(
      "Native custom sandbox and gateway provider authority disagree. No provider was changed.",
    );
  const target = { kind: "named", gatewayName: input.gatewayName } as const;
  const receipt = await withNativeCustomLifecycle(input.prepared, async (lifecycle) => {
    const ensured = customAttachmentFromPrepared(
      input.prepared,
      await lifecycle.ensureProvider({
        adapter: input.adapter,
        target,
        credentialValue: input.credentialValue,
        expected,
      }),
    );
    await lifecycle.persistProviderAuthority({
      adapter: input.adapter,
      target,
      gatewayName: input.gatewayName,
      receipt: ensured,
      existing: expected,
      readAuthority: (gatewayName) => input.readAuthority(gatewayName, input.prepared.providerName),
      writeAuthority: (gatewayName) => input.writeAuthority(gatewayName, ensured),
    });
    return ensured;
  });
  await input.beforeAttach?.(receipt);
  const attached = await ensureNativeCustomProviderAttached({
    adapter: input.adapter,
    target,
    sandboxName: input.sandboxName,
    expected: receipt,
  });
  return { attachment: attached.receipt, attachmentChanged: attached.changed };
}

export async function runNativeCustomInferenceSwitch(
  input: {
    options: InferenceSetOptions;
    deps: InferenceSetDeps;
    expectedGatewayName: string;
    runtimeProvider: ReturnType<typeof requireInferenceSetRuntimeAuthority>;
    sandboxName: string;
    entry: SandboxEntry;
    agentName: string;
    provider: "compatible-endpoint" | "compatible-anthropic-endpoint";
    model: string;
    reasoningEffortRequest: ReasoningEffortRequest;
    session: onboardSession.Session | null;
    customRoute: InferenceSetOptions;
    routeEntry: SandboxEntry;
    routeSession: onboardSession.Session | null;
  },
  operations: NativeCustomSwitchOperations,
): Promise<InferenceMutation<InferenceSetResult>> {
  const {
    assertReasoningEffortRoute,
    resolveMatchingAgentConfigTarget,
    readInSandboxConfigOrFail,
    patchHermesInferenceConfig,
    patchOpenClawInferenceConfig,
    resolveHermesContextWindowForSwitch,
    resolveOpenClawContextWindowForSwitch,
    writeOpenClawInferenceConfigNatively,
    updateMatchingOnboardSession,
  } = operations;
  const { deps, sandboxName, entry, agentName, provider, model, expectedGatewayName } = input;
  const entrySnapshot = structuredClone(entry);
  const previous = normalizeNativeCustomProviderAttachment(
    entry.nativeCustomProviderAttachment,
    sandboxName,
  );
  if (entry.nativeCustomProviderAttachment !== undefined && !previous)
    throw new InferenceSetError(
      "The recorded native custom attachment is invalid. No provider was changed.",
    );
  if (isNativeCustomProvider(entry.provider) && !previous)
    throw new InferenceSetError(
      `Sandbox '${sandboxName}' predates native custom attachments. Recreate this beta sandbox before changing its custom model.`,
      2,
    );
  const preparedRoute = prepareInferenceSetRoute({
    nativeCustom: true,
    entry: input.routeEntry,
    sandboxName,
    provider,
    model,
    customRoute: input.customRoute,
    session: input.routeSession,
    sandboxes: [],
  });
  if (preparedRoute.gatewayName !== expectedGatewayName)
    throw new InferenceSetError(
      "The selected sandbox changed named gateways while waiting for its mutation lock.",
      2,
    );
  const metadata = preparedRoute.preliminaryRegistryMetadata;
  const api =
    resolveAgentInferenceApi(agentName, provider, metadata.preferredInferenceApi ?? null) ||
    getSandboxInferenceConfig(model, provider).inferenceApi;
  assertReasoningEffortRoute(input.reasoningEffortRequest, provider, api);
  if (!metadata.endpointUrl)
    throw new InferenceSetError("A custom inference endpoint is required.", 2);
  if (!deps.getNativeCustomProviderAuthority || !deps.setNativeCustomProviderAuthority)
    throw new InferenceSetError(
      "Native custom inference is missing its durable provider authority store.",
    );
  const target = resolveMatchingAgentConfigTarget(deps, sandboxName, agentName);
  const config = readInSandboxConfigOrFail(
    deps,
    sandboxName,
    target,
    agentName === "openclaw" ? expectedGatewayName : undefined,
  );
  const gatewayTarget = { kind: "named", gatewayName: expectedGatewayName } as const;
  if (previous)
    getSandboxInferenceConfig(
      entry.model || "",
      entry.provider,
      entry.preferredInferenceApi ?? null,
      previous,
    );
  if (previous)
    await verifyNativeCustomProviderAttachment({
      adapter: deps.providerAdapter,
      target: gatewayTarget,
      sandboxName,
      expected: previous,
    });
  const previousNvidia = normalizeNativeNvidiaProviderAttachment(
    entry.nativeNvidiaProviderAttachment,
  );
  if (entry.nativeNvidiaProviderAttachment !== undefined && !previousNvidia)
    throw new InferenceSetError("The previous native NVIDIA attachment is invalid.");
  if (previous && previousNvidia)
    throw new InferenceSetError("The selected sandbox records conflicting native attachments.");
  if (previousNvidia)
    await verifyNativeNvidiaProviderAttachment({
      adapter: deps.providerAdapter,
      target: gatewayTarget,
      sandboxName,
      expected: previousNvidia,
    });
  const modelOnly =
    previous &&
    !input.options.endpointUrl &&
    !input.options.credentialEnv &&
    !input.options.inferenceApi;
  const selectionInput = {
    sandboxName,
    gatewayName: expectedGatewayName,
    provider,
    endpointUrl: metadata.endpointUrl,
    api,
  };
  const selection = modelOnly
    ? { prepared: restoreNativeCustomInference(selectionInput, previous), credentialValue: null }
    : await prepareNativeCustomInference(
        {
          ...selectionInput,
          credentialValue:
            deps.resolveCredentialValue(
              metadata.credentialEnv ||
                (provider === "compatible-endpoint"
                  ? "COMPATIBLE_API_KEY"
                  : "COMPATIBLE_ANTHROPIC_API_KEY"),
            ) || null,
          lookup: deps.nativeCustomEndpointLookup,
          trustedPrivateHosts: parseTrustedPrivateInferenceHostsFromEnv(process.env),
        },
        {
          ...deps.nativeCustomTransportDeps,
          discoverAllowedSourceCidrs:
            deps.nativeCustomTransportDeps?.discoverAllowedSourceCidrs ??
            (() =>
              input.runtimeProvider.gateway
                .observeHostRuntime({ environment: process.env, platform: process.platform })
                .network.sandboxSourceCidrs()),
          admitProfile: (candidate) =>
            withNativeCustomLifecycle(candidate, async (lifecycle) => {
              await lifecycle.requireProviderProfileBoundary(deps.providerAdapter, gatewayTarget);
              const observed = await lifecycle.inspectNativeProvider(
                deps.providerAdapter,
                gatewayTarget,
              );
              const owned =
                deps.getNativeCustomProviderAuthority!(
                  expectedGatewayName,
                  candidate.providerName,
                ) ?? (previous?.providerName === candidate.providerName ? previous : undefined);
              if (
                observed &&
                (!owned ||
                  lifecycle.attachmentFromMetadata(observed).providerId !== owned.providerId)
              )
                throw new InferenceSetError(
                  "Native custom provider ownership could not be verified before adapter mutation.",
                );
              if (!observed && owned)
                throw new InferenceSetError("The recorded native custom provider is missing.");
            }),
        },
      );
  let attachment: NativeCustomProviderAttachment | undefined;
  let previousDetachAttempted = false;
  let nvidiaDetached = false;
  let committed = false;
  let rollbackPolicy: (() => Promise<void>) | undefined;
  try {
    const selected = await prepareNativeCustomSelection({
      prepared: selection.prepared,
      gatewayName: expectedGatewayName,
      sandboxName,
      adapter: deps.providerAdapter,
      credentialValue: selection.credentialValue,
      recordedAttachment: previous,
      readAuthority: deps.getNativeCustomProviderAuthority,
      writeAuthority: (gateway, receipt) => {
        deps.setNativeCustomProviderAuthority!(gateway, receipt);
        attachment = receipt;
      },
      beforeAttach: async (receipt) => {
        rollbackPolicy = await (
          deps.reconcileNativeCustomSandboxPolicy ?? reconcileNativeCustomSandboxPolicy
        )({
          sandboxName,
          gatewayName: expectedGatewayName,
          previous,
          next: receipt,
        });
        if (previous && previous.providerName !== selection.prepared.providerName) {
          previousDetachAttempted = true;
          await detachNativeCustomProvider({
            adapter: deps.providerAdapter,
            target: gatewayTarget,
            sandboxName,
            expected: previous,
          });
        }
        if (previousNvidia) {
          nvidiaDetached = true;
          await detachNativeNvidiaProvider({
            adapter: deps.providerAdapter,
            target: gatewayTarget,
            sandboxName,
            expected: previousNvidia,
          });
        }
      },
    });
    attachment = selected.attachment;
    const reference = await (
      deps.resolveNativeCustomCredentialReference ?? resolveNativeCustomCredentialReference
    )({ sandboxName, gatewayName: expectedGatewayName, credentialEnv: attachment.credentialEnv });
    const probe = await deps.probeSandboxRoute({
      sandboxName,
      gatewayName: expectedGatewayName,
      agentName,
      provider,
      model,
      preferredInferenceApi: api,
      nativeCustomProviderAttachment: attachment,
    });
    if (!probe.ok)
      throw new InferenceSetError("The selected native custom model request did not succeed.");
    const changedRoute =
      entry.provider !== provider ||
      entry.model !== model ||
      previous?.providerName !== attachment.providerName ||
      entry.preferredInferenceApi !== api;
    const patched =
      agentName === "hermes"
        ? patchHermesInferenceConfig(
            config,
            provider,
            model,
            api,
            resolveHermesContextWindowForSwitch(provider, model, deps),
            attachment,
            reference,
          )
        : patchOpenClawInferenceConfig(
            config,
            provider,
            model,
            api,
            resolveOpenClawContextWindowForSwitch(
              {
                provider,
                model,
                sandboxName,
                routeChanged: changedRoute || entry.openClawConfigSyncPending === true,
              },
              deps,
            ),
            provider,
            input.reasoningEffortRequest,
            true,
            attachment,
            reference,
          );
    const fields = {
      ...inferenceSelectionRegistryFields({
        provider,
        model,
        endpointUrl: metadata.endpointUrl,
        endpointSource: metadata.endpointSource ?? null,
        credentialEnv: metadata.credentialEnv ?? null,
        preferredInferenceApi: api,
        compatibleEndpointReasoningEffort:
          provider === "compatible-endpoint" && api === "openai-completions"
            ? input.reasoningEffortRequest.explicit
              ? input.reasoningEffortRequest.effort
              : (entry.compatibleEndpointReasoningEffort ?? null)
            : null,
        nimContainer: null,
      }),
      nativeCustomProviderAttachment: attachment,
      nativeNvidiaProviderAttachment: undefined,
      ...(agentName === "openclaw" ? { openClawConfigSyncPending: true as const } : {}),
    };
    // An entered registry write may commit before throwing. Retain the new attachment until observed recovery.
    try {
      committed = true;
      if (!deps.updateSandbox(sandboxName, fields))
        throw new InferenceSetError("The native custom selection could not be persisted.");
    } catch (writeError) {
      try {
        const observed = deps.getSandbox(sandboxName);
        const keys = [
          "provider",
          "model",
          "endpointUrl",
          "credentialEnv",
          "preferredInferenceApi",
          "nativeCustomProviderAttachment",
          "nativeNvidiaProviderAttachment",
        ] as const;
        if (observed && keys.every((key) => isDeepStrictEqual(observed[key], entrySnapshot[key])))
          committed = false;
      } catch {
        /* An unreadable state is not rollback authority. */
      }
      throw writeError;
    }
    if (agentName === "openclaw")
      writeOpenClawInferenceConfigNatively(
        sandboxName,
        config,
        patched.route,
        deps.setOpenClawConfigValues,
        expectedGatewayName,
      );
    else {
      deps.writeSandboxConfig(sandboxName, target, config);
      deps.recomputeSandboxConfigHash(sandboxName, target);
    }
    await deps.retireNativeCustomProviders?.({
      gatewayName: expectedGatewayName,
      sandboxName,
      keepProviderName: attachment.providerName,
      adapter: deps.providerAdapter,
    });
    const sessionUpdated =
      agentName === "openclaw"
        ? updateMatchingOnboardSession(
            sandboxName,
            provider,
            model,
            patched.route,
            { ...metadata, preferredInferenceApi: api },
            deps,
            input.reasoningEffortRequest,
          )
        : false;
    const mutation = finalizeInferenceMutation(
      {
        agentName,
        configChanged: patched.changed || entry.openClawConfigSyncPending === true,
        openClawPairingTarget:
          agentName === "openclaw"
            ? {
                sandboxName,
                gatewayName: expectedGatewayName,
                openclawVersion: entry.agentVersion ?? "",
                stateDirectory: target.configDir,
              }
            : undefined,
        result: {
          sandboxName,
          provider,
          model,
          primaryModelRef: patched.route.primaryModelRef,
          providerKey: patched.route.providerKey,
          configChanged: patched.changed,
          sessionUpdated,
          inSandboxConfigSynced: true,
        },
      },
      deps,
    );
    return { ...mutation, openClawConfigSyncPending: agentName === "openclaw" };
  } catch (error) {
    if (committed)
      throw new InferenceSetError(
        "Native custom selection synchronization is incomplete. Retry the same switch or rebuild the selected sandbox; its recorded authority is retained.",
      );
    try {
      if (attachment && attachment.providerName !== previous?.providerName)
        await detachNativeCustomProvider({
          adapter: deps.providerAdapter,
          target: gatewayTarget,
          sandboxName,
          expected: attachment,
        });
      await rollbackPolicy?.();
      if (previousDetachAttempted && previous)
        await ensureNativeCustomProviderAttached({
          adapter: deps.providerAdapter,
          target: gatewayTarget,
          sandboxName,
          expected: previous,
        });
      if (nvidiaDetached && previousNvidia)
        await ensureNativeNvidiaProviderAttached({
          adapter: deps.providerAdapter,
          target: gatewayTarget,
          sandboxName,
          expected: previousNvidia,
        });
    } catch {
      throw new InferenceSetError(
        "Native custom switch failed and previous attachment recovery could not be verified. Reconcile the selected sandbox before retrying; ownership authority is retained.",
      );
    }
    throw error;
  }
}

export async function restoreNativeCustomDeparture(input: {
  customDetachAttempted: boolean;
  departingCustom: NativeCustomProviderAttachment | undefined;
  customDepartureCommitted: boolean;
  deps: InferenceSetDeps;
  sandboxName: string;
  expectedGatewayName: string;
  departureSnapshot: SandboxEntry;
  rollbackPolicy?: () => Promise<void>;
}): Promise<void> {
  const {
    customDetachAttempted,
    departingCustom,
    deps,
    sandboxName,
    expectedGatewayName,
    departureSnapshot,
  } = input;
  let { customDepartureCommitted } = input;
  if (customDetachAttempted && departingCustom) {
    if (customDepartureCommitted) {
      try {
        const observed = deps.getSandbox(sandboxName);
        const keys = [
          "provider",
          "model",
          "endpointUrl",
          "credentialEnv",
          "preferredInferenceApi",
          "nativeCustomProviderAttachment",
          "nativeNvidiaProviderAttachment",
        ] as const;
        if (
          observed &&
          keys.every((key) => isDeepStrictEqual(observed[key], departureSnapshot[key]))
        )
          customDepartureCommitted = false;
      } catch {
        /* Unknown publication state does not authorize restoring old access. */
      }
    }
    if (!customDepartureCommitted) {
      try {
        await input.rollbackPolicy?.();
        await ensureNativeCustomProviderAttached({
          adapter: deps.providerAdapter,
          target: { kind: "named", gatewayName: expectedGatewayName },
          sandboxName,
          expected: departingCustom,
        });
      } catch {
        throw new InferenceSetError(
          "Previous native custom attachment recovery could not be verified. Reconcile the selected sandbox before retrying; ownership authority is retained.",
        );
      }
    }
  }
}

export function selectsNativeCustomSwitch(
  entry: SandboxEntry,
  endpointUrl: string | null | undefined,
  provider: string,
): boolean {
  return (
    (entry.nativeCustomProviderAttachment !== undefined ||
      (!isNativeCustomProvider(entry.provider) && !isHostLocalCustomEndpoint(endpointUrl))) &&
    !usesLoopbackNoAuthProxyRoute(entry, provider) &&
    !entry.hostLocalInferenceReceipt
  );
}

import { isHostLocalCustomEndpoint } from "../../inference/native-custom/profile";

export async function verifyNativeCustomDeparture(
  entry: SandboxEntry,
  departingCustom: NativeCustomProviderAttachment | undefined,
  sandboxName: string,
  expectedGatewayName: string,
  deps: InferenceSetDeps,
): Promise<void> {
  if (departingCustom) {
    if (entry.nativeNvidiaProviderAttachment !== undefined)
      throw new InferenceSetError("The selected sandbox records conflicting native attachments.");
    getSandboxInferenceConfig(
      entry.model || "",
      entry.provider,
      entry.preferredInferenceApi ?? null,
      departingCustom,
    );
  }
  if (departingCustom)
    await verifyNativeCustomProviderAttachment({
      adapter: deps.providerAdapter,
      target: { kind: "named", gatewayName: expectedGatewayName },
      sandboxName,
      expected: departingCustom,
    });
}

export async function retireSynchronizedNativeCustomDeparture(
  inSandboxConfigSynced: boolean,
  sandboxName: string,
  expectedGatewayName: string,
  deps: InferenceSetDeps,
): Promise<void> {
  if (inSandboxConfigSynced)
    await deps.retireNativeCustomProviders?.({
      gatewayName: expectedGatewayName,
      sandboxName,
      adapter: deps.providerAdapter,
    });
}

import { retireNativeCustomProviders } from "../../inference/native-custom/cleanup";
import {
  getNativeCustomProviderAuthority,
  setNativeCustomProviderAuthority,
} from "../../state/registry/native-custom-provider-authority";

export function defaultNativeCustomSwitchAuthority() {
  return {
    retireNativeCustomProviders,
    getNativeCustomProviderAuthority,
    setNativeCustomProviderAuthority,
  };
}

export function recordedNativeCustomDeparture(
  entry: SandboxEntry,
  sandboxName: string,
): NativeCustomProviderAttachment | undefined {
  const departingCustom = normalizeNativeCustomProviderAttachment(
    entry.nativeCustomProviderAttachment,
    sandboxName,
  );
  if (entry.nativeCustomProviderAttachment !== undefined && !departingCustom)
    throw new InferenceSetError("The recorded native custom provider authority is invalid.");
  return departingCustom;
}

export async function detachNativeCustomDeparture(
  departingCustom: NativeCustomProviderAttachment | undefined,
  sandboxName: string,
  expectedGatewayName: string,
  deps: InferenceSetDeps,
  recordAttempt: () => void,
): Promise<(() => Promise<void>) | undefined> {
  if (departingCustom) {
    recordAttempt();
    const rollbackPolicy = await (
      deps.reconcileNativeCustomSandboxPolicy ?? reconcileNativeCustomSandboxPolicy
    )({
      sandboxName,
      gatewayName: expectedGatewayName,
      previous: departingCustom,
    });
    try {
      await detachNativeCustomProvider({
        adapter: deps.providerAdapter,
        target: { kind: "named", gatewayName: expectedGatewayName },
        sandboxName,
        expected: departingCustom,
      });
    } catch (error) {
      await rollbackPolicy();
      throw error;
    }
    return rollbackPolicy;
  }
}

export function nativeCustomDepartureRegistryFields(
  receipt: NativeCustomProviderAttachment | undefined,
): Partial<SandboxEntry> {
  return receipt ? { nativeCustomProviderAttachment: undefined } : {};
}

export function validateNativeCustomHermesFrontend(
  agentName: string,
  provider: string,
  explicitInferenceApi: string | null,
): void {
  if (
    agentName === "hermes" &&
    provider === "compatible-anthropic-endpoint" &&
    explicitInferenceApi !== null &&
    explicitInferenceApi !== "openai-completions"
  ) {
    throw new InferenceSetError(
      "Hermes custom Anthropic endpoints require the managed openai-completions frontend. " +
        "Set --inference-api openai-completions or omit --inference-api so NemoClaw selects it.",
      2,
    );
  }
}
