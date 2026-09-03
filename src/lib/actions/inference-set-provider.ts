// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  endpointlessProviderProfileFailureMessages,
  OPENAI_GATEWAY_PROVIDER_TYPE,
} from "../adapters/openshell/provider-profile-registration";
import { endpointlessProviderProfilePath } from "../adapters/openshell/provider-profile";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderError,
  OpenShellProviderMetadata,
} from "../adapters/openshell/provider-adapter";
import { createCliOpenShellProviderAdapter } from "../adapters/openshell/provider-adapter-cli";
import { namedOpenShellGateway } from "../adapters/openshell/sandbox-observer";
import { REPOSITORY_ROOT } from "../core/repository-root";
import { retryUntilAsync } from "../core/retry";
import { matchesGatewayProviderBinding } from "../onboard/gateway-provider-metadata";
import { assertHermesPortableCommandUnavailable } from "../onboard/experimental/portable-agent-lifecycle";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundle,
  type RuntimeProviderBundleRegistry,
  RuntimeProviderSelectionError,
  requireRuntimeProviderBundleForSandbox,
  requireRuntimeProviderMutationAuthority,
} from "../onboard/runtime-provider/access";
import type { SandboxEntry } from "../state/registry";
import { InferenceSetError } from "./inference-set-error";
import type { InferenceSetProviderBinding } from "./inference-set-route-containment";
import type {
  SandboxInferenceInvocationInput,
  SandboxInferenceInvocationResult,
} from "./sandbox/inference-invocation-probe";

export type { RuntimeProviderBundleRegistry };
export { RuntimeProviderSelectionError };
export type InferenceSetProviderAdapter = OpenShellProviderAdapter;

export function createDefaultInferenceSetProviderAdapter(): OpenShellProviderAdapter {
  return createCliOpenShellProviderAdapter();
}

export type InferenceSetSandboxRouteProbe = (
  input: SandboxInferenceInvocationInput,
) => SandboxInferenceInvocationResult;

// OpenShell 0.0.106 refreshes the sandbox route cache every five seconds.
// A stale route can still return a valid 2xx response, so wait one complete
// refresh interval before probing a changed provider/model selection.
const ROUTE_SELECTION_REFRESH_WAIT_MS = 6_000;
const ROUTE_FAMILY_CONVERGENCE_RETRY_DELAYS_MS = [2_000, 4_000] as const;

export function sleepInferenceSetRouteConvergence(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function probeInferenceSetSandboxRoute(
  input: SandboxInferenceInvocationInput,
): SandboxInferenceInvocationResult {
  const probe: typeof import("./sandbox/inference-invocation-probe") = require("./sandbox/inference-invocation-probe");
  return probe.probeSandboxInferenceInvocation(
    input,
    {},
    probe.READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
  );
}

export async function probeInferenceSetSandboxRouteUntilConverged(
  options: {
    input: SandboxInferenceInvocationInput;
    previousProvider: string;
    previousModel: string;
    previousInferenceApi: string | null;
    targetInferenceApi: string | null;
  },
  deps: {
    probe: InferenceSetSandboxRouteProbe;
    sleep: (milliseconds: number) => Promise<void>;
    onRetry?: (
      result: SandboxInferenceInvocationResult,
      delayMs: number,
      attempt: number,
    ) => void | Promise<void>;
  } = {
    probe: probeInferenceSetSandboxRoute,
    sleep: sleepInferenceSetRouteConvergence,
  },
): Promise<SandboxInferenceInvocationResult> {
  const routeSelectionChanged =
    options.previousProvider !== options.input.provider ||
    options.previousModel !== options.input.model;
  if (routeSelectionChanged) {
    await deps.sleep(ROUTE_SELECTION_REFRESH_WAIT_MS);
  }
  const inferenceApiChanged = options.previousInferenceApi !== options.targetInferenceApi;
  return await retryUntilAsync(() => deps.probe(options.input), {
    accept: (result) =>
      result.ok ||
      // A probe that never reached an HTTP status failed below the route: the
      // sandbox could not reach the gateway while it was still reloading the
      // changed selection, or the first request after an idle period outran the
      // probe timeout. Retry those on the same convergence schedule instead of
      // rolling a valid selection back on a transport blip.
      (result.httpStatus !== null &&
        (!inferenceApiChanged || (result.httpStatus !== 400 && result.httpStatus !== 404))),
    retryDelaysMs: ROUTE_FAMILY_CONVERGENCE_RETRY_DELAYS_MS,
    onRetry: deps.onRetry,
    sleep: deps.sleep,
  });
}

export function requireInferenceSetRuntimeAuthority(
  entry: SandboxEntry,
  providers: RuntimeProviderBundleRegistry = CURRENT_RUNTIME_PROVIDER_BUNDLES,
): RuntimeProviderBundle {
  const runtimeProvider = requireRuntimeProviderBundleForSandbox(entry, providers);
  requireRuntimeProviderMutationAuthority(runtimeProvider, "inference-set");
  return runtimeProvider;
}

export function assertInferenceSetCommandAvailable(sandboxName: string): void {
  assertHermesPortableCommandUnavailable(sandboxName, "inference:set");
}

type ProviderSurface = {
  type: "openai" | "anthropic";
  configKey: "OPENAI_BASE_URL" | "ANTHROPIC_BASE_URL";
};

type ProviderObservation =
  | { kind: "absent" }
  | {
      kind: "present";
      metadata: OpenShellProviderMetadata;
    }
  | { kind: "error"; error: OpenShellProviderError };

function providerSurface(
  providerType: InferenceSetProviderBinding["providerType"],
): ProviderSurface {
  return providerType === "anthropic"
    ? { type: "anthropic", configKey: "ANTHROPIC_BASE_URL" }
    : { type: "openai", configKey: "OPENAI_BASE_URL" };
}

async function inspectProvider(
  providerAdapter: OpenShellProviderAdapter,
  gatewayName: string,
  providerName: string,
): Promise<ProviderObservation> {
  const result = await providerAdapter.getProvider({
    target: namedOpenShellGateway(gatewayName),
    providerName,
  });
  if (!result.ok) {
    return result.error.kind === "command" && result.error.reason === "not_found"
      ? { kind: "absent" }
      : { kind: "error", error: result.error };
  }
  return { kind: "present", metadata: result.value };
}

function expectedShape(providerName: string, surface: ProviderSurface, credentialEnv: string) {
  return {
    name: providerName,
    type: surface.type,
    credentialKey: credentialEnv,
    configKey: surface.configKey,
  };
}

function assertProviderOwnership(options: {
  observation: ProviderObservation;
  providerName: string;
  surface: ProviderSurface;
  credentialEnv: string;
  allowCreate: boolean;
}): "create" | "update" {
  const { observation, providerName, surface, credentialEnv } = options;
  if (observation.kind === "absent") {
    if (!options.allowCreate) {
      // The credential this route needs is held by NemoClaw's local no-auth
      // proxy, not by a host credential this command can resolve, and the
      // reachable base URL is the proxy's bridge address rather than the
      // recorded loopback URL. Creating the provider here would register an
      // unreachable, credential-less binding, so stop before any mutation.
      throw new InferenceSetError(
        `Provider '${providerName}' is no longer registered on this sandbox's gateway and cannot be ` +
          `recreated by inference set: its endpoint was onboarded without authentication, so the ` +
          `provider binding is owned by onboarding. Rerun onboarding to restore the provider.`,
        2,
      );
    }
    return "create";
  }
  if (observation.kind === "error") {
    throw new InferenceSetError(
      `Could not inspect provider '${providerName}'; no provider mutation was attempted. ${observation.error.message}`,
      1,
    );
  }
  if (
    !matchesGatewayProviderBinding(
      observation.metadata,
      expectedShape(providerName, surface, credentialEnv),
    )
  ) {
    throw new InferenceSetError(
      `Refusing to replace provider '${providerName}': its live binding is malformed, foreign, or does not match this sandbox's durable custom-endpoint provenance. Rerun onboarding to reconcile the provider safely.`,
      2,
    );
  }
  return "update";
}

function profileFailureMessage(error: OpenShellProviderError): string {
  if (error.kind === "command" && error.reason === "profile_incompatible") {
    return endpointlessProviderProfileFailureMessages("incompatible").join("\n").trim();
  }
  const recovery = (() => {
    switch (error.kind) {
      case "authentication":
        return "Restore OpenShell authentication for the selected gateway, then rerun this command.";
      case "timeout":
        return "Confirm the selected OpenShell gateway is available, then rerun this command.";
      case "schema":
        return "Update OpenShell with `scripts/install-openshell.sh`, then rerun this command.";
      case "validation":
        return "Restore the checked-in OpenAI provider profile from this NemoClaw release, then rerun this command.";
      case "transport":
        if (error.reason === "unreachable") {
          return "Start the selected OpenShell gateway with its owning deployment, then rerun this command.";
        }
        if (error.reason === "identity_mismatch") {
          return "Reselect the intended OpenShell gateway and restore its recorded identity, then rerun this command.";
        }
        return "Repair OpenShell with `scripts/install-openshell.sh`, then rerun this command.";
      case "command":
        return "Fix the reported OpenShell provider profile error, then rerun this command.";
    }
  })();
  return `OpenShell could not prepare NemoClaw's checked-in OpenAI provider profile. ${sentence(error.message)} ${recovery}`;
}

function sentence(message: string): string {
  const trimmed = message.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function incompleteProviderRevisionMessage(
  providerName: string,
  blockedMutation: "inference route" | "provider",
): string {
  return (
    `Could not inspect provider '${providerName}'; no ${blockedMutation} mutation was attempted. ` +
    "OpenShell returned provider metadata without a revision. " +
    "Update OpenShell with `scripts/install-openshell.sh`, then rerun this command."
  );
}

function isUncertainProviderMutationError(error: OpenShellProviderError): boolean {
  return (
    error.kind === "timeout" ||
    (error.kind === "transport" && error.reason === "unreachable") ||
    (error.kind === "command" && error.reason === "uncertain")
  );
}

class InferenceSetProviderCommitError extends InferenceSetError {
  constructor(
    message: string,
    readonly providerStateMayBePartial: boolean,
    exitCode = 1,
  ) {
    super(message, exitCode);
    this.name = "InferenceSetProviderCommitError";
  }
}

function providerCommitError(
  error: unknown,
  providerStateMayBePartial: boolean,
): InferenceSetProviderCommitError {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode = error instanceof InferenceSetError ? error.exitCode : 1;
  return new InferenceSetProviderCommitError(message, providerStateMayBePartial, exitCode);
}

/** Return true unless a failed deferred commit proves it did not change the provider. */
export function providerCommitMayHaveChangedBinding(error: unknown): boolean {
  return !(error instanceof InferenceSetProviderCommitError) || error.providerStateMayBePartial;
}

function providerMutationFailureMessage(
  action: "create" | "update",
  providerName: string,
  error: OpenShellProviderError,
): string {
  if (!isUncertainProviderMutationError(error)) {
    return `OpenShell could not ${action} provider '${providerName}': ${error.message}`;
  }
  return (
    `OpenShell could not confirm the ${action} operation for provider '${providerName}'. ` +
    `Provider state may be partial. ${sentence(error.message)} ` +
    "Rerun onboarding to reconcile the provider before rerunning this command."
  );
}

/**
 * Verify a live gateway provider still carries this sandbox's durable binding,
 * without creating or updating it. A route selection that mutates no provider
 * still hands OpenShell's stored credential to whatever provider now answers to
 * that name, so a same-name foreign or malformed binding has to be rejected
 * before the selection, not only when a provider mutation is prepared.
 */
export async function assertInferenceSetProviderOwnership(options: {
  gatewayName: string;
  providerName: string;
  providerType: InferenceSetProviderBinding["providerType"];
  credentialEnv: string;
  providerAdapter: OpenShellProviderAdapter;
}): Promise<void> {
  const observation = await inspectProvider(
    options.providerAdapter,
    options.gatewayName,
    options.providerName,
  );
  if (observation.kind === "present" && observation.metadata.revision == null) {
    throw new InferenceSetError(
      incompleteProviderRevisionMessage(options.providerName, "inference route"),
      1,
    );
  }
  assertProviderOwnership({
    observation,
    providerName: options.providerName,
    surface: providerSurface(options.providerType),
    credentialEnv: options.credentialEnv,
    allowCreate: false,
  });
}

export type PreparedInferenceSetProviderBinding = Readonly<{
  action: "create" | "update";
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}>;

export async function prepareInferenceSetProviderBinding(options: {
  gatewayName: string;
  providerName: string;
  binding: InferenceSetProviderBinding;
  providerAdapter: OpenShellProviderAdapter;
  /** False when only onboarding can rebuild this provider's binding. */
  allowCreate?: boolean;
}): Promise<PreparedInferenceSetProviderBinding> {
  const { gatewayName, providerName, binding, providerAdapter } = options;
  const target = namedOpenShellGateway(gatewayName);
  const surface = providerSurface(binding.providerType);
  const before = await inspectProvider(providerAdapter, gatewayName, providerName);
  const action = assertProviderOwnership({
    observation: before,
    providerName,
    surface,
    credentialEnv: binding.credentialEnv,
    allowCreate: options.allowCreate !== false,
  });
  if (action === "update" && (before.kind !== "present" || before.metadata.revision == null)) {
    throw new InferenceSetError(incompleteProviderRevisionMessage(providerName, "provider"), 1);
  }

  const apply = async (): Promise<OpenShellProviderMetadata> => {
    const updateRevision = before.kind === "present" ? before.metadata.revision : null;
    const verifyUpdateRevision = async (): Promise<void> => {
      const current = await inspectProvider(providerAdapter, gatewayName, providerName);
      try {
        assertProviderOwnership({
          observation: current,
          providerName,
          surface,
          credentialEnv: binding.credentialEnv,
          allowCreate: false,
        });
      } catch (error) {
        throw providerCommitError(error, false);
      }
      if (
        current.kind !== "present" ||
        current.metadata.revision == null ||
        updateRevision == null
      ) {
        throw new InferenceSetProviderCommitError(
          incompleteProviderRevisionMessage(providerName, "provider"),
          false,
        );
      }
      if (
        current.metadata.revision.id !== updateRevision.id ||
        current.metadata.revision.resourceVersion !== updateRevision.resourceVersion
      ) {
        throw new InferenceSetProviderCommitError(
          `Provider '${providerName}' changed after it was inspected; no provider mutation was attempted. Rerun this command against the current provider revision.`,
          false,
        );
      }
    };
    if (action === "update") await verifyUpdateRevision();
    if (surface.type === OPENAI_GATEWAY_PROVIDER_TYPE) {
      const profile = await providerAdapter.importProviderProfile({
        target,
        profilePath: endpointlessProviderProfilePath(REPOSITORY_ROOT, OPENAI_GATEWAY_PROVIDER_TYPE),
      });
      if (!profile.ok) {
        throw new InferenceSetProviderCommitError(profileFailureMessage(profile.error), false);
      }
    }
    if (action === "update") await verifyUpdateRevision();
    const credentials = [{ name: binding.credentialEnv, value: binding.token }];
    const config = [{ key: surface.configKey, value: binding.baseUrl }];
    const result =
      action === "create"
        ? await providerAdapter.createProvider({
            target,
            name: providerName,
            type: surface.type,
            credentials,
            config,
            fromExisting: false,
          })
        : await providerAdapter.updateProvider({
            target,
            providerName,
            credentials,
            config,
          });
    const after = await inspectProvider(providerAdapter, gatewayName, providerName);
    if (!result.ok) {
      throw new InferenceSetProviderCommitError(
        providerMutationFailureMessage(action, providerName, result.error),
        isUncertainProviderMutationError(result.error),
      );
    }
    if (
      after.kind !== "present" ||
      after.metadata.revision == null ||
      (action === "update" &&
        (updateRevision == null ||
          after.metadata.revision.id !== updateRevision.id ||
          after.metadata.revision.resourceVersion <= updateRevision.resourceVersion)) ||
      !matchesGatewayProviderBinding(
        after.metadata,
        expectedShape(providerName, surface, binding.credentialEnv),
      )
    ) {
      throw new InferenceSetProviderCommitError(
        `Provider '${providerName}' did not converge to the expected type and binding-key shape after ${action}. ` +
          `Provider state may be partial. Rerun onboarding to reconcile it before rerunning this command.`,
        true,
      );
    }
    return after.metadata;
  };

  if (action === "update") {
    return {
      action,
      commit: async () => {
        await apply();
      },
      rollback: async () => {},
    };
  }

  const created = await apply();
  const createdRevision = created.revision;
  return {
    action,
    commit: async () => {},
    rollback: async () => {
      const current = await inspectProvider(providerAdapter, gatewayName, providerName);
      if (current.kind === "absent") return;
      if (current.kind === "error") {
        throw new InferenceSetError(
          `Could not inspect newly created provider '${providerName}': ${sentence(current.error.message)} ` +
            "No provider deletion was attempted. Resolve the reported OpenShell error, then rerun onboarding to reconcile the provider.",
          1,
        );
      }
      if (
        createdRevision == null ||
        current.metadata.revision == null ||
        current.metadata.revision.id !== createdRevision.id ||
        current.metadata.revision.resourceVersion !== createdRevision.resourceVersion ||
        !matchesGatewayProviderBinding(
          current.metadata,
          expectedShape(providerName, surface, binding.credentialEnv),
        )
      ) {
        throw new InferenceSetError(
          `Could not verify newly created provider '${providerName}' before rollback; no provider deletion was attempted. Rerun onboarding before rerunning this switch.`,
          1,
        );
      }
      const result = await providerAdapter.deleteProvider({
        target,
        providerName,
      });
      const restored = await inspectProvider(providerAdapter, gatewayName, providerName);
      if (restored.kind === "absent") return;
      if (restored.kind === "error") {
        const mutationDetail = result.ok
          ? `OpenShell accepted removal of newly created provider '${providerName}' during rollback.`
          : `OpenShell could not remove newly created provider '${providerName}' during rollback: ${sentence(result.error.message)}`;
        throw new InferenceSetError(
          `${mutationDetail} A follow-up inspection failed: ${sentence(restored.error.message)} ` +
            "Resolve the reported OpenShell errors, then rerun onboarding to reconcile the provider.",
          1,
        );
      }
      if (!result.ok) {
        throw new InferenceSetError(
          `OpenShell could not remove newly created provider '${providerName}' during rollback. ` +
            `The provider remains registered. ${sentence(result.error.message)} ` +
            "Rerun onboarding to reconcile the provider before rerunning this switch.",
          1,
        );
      }
      throw new InferenceSetError(
        `Newly created provider '${providerName}' did not settle as absent after rollback. ` +
          "The provider remains registered. Rerun onboarding to reconcile the provider before rerunning this switch.",
        1,
      );
    },
  };
}

export const __test = {
  inspectProvider,
  providerSurface,
};
