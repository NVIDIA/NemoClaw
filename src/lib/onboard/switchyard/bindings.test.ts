// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createSwitchyardProviderFixture } from "../../../../test/support/switchyard-provider-adapter";
import {
  createHermesSwitchyardRoutingIntent,
  serializeHermesSwitchyardRouting,
} from "../../hermes-switchyard-routing";
import {
  assertSwitchyardProviderEnvironment,
  validateSwitchyardProviderBindings,
} from "../../hermes-switchyard-routing";
import { observeSwitchyardProviderBindings, verifySwitchyardProviderBindings } from "./bindings";
import { prepareSwitchyardProviders, setupSwitchyardInference } from "./setup";
import { createSetupInference, type SetupInferenceDeps } from "../setup-inference";
import {
  HERMES_SWITCHYARD_ROUTING_ENV,
  encodeHermesSwitchyardRoutingIntent,
} from "../../hermes-switchyard-routing";
import { HERMES_SWITCHYARD_BINDINGS_ENV } from "../../hermes-switchyard-routing";
import { removeSwitchyardProviders } from "./bindings";
import type { SandboxEntry } from "../../state/registry";
import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../managed-startup/profile";
import { requireLaunchSemanticHealth } from "../../actions/sandbox/launch-readiness/health";
import { loadAgent } from "../../agent/defs";

const routing = createHermesSwitchyardRoutingIntent({
  efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
  capable: { provider: "openai-api", model: "gpt-5" },
});
const target = { kind: "named", gatewayName: "test-gateway" } as const;

const fixture = () => createSwitchyardProviderFixture(routing);

describe("Switchyard provider bindings", () => {
  it("publishes both observations through onboarding without changing a shared inference route (#13863)", async () => {
    const f = fixture();
    const environment = {
      [HERMES_SWITCHYARD_ROUTING_ENV]: encodeHermesSwitchyardRoutingIntent(routing),
    };
    let entry: SandboxEntry | null = null;
    const updateSandbox = vi.fn<SetupInferenceDeps["updateSandbox"]>((name, route) => {
      entry = { name, ...route, pendingRouteReservation: true };
      return true;
    });
    const inferenceRouteMutator = { setInferenceRoute: vi.fn() };
    const setup = createSetupInference({
      environment,
      providerAdapter: f.input.adapter,
      hydrateCredentialEnv: f.input.readCredential,
      updateSandbox,
      getSandbox: () => entry,
      getGatewayName: () => "test-gateway",
      isRoutedInferenceProvider: () => false,
      withSandboxMutationLock: (_name: string, fn: () => Promise<unknown>) => fn(),
      withGatewayRouteMutationLock: (_name: string, fn: () => Promise<unknown>) => fn(),
      inferenceRouteMutator,
      log: vi.fn(),
    } as unknown as SetupInferenceDeps);
    await expect(
      setup(
        "test-sandbox",
        routing.capable.model,
        routing.capable.provider,
        "https://api.openai.com/v1",
        "OPENAI_API_KEY",
        null,
        [],
        { reservationSessionId: "session-test" },
      ),
    ).resolves.toEqual({ ok: true });
    expect(entry).toMatchObject({ hermesSwitchyard: { routing, bindings: { schemaVersion: 1 } } });
    expect(environment).toHaveProperty(HERMES_SWITCHYARD_BINDINGS_ENV);
    expect(inferenceRouteMutator.setInferenceRoute).not.toHaveBeenCalled();
    expect(f.methods.createProvider).toHaveBeenCalledTimes(2);
  });

  it("creates fresh targets and records an explicit capable judge without exposing keys (#13863)", async () => {
    const f = fixture();
    const { bindings, verify } = await f.setup();
    expect(await verifySwitchyardProviderBindings(verify)).toEqual(bindings);
    expect(bindings.providers).toHaveLength(2);
    expect(bindings.judge).toEqual({
      ...bindings.capable,
      mode: "reuse-capable",
      target: "capable",
    });
    expect(f.methods.updateProvider).not.toHaveBeenCalled();
    const deployment = serializeHermesSwitchyardRouting(routing, bindings).switchyardDeploymentToml;
    expect(deployment.match(/forward_auth = false/gu)).toHaveLength(2);
    expect(JSON.stringify(bindings) + deployment).not.toMatch(/test-secret-|inference\.local/u);
    expect(
      f.methods.inspectProviderProfile.mock.calls.every(
        ([input]) => input.expectedProfile !== undefined,
      ),
    ).toBe(true);
  });

  it("shares one physical binding for different models at the same provider (#13863)", async () => {
    const f = fixture();
    const intent = createHermesSwitchyardRoutingIntent({
      efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
      capable: { provider: "nvidia-prod", model: "nvidia/super" },
    });
    const { bindings, verify } = await f.setup(intent);
    expect(await verifySwitchyardProviderBindings(verify)).toEqual(bindings);
    expect(f.methods.createProvider).toHaveBeenCalledTimes(1);
    expect(bindings.efficient.providerId).toBe(bindings.capable.providerId);
    expect(bindings.efficient.model).not.toBe(bindings.capable.model);
  });

  it("reverifies a published binding without provider creation, credential reads, or route reservation (#13863)", async () => {
    const f = fixture();
    const { bindings } = await f.setup();
    const environment: NodeJS.ProcessEnv = {};
    const updateSandbox = vi.fn(() => true);
    const hydrateCredentialEnv = vi.fn(() => "must-not-read");
    const input = {
      routing,
      sandboxName: "test-sandbox",
      gatewayName: "test-gateway",
      provider: routing.capable.provider,
      model: routing.capable.model,
      endpointUrl: "https://api.openai.com/v1",
      endpointSource: "onboard" as const,
      credentialEnv: "OPENAI_API_KEY",
      environment,
      options: {},
      deps: {
        providerAdapter: f.input.adapter,
        updateSandbox,
        hydrateCredentialEnv,
        getSandbox: () => ({
          name: "test-sandbox",
          gatewayName: "test-gateway",
          provider: routing.capable.provider,
          model: routing.capable.model,
          hermesSwitchyard: { routing, bindings },
        }),
      },
    };
    f.methods.createProvider.mockClear();
    await expect(setupSwitchyardInference(input)).resolves.toEqual({ ok: true });
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(hydrateCredentialEnv).not.toHaveBeenCalled();
    expect(f.methods.createProvider).not.toHaveBeenCalled();
    f.names.splice(0, 1);
    await expect(setupSwitchyardInference(input)).rejects.toThrow("no longer attached");
    expect(environment).not.toHaveProperty(HERMES_SWITCHYARD_BINDINGS_ENV);
  });

  it("rejects missing credentials before creating either provider (#13863)", async () => {
    const f = fixture();
    await expect(
      prepareSwitchyardProviders({ ...f.input, readCredential: () => null }),
    ).rejects.toThrow("host credential");
    expect(f.methods.createProvider).not.toHaveBeenCalled();
  });

  it("refuses existing providers without updating credentials (#13863)", async () => {
    const f = fixture();
    await f.setup();
    f.methods.createProvider.mockClear();
    await expect(prepareSwitchyardProviders(f.input)).rejects.toThrow("existing provider");
    expect(f.methods.createProvider).not.toHaveBeenCalled();
    expect(f.methods.updateProvider).not.toHaveBeenCalled();
    expect(f.methods.deleteProvider).not.toHaveBeenCalled();
  });

  it("removes the first new provider when the second create fails (#13863)", async () => {
    const f = fixture();
    f.methods.createProvider
      .mockImplementationOnce(async (input) => {
        f.providers.set(input.name, {
          name: input.name,
          type: input.type,
          credentialKeys: input.credentials.map((c) => c.name),
          configKeys: [],
          revision: { id: "owned-id", resourceVersion: 1 },
        });
        return { ok: true };
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "failed", message: "test-secret-do-not-print" },
      });
    await expect(prepareSwitchyardProviders(f.input)).rejects.toThrow("setup failed");
    expect(f.providers.size).toBe(0);
    expect(f.methods.deleteProvider).toHaveBeenCalledTimes(1);
  });

  it.each([
    { change: "replaced", patch: { revision: { id: "replacement", resourceVersion: 1 } } },
    { change: "revised", patch: { revision: { id: "id-0", resourceVersion: 2 } } },
    { change: "wrong-profile", patch: { type: "openai" } },
    { change: "wrong-key", patch: { credentialKeys: ["OTHER_KEY"] } },
    { change: "config", patch: { configKeys: ["base_url"] } },
  ])("rejects $change state before readiness (#13863)", async ({ patch }) => {
    const f = fixture();
    const { bindings, verify } = await f.setup();
    const first = bindings.providers[0];
    const metadata = f.providers.get(first.providerName)!;
    f.providers.set(first.providerName, { ...metadata, ...patch });
    await expect(verifySwitchyardProviderBindings(verify)).rejects.toThrow("provider binding");
    expect(f.methods.updateProvider).not.toHaveBeenCalled();
  });

  it.each([
    {
      change: "removed",
      mutate: (f: ReturnType<typeof fixture>) => f.providers.delete(f.names[0]),
    },
    { change: "detached", mutate: (f: ReturnType<typeof fixture>) => f.names.splice(0, 1) },
    {
      change: "duplicate-attachment",
      mutate: (f: ReturnType<typeof fixture>) => f.names.push(f.names[0]),
    },
  ])("rejects $change state before readiness (#13863)", async ({ mutate }) => {
    const f = fixture();
    const { verify } = await f.setup();
    mutate(f);
    await expect(verifySwitchyardProviderBindings(verify)).rejects.toThrow("provider binding");
  });

  it("rejects a profile that cannot attest its endpoint and credential boundary (#13863)", async () => {
    const f = fixture();
    const { observe } = await f.setup();
    f.methods.inspectProviderProfile.mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "profile_incompatible", message: "test-secret" },
    });
    await expect(observeSwitchyardProviderBindings(observe)).rejects.toThrow("cannot be attested");
  });

  it("removes only recorded identities after sandbox deletion and permits a repeated cleanup (#13863)", async () => {
    const f = fixture();
    const { bindings } = await f.setup();
    const input = { state: { routing, bindings }, adapter: f.input.adapter, target };
    await removeSwitchyardProviders(input);
    await removeSwitchyardProviders(input);
    expect(f.providers.size).toBe(0);
    expect(f.methods.deleteProvider).toHaveBeenCalledTimes(2);
  });

  it("invalidates launch readiness after provider removal without probing an ordinary inference path (#13863)", async () => {
    const f = fixture();
    const { bindings } = await f.setup();
    const profile = managedStartupE2eProfile("hermes");
    const encodedProfile = encodeManagedStartupProfile({
      ...profile,
      agentConfig: {
        agent: "hermes",
        webSearch: { enabled: false, provider: "tavily" },
        switchyardRouting: routing,
        switchyardBindings: bindings,
      },
    });
    const entry: SandboxEntry = {
      name: "test-sandbox",
      agent: "hermes",
      gatewayName: "test-gateway",
      provider: routing.capable.provider,
      model: routing.capable.model,
      hermesSwitchyard: { routing, bindings },
      workload: {
        schemaVersion: 1,
        kind: "managed-image",
        reference: `ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:${"1".repeat(64)}`,
        release: "v0.1.0",
        sourceRevision: "2".repeat(40),
        sourceCohort: "ghrun-1-1",
        capabilityContractVersion: 1,
        startupProfileContractVersion: 1,
        encodedProfile,
        startupProfileSha256: "3".repeat(64),
        credentialProxyReplayRequired: false,
        shared: true,
      },
    };
    const inferenceProbe = vi.fn();
    const deps = {
      switchyardProviderAdapter: f.input.adapter,
      gatewayHealth: async () => true,
      forwardsHealthy: () => true,
      inferenceProbe,
    };
    const check = () =>
      requireLaunchSemanticHealth(
        entry.name,
        "test-gateway",
        "hermes",
        entry,
        loadAgent("hermes"),
        true,
        deps,
      );
    await expect(check()).resolves.toBeUndefined();
    f.providers.delete(bindings.providers[0].providerName);
    await expect(check()).rejects.toThrow("provider binding");
    expect(inferenceProbe).not.toHaveBeenCalled();
  });

  it("refuses to remove a rotated provider during terminal cleanup (#13863)", async () => {
    const f = fixture();
    const { bindings } = await f.setup();
    const first = bindings.providers[0];
    f.providers.set(first.providerName, {
      ...f.providers.get(first.providerName)!,
      revision: { id: first.providerId, resourceVersion: 2 },
    });
    await expect(
      removeSwitchyardProviders({ state: { routing, bindings }, adapter: f.input.adapter, target }),
    ).rejects.toThrow("refusing to remove");
    expect(f.methods.deleteProvider).not.toHaveBeenCalled();
  });

  it("rejects duplicate physical identities and a changed judge role (#13863)", async () => {
    const f = fixture();
    const { bindings, observe } = await f.setup();
    expect(() =>
      validateSwitchyardProviderBindings(
        { ...bindings, judge: { ...bindings.judge, providerId: bindings.efficient.providerId } },
        routing,
      ),
    ).toThrow("provider state");
    const first = bindings.providers[0];
    const second = bindings.providers[1];
    f.providers.set(second.providerName, {
      ...f.providers.get(second.providerName)!,
      revision: { id: first.providerId, resourceVersion: 1 },
    });
    await expect(observeSwitchyardProviderBindings(observe)).rejects.toThrow("same identity");
  });

  it.each([
    "test-secret-raw",
    "openshell:resolve:env:OPENAI_API_KEY",
    "openshell:resolve:env:v1_OPENAI_API_KEY",
  ])(
    "rejects an unscoped or raw runtime credential without printing it (#13863)",
    async (value) => {
      const f = fixture();
      const { bindings } = await f.setup();
      const env = Object.fromEntries(
        bindings.providers.map((p) => [
          p.credentialEnv,
          `openshell:resolve:env:s${"a".repeat(64)}_${p.credentialEnv}`,
        ]),
      );
      expect(() => assertSwitchyardProviderEnvironment(env, { routing, bindings })).not.toThrow();
      env.OPENAI_API_KEY = value;
      expect(() => assertSwitchyardProviderEnvironment(env, { routing, bindings })).toThrow(
        "endpoint-scoped",
      );
    },
  );
});
