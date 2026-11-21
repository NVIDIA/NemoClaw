// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  SandboxInferenceConfig,
  RegisteredInferenceProviderAttachment,
} from "../../inference/config";
import type { ReasoningEffortRequest } from "../../inference/selection";
import type { ConfigObject } from "../../security/credential-filter";

import { isDeepStrictEqual } from "node:util";
import type { SandboxEntry } from "../../state/registry/types";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { createRegisteredSandboxIdentityRevalidation } from "../sandbox-recreate-transaction";
import { observeSandboxOnGateway } from "../sandbox-recreate-probe";

const initialOpenclawInferenceRouteRuntime = {
  loadInferenceSet: () =>
    require("../../actions/inference-set") as typeof import("../../actions/inference-set"),
  loadSandboxConfig: () => require("../../sandbox/config") as typeof import("../../sandbox/config"),
  loadFinalizationDeps: () =>
    require("../machine/finalization-deps") as typeof import("../machine/finalization-deps"),
};

export type InitialInferenceSelection = {
  endpointUrl?: string | null;
  nativeProvider: boolean;
  registeredInferenceProviderAttachment?: RegisteredInferenceProviderAttachment;
};

export interface InitialOpenclawInferenceRouteDeps {
  verifyRegisteredAttachment?: (expected: RegisteredInferenceProviderAttachment) => Promise<number>;
  readRegisteredHandle?: (expected: RegisteredInferenceProviderAttachment) => Promise<string>;
  readInferenceSelection?(
    sandboxName: string,
    gatewayName: string,
    provider: string,
  ): InitialInferenceSelection;
  readOpenclawConfig(sandboxName: string, gatewayName: string): ConfigObject;
  patchOpenclawInferenceConfig(
    config: ConfigObject,
    provider: string,
    model: string,
    preferredInferenceApi: string | null,
    contextWindow: undefined,
    upstreamProviderMarker: string,
    reasoningEffort: ReasoningEffortRequest,
    inheritPrimaryReplyBudget: false,
    nativeEndpointUrl?: string,
    nativeProvider?: boolean,
    registered?: RegisteredInferenceProviderAttachment,
    registeredHandle?: string,
  ): { route: SandboxInferenceConfig };
  writeOpenclawInferenceConfigNatively(
    sandboxName: string,
    config: ConfigObject,
    route: SandboxInferenceConfig,
    gatewayName: string,
  ): void;
  restartNativeGateway(
    sandboxName: string,
    gatewayName: string,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        failureLayer: string;
        detail: string;
      }
  >;
}

export type InitializeOpenclawInferenceRoute = (
  sandboxName: string,
  model: string,
  provider: string,
  preferredInferenceApi: string | null,
  gatewayName: string,
  revalidateSandboxIdentity?: (operation: string) => void,
  selection?: InitialInferenceSelection,
) => Promise<void>;

export function createOpenclawInferenceRouteWriter(
  deps: Omit<InitialOpenclawInferenceRouteDeps, "restartNativeGateway">,
): InitializeOpenclawInferenceRoute {
  return async function initializeOpenclawInferenceRoute(
    sandboxName,
    model,
    provider,
    preferredInferenceApi,
    gatewayName,
    revalidateSandboxIdentity,
    selection,
  ): Promise<void> {
    revalidateSandboxIdentity?.(`read native OpenClaw config in sandbox '${sandboxName}'`);
    const selected = selection ?? deps.readInferenceSelection?.(sandboxName, gatewayName, provider);
    const registered = selected?.registeredInferenceProviderAttachment;
    let handle: string | undefined;
    if (registered) {
      if (
        registered.sandboxName !== sandboxName ||
        registered.gatewayName !== gatewayName ||
        registered.providerName !== provider ||
        registered.inferenceApi !== preferredInferenceApi
      )
        throw new Error("Restored registered provider does not match its selected sandbox route.");
      if (!deps.verifyRegisteredAttachment || !deps.readRegisteredHandle)
        throw new Error(
          "Registered provider restore requires live attachment and credential verification.",
        );
      const revision = await deps.verifyRegisteredAttachment(registered);
      handle = await deps.readRegisteredHandle(registered);
      if ((await deps.verifyRegisteredAttachment(registered)) !== revision)
        throw new Error(
          "Registered provider changed while acquiring its runtime credential reference.",
        );
    }
    const config = deps.readOpenclawConfig(sandboxName, gatewayName);
    const patched = deps.patchOpenclawInferenceConfig(
      config,
      provider,
      model,
      preferredInferenceApi,
      undefined,
      provider,
      { effort: null, explicit: false },
      false,
      selected?.endpointUrl ?? undefined,
      selected?.nativeProvider ?? true,
      registered,
      handle,
    );

    revalidateSandboxIdentity?.(
      `apply native OpenClaw inference route in sandbox '${sandboxName}'`,
    );
    deps.writeOpenclawInferenceConfigNatively(sandboxName, config, patched.route, gatewayName);
  };
}

export function createInitialOpenclawInferenceRoute(
  deps: InitialOpenclawInferenceRouteDeps,
): InitializeOpenclawInferenceRoute {
  const write = createOpenclawInferenceRouteWriter(deps);
  return async (
    sandboxName,
    model,
    provider,
    preferredInferenceApi,
    gatewayName,
    revalidateSandboxIdentity,
    selection,
  ) => {
    await write(
      sandboxName,
      model,
      provider,
      preferredInferenceApi,
      gatewayName,
      revalidateSandboxIdentity,
      selection,
    );
    revalidateSandboxIdentity?.(`restart native OpenClaw gateway in sandbox '${sandboxName}'`);
    const restart = await deps.restartNativeGateway(sandboxName, gatewayName);
    if (!restart.ok) {
      throw new Error(
        `OpenClaw native gateway restart failed after initial inference configuration (${restart.failureLayer}): ${restart.detail}`,
      );
    }
  };
}

const nativeInferenceRouteDeps: InitialOpenclawInferenceRouteDeps = {
  verifyRegisteredAttachment: async (expected) => {
    const { verifyRegisteredInferenceProviderAttachment, registeredInferenceProviderRevision } =
      require("../../inference/native-provider/registered") as typeof import("../../inference/native-provider/registered");
    const { createManagedProviderAdapter } =
      require("../../adapters/openshell/managed-provider-adapter") as typeof import("../../adapters/openshell/managed-provider-adapter");
    const adapter = createManagedProviderAdapter();
    await verifyRegisteredInferenceProviderAttachment({ adapter, expected });
    return registeredInferenceProviderRevision({ adapter, expected });
  },
  readRegisteredHandle: (expected) => {
    const { readRegisteredInferenceCredentialHandle } =
      require("../../actions/inference-set/registered") as typeof import("../../actions/inference-set/registered");
    return readRegisteredInferenceCredentialHandle(
      expected,
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    );
  },
  readInferenceSelection: (sandboxName, gatewayName, provider) => {
    const { load } =
      require("../../state/registry/persistence") as typeof import("../../state/registry/persistence");
    const entry = load().sandboxes[sandboxName];
    if (!entry || entry.gatewayName !== gatewayName || entry.provider !== provider) {
      throw new Error("Initial OpenClaw inference route does not match its registered selection.");
    }
    return {
      endpointUrl: entry.endpointUrl,
      registeredInferenceProviderAttachment: entry.registeredInferenceProviderAttachment,
      nativeProvider: Boolean(
        entry.registeredInferenceProviderAttachment ||
        entry.nativeHostedProviderAttachment ||
        entry.nativeNvidiaProviderAttachment ||
        entry.nativeLocalProviderAttachment,
      ),
    };
  },
  readOpenclawConfig: (sandboxName, gatewayName) => {
    const config = initialOpenclawInferenceRouteRuntime.loadSandboxConfig();
    return config.readSandboxConfig(
      sandboxName,
      config.resolveAgentConfig(sandboxName),
      gatewayName,
    );
  },
  patchOpenclawInferenceConfig: (...args) =>
    initialOpenclawInferenceRouteRuntime.loadInferenceSet().patchOpenClawInferenceConfig(...args),
  writeOpenclawInferenceConfigNatively: (sandboxName, config, route, gatewayName) => {
    const inferenceSet = initialOpenclawInferenceRouteRuntime.loadInferenceSet();
    inferenceSet.writeOpenClawInferenceConfigNatively(
      sandboxName,
      config,
      route,
      initialOpenclawInferenceRouteRuntime.loadSandboxConfig().setOpenClawConfigValues,
      gatewayName,
    );
  },
  restartNativeGateway: (sandboxName, gatewayName) =>
    initialOpenclawInferenceRouteRuntime
      .loadFinalizationDeps()
      .restartNativeGatewayForInitialSetup(sandboxName, gatewayName),
};

export const initializeOpenclawInferenceRoute =
  createInitialOpenclawInferenceRoute(nativeInferenceRouteDeps);

/** The caller owns the offline restore window and its subsequent gateway restart. */
export const writeRestoredOpenclawInferenceRoute =
  createOpenclawInferenceRouteWriter(nativeInferenceRouteDeps);

/** Reapply the recorded operator route after the outer rebuild restores its backup. */
export async function refreshRestoredRegisteredOpenclawInferenceRoute(
  entry: SandboxEntry,
  runtimeSelection: OpenShellRuntimeSelection | undefined,
  readRegistration: (name: string) => SandboxEntry | null,
  write: InitializeOpenclawInferenceRoute = writeRestoredOpenclawInferenceRoute,
): Promise<void> {
  const binding = entry.registeredInferenceProviderAttachment;
  if (!binding) return;
  if (
    !entry.gatewayName ||
    !entry.provider ||
    !entry.model ||
    (entry.agent && entry.agent !== "openclaw") ||
    (runtimeSelection && runtimeSelection.gatewayName !== entry.gatewayName)
  )
    throw new Error("Restored OpenClaw registered route does not match its selected runtime.");
  const expected = structuredClone(entry);
  const revalidate = createRegisteredSandboxIdentityRevalidation(expected, {
    readRegistration,
    observe: (sandboxName, gatewayName) =>
      observeSandboxOnGateway({ sandboxName, gatewayName }, undefined, runtimeSelection, 15_000),
  });
  if (!revalidate)
    throw new Error("Restored OpenClaw inference requires verified sandbox identity.");
  const assertCurrent = (operation: string) => {
    revalidate(operation);
    const current = readRegistration(entry.name);
    const fields = [
      "agent",
      "provider",
      "model",
      "endpointUrl",
      "preferredInferenceApi",
      "credentialEnv",
      "registeredInferenceProviderAttachment",
    ] as const;
    if (!current || fields.some((field) => !isDeepStrictEqual(current[field], expected[field])))
      throw new Error("Restored OpenClaw provider selection changed before configuration write.");
  };
  assertCurrent("restore registered OpenClaw inference");
  await write(
    entry.name,
    entry.model,
    entry.provider,
    entry.preferredInferenceApi ?? null,
    entry.gatewayName,
    assertCurrent,
    {
      nativeProvider: true,
      endpointUrl: binding.endpointUrl,
      registeredInferenceProviderAttachment: binding,
    },
  );
}
