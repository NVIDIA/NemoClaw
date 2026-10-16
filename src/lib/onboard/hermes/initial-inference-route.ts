// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { refreshHermesNativeLocalCredential } from "../../hermes-managed-route";
import type { NativeLocalProviderAttachment } from "../../inference/native-local/contract";
import { normalizeNativeLocalProviderAttachment } from "../../inference/native-local/profile";
import { usesNativeLocalInferenceForAgent } from "../../inference/native-local/eligibility";
import type { SandboxEntry } from "../../state/registry";
import type { AgentConfigTarget } from "../../sandbox/config";
import type { ConfigObject } from "../../security/credential-filter";
import { qualifiedNativeLocalEndpointUrl } from "../../inference/native-local/agent-config";
import { nativeLocalAttachmentMatchesHostLocalReceipt } from "../../state/registry/host-local-inference";

export interface InitialHermesInferenceRouteDeps {
  getSandbox(sandboxName: string): SandboxEntry | null | undefined;
  withSandboxMutationLock<T>(sandboxName: string, action: () => Promise<T>): Promise<T>;
  readCredentialHandle(
    sandboxName: string,
    gatewayName: string,
    expected: NativeLocalProviderAttachment,
  ): Promise<string>;
  resolveAgentConfig(sandboxName: string): AgentConfigTarget;
  readSandboxConfig(
    sandboxName: string,
    target: AgentConfigTarget,
    gatewayName: string,
  ): ConfigObject;
  patchHermesInferenceConfig: typeof import("../../actions/inference-set").patchHermesInferenceConfig;
  writeSandboxConfig(
    sandboxName: string,
    target: AgentConfigTarget,
    config: ConfigObject,
    options?: { restoreNativeLocalCredential?: true },
  ): void;
  restartGateway(sandboxName: string, gatewayName: string): Promise<{ ok: boolean }>;
}

export type InitializeHermesInferenceRoute = (
  sandboxName: string,
  model: string,
  provider: string,
  gatewayName: string,
  revalidateSandboxIdentity?: (operation: string) => void,
) => Promise<void>;

/** Project an already attached local route into a publisher-owned Hermes image. */
export function createInitialHermesInferenceRoute(
  overrides: Pick<InitialHermesInferenceRouteDeps, "getSandbox"> &
    Partial<InitialHermesInferenceRouteDeps>,
  options: {
    activation?: "immediate" | "deferred";
    workload?: "external" | "registered";
    projection?: "route" | "credential";
  } = {},
): InitializeHermesInferenceRoute {
  const deps: InitialHermesInferenceRouteDeps = {
    ...defaultDeps,
    ...overrides,
  };
  const acceptsWorkload = (entry: SandboxEntry) =>
    options.workload === "registered" || entry.workload?.kind === "external-image";
  return async (sandboxName, model, provider, gatewayName, revalidateSandboxIdentity) => {
    const initial = deps.getSandbox(sandboxName);
    if (!initial) throw new Error("Initial Hermes inference route requires a registered sandbox.");
    if (!acceptsWorkload(initial)) return;
    if (
      initial.nativeLocalProviderAttachment === undefined &&
      !usesNativeLocalInferenceForAgent(
        "hermes",
        initial.provider,
        initial.endpointUrl,
        initial.provider === "vllm-local" && Boolean(initial.nimContainer),
      )
    )
      return;
    if (!revalidateSandboxIdentity) {
      throw new Error("Initial Hermes inference route requires verified sandbox identity.");
    }
    const mismatch = () =>
      new Error("Initial Hermes inference route does not match its registered selection.");
    const selection = (entry: SandboxEntry | null | undefined) => {
      const receipt = normalizeNativeLocalProviderAttachment(entry?.nativeLocalProviderAttachment);
      if (
        !entry ||
        !acceptsWorkload(entry) ||
        entry.name !== sandboxName ||
        entry.agent !== "hermes" ||
        !gatewayName ||
        entry.gatewayName !== gatewayName ||
        entry.provider !== provider ||
        entry.model !== model ||
        !receipt ||
        receipt.agent !== "hermes" ||
        receipt.sandboxName !== sandboxName ||
        receipt.gatewayName !== gatewayName ||
        receipt.provider !== provider ||
        (receipt.endpointUrl !== qualifiedNativeLocalEndpointUrl(entry.endpointUrl ?? "") &&
          !nativeLocalAttachmentMatchesHostLocalReceipt(
            entry.endpointUrl,
            receipt.endpointUrl,
            entry.hostLocalInferenceReceipt,
          ))
      )
        throw mismatch();
      return {
        receipt,
        hostLocalInferenceReceipt: entry.hostLocalInferenceReceipt ?? null,
        preferredInferenceApi: entry.preferredInferenceApi ?? null,
        workload: entry.workload,
      };
    };
    const selected = selection(initial);
    const selectedIdentity = JSON.stringify(selected);
    const assertCurrent = (operation: string) => {
      revalidateSandboxIdentity(operation);
      if (JSON.stringify(selection(deps.getSandbox(sandboxName))) !== selectedIdentity) {
        throw mismatch();
      }
    };

    await deps.withSandboxMutationLock(sandboxName, async () => {
      assertCurrent(`read initial Hermes inference route in sandbox '${sandboxName}'`);
      const target = deps.resolveAgentConfig(sandboxName);
      if (target.agentName !== "hermes") throw mismatch();
      const handle = await deps.readCredentialHandle(sandboxName, gatewayName, selected.receipt);
      assertCurrent(`read Hermes config in sandbox '${sandboxName}'`);
      const config = deps.readSandboxConfig(sandboxName, target, gatewayName);
      // Keep the same object: the guarded writer requires the non-enumerable
      // digest attached by readSandboxConfig to bind this exact read.
      // Resolve the same effective API and endpoint for initial selection and
      // credential-only restore, without rebuilding restored model settings.
      const { route } = deps.patchHermesInferenceConfig(
        options.projection === "credential" ? {} : config,
        provider,
        model,
        selected.preferredInferenceApi,
        undefined,
        selected.receipt.endpointUrl,
        true,
        handle,
      );
      if (options.projection === "credential") {
        refreshHermesNativeLocalCredential(config, {
          upstreamProvider: provider,
          model,
          baseUrl: route.inferenceBaseUrl,
          inferenceApi: route.inferenceApi,
          nativeCredentialHandle: handle,
        });
      }
      assertCurrent(`apply initial Hermes inference route in sandbox '${sandboxName}'`);
      if (options.projection === "credential") {
        // Restored state belongs to the archived generation. The guard permits
        // only this verified credential replacement while sealing those inputs.
        deps.writeSandboxConfig(sandboxName, target, config, {
          restoreNativeLocalCredential: true,
        });
      } else {
        deps.writeSandboxConfig(sandboxName, target, config);
      }
      assertCurrent(`restart initial Hermes gateway in sandbox '${sandboxName}'`);
      // Restart even on a repeated projection: a prior write may have committed
      // before activation failed. The existing restart owner verifies health.
      if (
        options.activation !== "deferred" &&
        !(await deps.restartGateway(sandboxName, gatewayName)).ok
      ) {
        throw new Error("Hermes gateway restart failed after initial inference configuration.");
      }
    });
  };
}

const defaultDeps: Omit<InitialHermesInferenceRouteDeps, "getSandbox"> = {
  withSandboxMutationLock: (name, action) =>
    (
      require("../../state/mcp-lifecycle-lock-acquisition") as typeof import("../../state/mcp-lifecycle-lock-acquisition")
    ).withMcpLifecycleLock(name, action),
  readCredentialHandle: async (sandboxName, gatewayName, expected) => {
    const owner =
      require("../../actions/inference-set-provider") as typeof import("../../actions/inference-set-provider");
    const handle = await owner.readHermesNativeLocalCredentialHandleIfNeeded({
      agentName: "hermes",
      sandboxName,
      gatewayName,
      expected,
      adapter: owner.createDefaultInferenceSetProviderAdapter(),
    });
    if (!handle)
      throw new Error("Initial Hermes inference route requires an issued credential handle.");
    return handle;
  },
  resolveAgentConfig: (name) =>
    (require("../../sandbox/config") as typeof import("../../sandbox/config")).resolveAgentConfig(
      name,
    ),
  readSandboxConfig: (...args) =>
    (require("../../sandbox/config") as typeof import("../../sandbox/config")).readSandboxConfig(
      ...args,
    ),
  patchHermesInferenceConfig: (...args) =>
    (
      require("../../actions/inference-set") as typeof import("../../actions/inference-set")
    ).patchHermesInferenceConfig(...args),
  writeSandboxConfig: (...args) =>
    (require("../../sandbox/config") as typeof import("../../sandbox/config")).writeSandboxConfig(
      ...args,
    ),
  restartGateway: (name, gateway) =>
    (
      require("../../actions/inference-set-gateway-restart") as typeof import("../../actions/inference-set-gateway-restart")
    ).defaultInferenceGatewayRestart(name, gateway),
};
