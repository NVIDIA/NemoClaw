// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { withRestoredCredentialEnv } from "../credential-env";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import type { OpenShellGatewayTarget } from "../../adapters/openshell/sandbox-observer";
import {
  type HermesSwitchyardRoutingIntent,
  validateHermesSwitchyardRoutingIntent,
  readHermesSwitchyardRoutingEnvironment,
} from "../../hermes-switchyard-routing";
import {
  type SwitchyardProviderBindings,
  SwitchyardProviderBindingError,
  HERMES_SWITCHYARD_BINDINGS_ENV,
  encodeSwitchyardProviderBindings,
  validateSwitchyardBindingState,
} from "../../hermes-switchyard-routing";
import { nativeProviderLifecycle } from "../../inference/native-provider";
import type { NativeProviderAttachment } from "../../inference/native-provider/contract";
import {
  observeSwitchyardProviderBindings,
  verifySwitchyardProviderBindings,
  switchyardProviderDefinition,
  removeSwitchyardProviders,
} from "./bindings";
import type { SetupInferenceDeps } from "../setup-inference";
import type { ProviderInferenceSetupOptions } from "../machine/handlers/provider-inference";
import type { InferenceEndpointSource } from "../../inference/selection";

export async function setupSwitchyardInferenceIfConfigured(
  input: Omit<Parameters<typeof setupSwitchyardInference>[0], "routing">,
): Promise<{ ok: true } | null> {
  const routing = readHermesSwitchyardRoutingEnvironment(input.environment);
  return routing ? setupSwitchyardInference({ ...input, routing }) : null;
}

/** Resume only the recorded creation; never adopt or update providers by name. */
export async function setupSwitchyardInference(input: {
  routing: HermesSwitchyardRoutingIntent;
  sandboxName: string | null;
  gatewayName: string;
  provider: string;
  model: string;
  endpointUrl: string | null;
  endpointSource: InferenceEndpointSource | null;
  credentialEnv: string | null;
  environment: NodeJS.ProcessEnv;
  options: ProviderInferenceSetupOptions;
  deps: Pick<
    SetupInferenceDeps,
    "providerAdapter" | "getSandbox" | "updateSandbox" | "hydrateCredentialEnv"
  >;
}): Promise<{ ok: true }> {
  delete input.environment[HERMES_SWITCHYARD_BINDINGS_ENV];
  const { routing, sandboxName, gatewayName, provider, model, deps } = input;
  const capableDefinition = switchyardProviderDefinition(routing.capable.provider);
  if (
    !sandboxName ||
    !deps.providerAdapter ||
    provider !== routing.capable.provider ||
    model !== routing.capable.model ||
    input.endpointUrl !== capableDefinition.endpoint ||
    input.credentialEnv !== capableDefinition.credentialEnv
  )
    throw new SwitchyardProviderBindingError(
      "setup does not match the reviewed provider selection.",
    );
  const previous = deps.getSandbox?.(sandboxName);
  if (
    previous &&
    (previous.provider !== provider ||
      previous.model !== model ||
      previous.gatewayName !== gatewayName)
  )
    throw new SwitchyardProviderBindingError(
      "the recorded sandbox selection changed. No provider was changed.",
    );
  if (
    previous?.pendingRouteReservation === true &&
    previous.reservationSessionId !== input.options.reservationSessionId
  )
    throw new SwitchyardProviderBindingError(
      "another onboarding session owns the sandbox reservation. No provider was changed.",
    );
  input.options.revalidateSandboxIdentity?.("prepare the Switchyard inference providers");
  let bindings;
  if (previous?.hermesSwitchyard) {
    const recorded = validateSwitchyardBindingState(previous.hermesSwitchyard);
    if (!isDeepStrictEqual(recorded.routing, routing))
      throw new SwitchyardProviderBindingError(
        "selection changed. Recreate the sandbox before changing its provider bindings.",
      );
    bindings = await observeSwitchyardProviderBindings({
      routing,
      adapter: deps.providerAdapter,
      target: { kind: "named", gatewayName },
      providerNames: Object.fromEntries(
        recorded.bindings.providers.map((p) => [p.logicalProvider, p.providerName]),
      ),
    });
    if (!isDeepStrictEqual(recorded.bindings, bindings))
      throw new SwitchyardProviderBindingError(
        "provider state is stale. Routing was not activated.",
      );
    if (previous.pendingRouteReservation !== true) {
      await verifySwitchyardProviderBindings({
        routing,
        expected: recorded.bindings,
        sandboxName,
        adapter: deps.providerAdapter,
        target: { kind: "named", gatewayName },
        providerNames: Object.fromEntries(
          bindings.providers.map((p) => [p.logicalProvider, p.providerName]),
        ),
      });
      input.options.revalidateSandboxIdentity?.("activate the recorded Switchyard bindings");
      input.environment[HERMES_SWITCHYARD_BINDINGS_ENV] = encodeSwitchyardProviderBindings(
        bindings,
        routing,
      );
      return { ok: true };
    }
  } else {
    if (previous && previous.pendingRouteReservation !== true)
      throw new SwitchyardProviderBindingError(
        "a fresh sandbox is required; existing provider migration is not supported.",
      );
    bindings = await prepareSwitchyardProviders({
      routing,
      sandboxName,
      gatewayName,
      adapter: deps.providerAdapter,
      readCredential: deps.hydrateCredentialEnv,
    });
  }
  try {
    input.options.revalidateSandboxIdentity?.("reserve the Switchyard sandbox route");
    const reserved = deps.updateSandbox(sandboxName, {
      provider,
      model,
      endpointUrl: input.endpointUrl,
      endpointSource: input.endpointSource,
      credentialEnv: input.credentialEnv,
      gatewayName,
      preferredInferenceApi: input.options.preferredInferenceApi ?? null,
      reservationSessionId: input.options.reservationSessionId,
      hermesSwitchyard: { routing, bindings },
    });
    if (!reserved)
      throw new SwitchyardProviderBindingError(
        "could not reserve the sandbox. Routing was not activated.",
      );
  } catch (error) {
    if (!previous?.hermesSwitchyard) {
      try {
        if (!deps.getSandbox) throw new Error("Sandbox reservation readback is unavailable.");
        // A durability failure can follow a committed registry write. Preserve recorded providers.
        if (!deps.getSandbox(sandboxName)?.hermesSwitchyard) {
          await removeSwitchyardProviders({
            state: { routing, bindings },
            adapter: deps.providerAdapter,
            target: { kind: "named", gatewayName },
          });
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Switchyard provider reservation failed and cleanup could not be confirmed. Routing was not activated. Inspect the sandbox's Switchyard providers before retrying.",
        );
      }
    }
    throw error;
  }
  input.environment[HERMES_SWITCHYARD_BINDINGS_ENV] = encodeSwitchyardProviderBindings(
    bindings,
    routing,
  );
  return { ok: true };
}

/** Called under the sandbox and gateway mutation locks. Never adopt an existing provider. */
export async function prepareSwitchyardProviders(input: {
  readonly routing: HermesSwitchyardRoutingIntent;
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly adapter: OpenShellProviderAdapter;
  readonly readCredential: (envKey: string) => string | null | undefined;
}): Promise<SwitchyardProviderBindings> {
  const routing = validateHermesSwitchyardRoutingIntent(input.routing);
  // The onboarding controller validates the sandbox name. Only its bounded hash enters provider names;
  // the provider adapter separately validates gateway names at the command boundary.
  if (
    !input.sandboxName ||
    input.sandboxName.length > 63 ||
    !input.gatewayName ||
    input.gatewayName.length > 63
  )
    throw new SwitchyardProviderBindingError("invalid sandbox or gateway identity.");
  const identity = createHash("sha256")
    .update(JSON.stringify([input.gatewayName, input.sandboxName]))
    .digest("hex")
    .slice(0, 24);
  const selections = [...new Set([routing.efficient.provider, routing.capable.provider])];
  const definitions = selections.map((provider, index) => ({
    ...switchyardProviderDefinition(provider),
    providerName: `nemoclaw-sy-${identity}-${index}`,
  }));
  const target: OpenShellGatewayTarget = { kind: "named", gatewayName: input.gatewayName };
  return withRestoredCredentialEnv(
    definitions.map(({ credentialEnv }) => credentialEnv),
    async () => {
      const credentials: string[] = [];
      try {
        // Complete credential and collision preflight before the first provider create.
        for (const definition of definitions) {
          const value = input.readCredential(definition.credentialEnv);
          if (!value || value.startsWith("openshell:resolve:"))
            throw new SwitchyardProviderBindingError(
              `a host credential for ${definition.credentialEnv} is required for fresh setup.`,
            );
          credentials.push(value);
        }
        const lifecycles = definitions.map((definition) => nativeProviderLifecycle(definition));
        for (const lifecycle of lifecycles) {
          if (await lifecycle.inspectNativeProvider(input.adapter, target))
            throw new SwitchyardProviderBindingError(
              "fresh setup found an existing provider; no provider was changed.",
            );
          await lifecycle.requireNativeProviderProfileBoundary(input.adapter, target);
        }
        const created: {
          lifecycle: (typeof lifecycles)[number];
          receipt: NativeProviderAttachment;
        }[] = [];
        try {
          for (const [index, lifecycle] of lifecycles.entries()) {
            const receipt = await lifecycle.ensureNativeProvider({
              adapter: input.adapter,
              target,
              credentialValue: credentials[index] ?? null,
            });
            created.push({ lifecycle, receipt });
          }
          return await observeSwitchyardProviderBindings({
            routing,
            adapter: input.adapter,
            target,
            providerNames: Object.fromEntries(
              definitions.map((definition) => [
                definition.logicalProvider,
                definition.providerName,
              ]),
            ),
          });
        } catch {
          let cleanupFailed = false;
          for (const { lifecycle, receipt } of created.reverse()) {
            try {
              await lifecycle.removeNewNativeProvider({
                adapter: input.adapter,
                target,
                expected: receipt,
              });
            } catch {
              cleanupFailed = true;
            }
          }
          // A create without an attestable receipt cannot authorize deletion. Do not retry or adopt it.
          throw new SwitchyardProviderBindingError(
            cleanupFailed
              ? "setup failed and owned-provider cleanup is incomplete. Routing was not activated. Inspect the sandbox's Switchyard providers before retrying."
              : "setup failed. Confirmed new providers were removed; an unconfirmed create may require cleanup. Routing was not activated.",
          );
        }
      } finally {
        credentials.fill("");
      }
    },
  );
}
