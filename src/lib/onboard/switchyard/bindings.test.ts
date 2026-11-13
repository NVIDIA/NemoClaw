// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createSwitchyardProviderFixture } from "../../../../test/support/switchyard-provider-adapter";
import {
  createHermesSwitchyardRoutingIntent,
  serializeHermesSwitchyardRouting,
} from "../../hermes-switchyard-routing";
import {
  assertSwitchyardRootApplyEnvironment,
  SwitchyardProviderBindingError,
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
import { saveCredential } from "../../credentials/store";
import { createRegisteredSandboxIdentityRevalidation } from "../sandbox-recreate-transaction";

const routing = createHermesSwitchyardRoutingIntent({
  efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
  capable: { provider: "openai-api", model: "gpt-5" },
});
const target = { kind: "named", gatewayName: "test-gateway" } as const;

const fixture = () => createSwitchyardProviderFixture(routing);

function setupInput(
  f: ReturnType<typeof fixture>,
  updateSandbox: SetupInferenceDeps["updateSandbox"],
  getSandbox: NonNullable<SetupInferenceDeps["getSandbox"]> = () => null,
): Parameters<typeof setupSwitchyardInference>[0] {
  return {
    routing,
    sandboxName: f.input.sandboxName,
    gatewayName: f.input.gatewayName,
    provider: routing.capable.provider,
    model: routing.capable.model,
    endpointUrl: "https://api.openai.com/v1",
    endpointSource: "onboard",
    credentialEnv: "OPENAI_API_KEY",
    environment: {},
    options: { reservationSessionId: "session-test" },
    deps: {
      providerAdapter: f.input.adapter,
      hydrateCredentialEnv: f.input.readCredential,
      updateSandbox,
      getSandbox,
    },
  };
}

describe("Switchyard provider bindings", () => {
  it.each(["anthropic-prod", "openai-api"] as const)(
    "binds an explicit %s judge and invalidates routing after its provider is removed (#13863)",
    async (provider) => {
      const intent = createHermesSwitchyardRoutingIntent({
        efficient: routing.efficient,
        capable: routing.capable,
        judge: { provider, model: "dedicated-judge" },
      });
      const f = createSwitchyardProviderFixture(intent);
      const { bindings, verify } = await f.setup();
      expect(bindings.providers).toHaveLength(provider === "openai-api" ? 2 : 3);
      expect(f.methods.createProvider).toHaveBeenCalledTimes(bindings.providers.length);
      const judgeProvider = bindings.providers.find((p) => p.logicalProvider === provider)!;
      expect(bindings.judge).toEqual({
        providerId: judgeProvider.providerId,
        model: "dedicated-judge",
        mode: "dedicated",
        target: "judge",
      });
      expect(() =>
        validateSwitchyardProviderBindings(
          {
            ...bindings,
            judge: { ...bindings.judge, model: intent.capable.model },
          },
          intent,
        ),
      ).toThrow("provider state");
      await expect(verifySwitchyardProviderBindings(verify)).resolves.toEqual(bindings);
      f.providers.delete(judgeProvider.providerName);
      await expect(verifySwitchyardProviderBindings(verify)).rejects.toThrow("required provider");
      expect(f.methods.updateProvider).not.toHaveBeenCalled();
    },
  );

  it("requires the explicit judge credential before creating any provider (#13863)", async () => {
    const intent = createHermesSwitchyardRoutingIntent({
      efficient: routing.efficient,
      capable: routing.capable,
      judge: { provider: "anthropic-prod", model: "dedicated-judge" },
    });
    const f = createSwitchyardProviderFixture(intent);
    await expect(
      prepareSwitchyardProviders({
        ...f.input,
        readCredential: (key) => (key === "ANTHROPIC_API_KEY" ? null : "test-secret"),
      }),
    ).rejects.toThrow("ANTHROPIC_API_KEY");
    expect(f.methods.createProvider).not.toHaveBeenCalled();
    expect(f.methods.updateProvider).not.toHaveBeenCalled();
  });

  it("removes both new target providers when dedicated judge creation fails (#13863)", async () => {
    const intent = createHermesSwitchyardRoutingIntent({
      efficient: routing.efficient,
      capable: routing.capable,
      judge: { provider: "anthropic-prod", model: "dedicated-judge" },
    });
    const f = createSwitchyardProviderFixture(intent);
    const create = f.methods.createProvider.getMockImplementation()!;
    f.methods.createProvider
      .mockImplementationOnce(create)
      .mockImplementationOnce(create)
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "failed", message: "test-secret-do-not-print" },
      });
    const error = await prepareSwitchyardProviders(f.input).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("setup failed");
    expect((error as Error).message).not.toContain("test-secret-do-not-print");
    expect(f.providers.size).toBe(0);
    expect(f.methods.deleteProvider.mock.calls.map(([request]) => request.providerName)).toEqual(
      f.methods.createProvider.mock.calls
        .slice(0, 2)
        .map(([request]) => request.name)
        .reverse(),
    );
    expect(f.methods.updateProvider).not.toHaveBeenCalled();
  });

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

  it.each([
    { failure: "refused", reserve: () => false, expected: "could not reserve" },
    {
      failure: "thrown",
      reserve: () => {
        throw new Error("reservation failed");
      },
      expected: "reservation failed",
    },
  ])(
    "removes fresh providers after a $failure reservation without publishing bindings (#13863)",
    async ({ reserve, expected }) => {
      const f = fixture();
      const input = setupInput(f, reserve);

      await expect(setupSwitchyardInference(input)).rejects.toThrow(expected);

      expect(f.providers.size).toBe(0);
      expect(f.methods.deleteProvider).toHaveBeenCalledTimes(2);
      expect(input.environment).not.toHaveProperty(HERMES_SWITCHYARD_BINDINGS_ENV);
    },
  );

  it("retains providers after an uncertain reservation write and rejects provider reuse (#13863)", async () => {
    const f = fixture();
    let recorded: SandboxEntry | null = null;
    const failure = new Error("reservation durability is uncertain");
    const input = setupInput(
      f,
      (name, route) => {
        recorded = { name, ...route, pendingRouteReservation: true };
        throw failure;
      },
      () => recorded,
    );

    await expect(setupSwitchyardInference(input)).rejects.toThrow();
    expect(f.providers.size).toBe(2);
    expect(f.methods.deleteProvider).not.toHaveBeenCalled();
    expect(input.environment).not.toHaveProperty(HERMES_SWITCHYARD_BINDINGS_ENV);

    const retryReservation = vi.fn(() => true);
    input.deps.updateSandbox = retryReservation;
    await expect(setupSwitchyardInference(input)).rejects.toThrow(
      /fresh sandbox.*onboard with a new sandbox name/u,
    );
    expect(f.methods.createProvider).toHaveBeenCalledTimes(2);
    expect(f.methods.deleteProvider).not.toHaveBeenCalled();
    expect(retryReservation).not.toHaveBeenCalled();
    expect(input.environment).not.toHaveProperty(HERMES_SWITCHYARD_BINDINGS_ENV);
  });

  it("retains fresh providers when reservation readback is unavailable (#13863)", async () => {
    const f = fixture();
    const input = setupInput(f, () => false);
    delete input.deps.getSandbox;

    const failure = await setupSwitchyardInference(input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[1].message).toContain("readback is unavailable");
    expect(f.providers.size).toBe(2);
    expect(f.methods.deleteProvider).not.toHaveBeenCalled();
    expect(input.environment).not.toHaveProperty(HERMES_SWITCHYARD_BINDINGS_ENV);
  });

  it("retains fresh providers when reservation readback fails (#13863)", async () => {
    const f = fixture();
    const reservationFailure = new Error("reservation failed");
    const readFailure = new Error("registry is unavailable");
    const getSandbox = vi
      .fn<NonNullable<SetupInferenceDeps["getSandbox"]>>()
      .mockReturnValueOnce(null)
      .mockImplementation(() => {
        throw readFailure;
      });
    const input = setupInput(
      f,
      () => {
        throw reservationFailure;
      },
      getSandbox,
    );

    const failure = await setupSwitchyardInference(input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([reservationFailure, readFailure]);
    expect(f.providers.size).toBe(2);
    expect(f.methods.deleteProvider).not.toHaveBeenCalled();
    expect(input.environment).not.toHaveProperty(HERMES_SWITCHYARD_BINDINGS_ENV);
  });

  it.each([
    {
      failure: "deletion failed",
      refuse: (f: ReturnType<typeof fixture>) => {
        f.methods.deleteProvider.mockResolvedValue({
          ok: false,
          error: { kind: "command", reason: "failed", message: "private-detail" },
        });
        return false;
      },
    },
    {
      failure: "identity changed",
      refuse: (f: ReturnType<typeof fixture>) => {
        const first = f.providers.values().next().value!;
        f.providers.set(first.name, {
          ...first,
          revision: { id: "replacement", resourceVersion: 1 },
        });
        return false;
      },
    },
  ])("reports incomplete reservation cleanup when $failure (#13863)", async ({ refuse }) => {
    const f = fixture();
    const input = setupInput(f, () => refuse(f));

    const result = await setupSwitchyardInference(input).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).message).toContain("cleanup could not be confirmed");
    expect((result as AggregateError).message).not.toContain("private-detail");
    expect(f.providers.size).toBe(2);
    expect(input.environment).not.toHaveProperty(HERMES_SWITCHYARD_BINDINGS_ENV);
  });

  it("restores owned pending bindings on explicit resume without creating providers (#13863)", async () => {
    const f = fixture();
    const { bindings } = await f.setup();
    const recorded: SandboxEntry = {
      name: f.input.sandboxName,
      gatewayName: f.input.gatewayName,
      provider: routing.capable.provider,
      model: routing.capable.model,
      endpointUrl: "https://api.openai.com/v1",
      credentialEnv: "OPENAI_API_KEY",
      pendingRouteReservation: true,
      reservationSessionId: "session-test",
      hermesSwitchyard: { routing, bindings },
    };
    const updateSandbox = vi.fn(() => false);
    const input = setupInput(f, updateSandbox, () => structuredClone(recorded));
    const resumeOptions = { ...input.options, resumeSwitchyardReservation: true };
    input.options = resumeOptions;
    vi.clearAllMocks();

    await expect(setupSwitchyardInference(input)).resolves.toEqual({ ok: true });
    expect(input.environment[HERMES_SWITCHYARD_BINDINGS_ENV]).toBeTruthy();
    expect(f.methods.getProvider).toHaveBeenCalled();
    expect(f.methods.inspectProviderProfile).toHaveBeenCalled();
    expect(f.methods.createProvider).not.toHaveBeenCalled();
    expect(f.methods.updateProvider).not.toHaveBeenCalled();
    expect(f.methods.deleteProvider).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it.each<{
    failure: string;
    mutate(
      input: Parameters<typeof setupSwitchyardInference>[0],
      recorded: SandboxEntry,
      f: ReturnType<typeof fixture>,
    ): void;
  }>([
    {
      failure: "foreign owner",
      mutate: (_input, recorded) => {
        recorded.reservationSessionId = "another-session";
      },
    },
    {
      failure: "missing owner",
      mutate: (input) => {
        input.options.reservationSessionId = undefined;
      },
    },
    {
      failure: "completed reservation",
      mutate: (_input, recorded) => {
        delete recorded.pendingRouteReservation;
      },
    },
    {
      failure: "started sandbox creation",
      mutate: (_input, recorded) => {
        recorded.pendingCreateIdentity = {
          schemaVersion: 1,
          state: "verified-create",
          gatewayName: recorded.gatewayName!,
          gatewayPort: 8080,
          sandboxName: recorded.name,
          lifecycleGeneration: "generation-test",
          sandboxIdentityFingerprint: "a".repeat(64),
          route: "native",
        };
      },
    },
    {
      failure: "changed agent",
      mutate: (_input, recorded) => {
        recorded.agent = "openclaw";
      },
    },
    {
      failure: "changed routing",
      mutate: (_input, recorded) => {
        recorded.hermesSwitchyard = {
          ...recorded.hermesSwitchyard!,
          routing: createHermesSwitchyardRoutingIntent({
            efficient: { ...routing.efficient, model: "different-model" },
            capable: routing.capable,
          }),
        };
      },
    },
    {
      failure: "provider revision",
      mutate: (_input, _recorded, f) => {
        const provider = f.providers.values().next().value!;
        f.providers.set(provider.name, {
          ...provider,
          revision: { id: "replacement", resourceVersion: 2 },
        });
      },
    },
    {
      failure: "reservation drift",
      mutate: (_input, recorded, f) => {
        const inspect = f.methods.inspectProviderProfile.getMockImplementation()!;
        f.methods.inspectProviderProfile.mockImplementationOnce(async (request) => {
          recorded.reservationSessionId = "another-session";
          return inspect(request);
        });
      },
    },
  ])(
    "rejects $failure during explicit reservation resume without provider mutations (#13863)",
    async ({ mutate }) => {
      const f = fixture();
      const { bindings } = await f.setup();
      const recorded: SandboxEntry = {
        name: f.input.sandboxName,
        gatewayName: f.input.gatewayName,
        provider: routing.capable.provider,
        model: routing.capable.model,
        endpointUrl: "https://api.openai.com/v1",
        credentialEnv: "OPENAI_API_KEY",
        pendingRouteReservation: true,
        reservationSessionId: "session-test",
        hermesSwitchyard: { routing, bindings },
      };
      const updateSandbox = vi.fn(() => false);
      const input = setupInput(f, updateSandbox, () => recorded);
      input.options = { ...input.options, resumeSwitchyardReservation: true };
      input.deps.hydrateCredentialEnv = vi.fn(input.deps.hydrateCredentialEnv);
      mutate(input, recorded, f);
      vi.clearAllMocks();
      await expect(setupSwitchyardInference(input)).rejects.toThrow(SwitchyardProviderBindingError);
      expect(input.environment).not.toHaveProperty(HERMES_SWITCHYARD_BINDINGS_ENV);
      expect(input.deps.hydrateCredentialEnv).not.toHaveBeenCalled();
      expect(f.methods.createProvider).not.toHaveBeenCalled();
      expect(f.methods.updateProvider).not.toHaveBeenCalled();
      expect(f.methods.deleteProvider).not.toHaveBeenCalled();
      expect(updateSandbox).not.toHaveBeenCalled();
    },
  );

  it("rejects a recorded pending binding without attempting a resumed reservation (#13863)", async () => {
    const f = fixture();
    const { bindings } = await f.setup();
    const updateSandbox = vi.fn(() => false);
    const input = setupInput(f, updateSandbox, () => ({
      name: f.input.sandboxName,
      gatewayName: f.input.gatewayName,
      provider: routing.capable.provider,
      model: routing.capable.model,
      pendingRouteReservation: true,
      reservationSessionId: "session-test",
      hermesSwitchyard: { routing, bindings },
    }));

    await expect(setupSwitchyardInference(input)).rejects.toThrow("fresh sandbox");
    expect(f.providers.size).toBe(2);
    expect(f.methods.deleteProvider).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(input.environment).not.toHaveProperty(HERMES_SWITCHYARD_BINDINGS_ENV);
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

  it("rejects a published binding without provider access, credential reads, or route reservation (#13863)", async () => {
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
    vi.clearAllMocks();
    await expect(setupSwitchyardInference(input)).rejects.toThrow("fresh sandbox");
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(hydrateCredentialEnv).not.toHaveBeenCalled();
    expect(Object.values(f.methods).every((method) => method.mock.calls.length === 0)).toBe(true);
    expect(environment).not.toHaveProperty(HERMES_SWITCHYARD_BINDINGS_ENV);
  });

  it("rejects missing credentials before creating either provider (#13863)", async () => {
    const f = fixture();
    await expect(
      prepareSwitchyardProviders({ ...f.input, readCredential: () => null }),
    ).rejects.toThrow("host credential");
    expect(f.methods.createProvider).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "success", expected: "fulfilled", fail: () => {} },
    {
      outcome: "profile rejection",
      expected: "rejected",
      fail: (f: ReturnType<typeof fixture>) =>
        f.methods.inspectProviderProfile.mockResolvedValue({
          ok: false,
          error: { kind: "command", reason: "failed", message: "profile unavailable" },
        }),
    },
    {
      outcome: "create rejection",
      expected: "rejected",
      fail: (f: ReturnType<typeof fixture>) =>
        f.methods.createProvider.mockResolvedValue({
          ok: false,
          error: { kind: "command", reason: "failed", message: "create unavailable" },
        }),
    },
    {
      outcome: "collision",
      expected: "rejected",
      fail: (f: ReturnType<typeof fixture>) => f.setup(),
    },
  ])("removes hydrated credentials after $outcome (#13863)", async ({ fail, expected }) => {
    const f = fixture();
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", undefined);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    await fail(f);
    const result = await prepareSwitchyardProviders({
      ...f.input,
      readCredential: (key) => {
        const value = `test-secret-${key}`;
        saveCredential(key, value);
        return value;
      },
    }).then(
      () => "fulfilled",
      () => "rejected",
    );
    expect(result).toBe(expected);
    expect(process.env.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("removes staged credentials when a later credential read throws (#13863)", async () => {
    const f = fixture();
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", undefined);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    const failure = new Error("credential resolver failed");
    const readCredential = vi
      .fn<(key: string) => string>()
      .mockImplementationOnce((key) => {
        saveCredential(key, "test-staged-secret");
        return "test-staged-secret";
      })
      .mockImplementationOnce(() => {
        throw failure;
      });

    await expect(prepareSwitchyardProviders({ ...f.input, readCredential })).rejects.toBe(failure);
    expect(process.env.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(f.methods.createProvider).not.toHaveBeenCalled();
  });

  it("preserves preexisting credential values after hydration (#13863)", async () => {
    const f = fixture();
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "test-existing-efficient");
    vi.stubEnv("OPENAI_API_KEY", "test-existing-capable");
    await prepareSwitchyardProviders({
      ...f.input,
      readCredential: (key) => {
        saveCredential(key, "test-temporary-value");
        return "test-temporary-value";
      },
    });
    expect(process.env.NVIDIA_INFERENCE_API_KEY).toBe("test-existing-efficient");
    expect(process.env.OPENAI_API_KEY).toBe("test-existing-capable");
  });

  it("rejects a stale lifecycle generation before creating providers (#13863)", async () => {
    const f = fixture();
    const updateSandbox = vi.fn(() => true);
    const input = setupInput(f, updateSandbox);
    const expected = {
      name: f.input.sandboxName,
      gatewayName: f.input.gatewayName,
      lifecycleGeneration: "original",
      lifecycleLiveIdentityFingerprint: "original",
    };
    input.options.revalidateSandboxIdentity = createRegisteredSandboxIdentityRevalidation(
      expected,
      {
        readRegistration: () => ({ ...expected, lifecycleGeneration: "replacement" }),
        observe: () => ({ state: "ready", liveIdentityFingerprint: "original" }),
      },
    );

    await expect(setupSwitchyardInference(input)).rejects.toThrow("registered identity");
    expect(f.methods.createProvider).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(input.environment).not.toHaveProperty(HERMES_SWITCHYARD_BINDINGS_ENV);
  });

  it("rejects recorded bindings before entering lifecycle or provider work (#13863)", async () => {
    const f = fixture();
    const { bindings } = await f.setup();
    f.methods.createProvider.mockClear();
    const updateSandbox = vi.fn(() => true);
    const input = setupInput(f, updateSandbox, () => ({
      name: f.input.sandboxName,
      gatewayName: f.input.gatewayName,
      provider: routing.capable.provider,
      model: routing.capable.model,
      hermesSwitchyard: { routing, bindings },
    }));
    input.options.revalidateSandboxIdentity = vi.fn(() => {
      throw new Error("must not enter unsupported provider reuse");
    });

    await expect(setupSwitchyardInference(input)).rejects.toThrow("fresh sandbox");
    expect(input.options.revalidateSandboxIdentity).not.toHaveBeenCalled();
    expect(f.providers.size).toBe(2);
    expect(f.methods.createProvider).not.toHaveBeenCalled();
    expect(f.methods.deleteProvider).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(input.environment).not.toHaveProperty(HERMES_SWITCHYARD_BINDINGS_ENV);
  });

  it.each([
    { change: "registered generation", generation: "replacement", fingerprint: "original" },
    { change: "live identity", generation: "original", fingerprint: "replacement" },
  ])(
    "rejects changed $change after provider creation (#13863)",
    async ({ generation, fingerprint }) => {
      const f = fixture();
      const updateSandbox = vi.fn(() => true);
      const input = setupInput(f, updateSandbox);
      const expected = {
        name: f.input.sandboxName,
        gatewayName: f.input.gatewayName,
        lifecycleGeneration: "original",
        lifecycleLiveIdentityFingerprint: "original",
      };
      let recorded = expected;
      let live = "original";
      input.options.revalidateSandboxIdentity = createRegisteredSandboxIdentityRevalidation(
        expected,
        {
          readRegistration: () => recorded,
          observe: () => ({ state: "ready", liveIdentityFingerprint: live }),
        },
      );
      const create = f.methods.createProvider.getMockImplementation()!;
      f.methods.createProvider.mockImplementation(async (...args) => {
        const result = await create(...args);
        recorded = { ...expected, lifecycleGeneration: generation };
        live = fingerprint;
        return result;
      });

      await expect(setupSwitchyardInference(input)).rejects.toThrow("identity");
      expect(f.providers.size).toBe(0);
      expect(f.methods.deleteProvider).toHaveBeenCalledTimes(2);
      expect(updateSandbox).not.toHaveBeenCalled();
      expect(input.environment).not.toHaveProperty(HERMES_SWITCHYARD_BINDINGS_ENV);
    },
  );

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
    `openshell:resolve:env:s${"a".repeat(64)}_OPENAI_API_KEY`,
  ])(
    "rejects root-supplied provider credentials and handles without printing them (#13863)",
    async (value) => {
      const f = fixture();
      const { bindings } = await f.setup();
      expect(() => assertSwitchyardRootApplyEnvironment({}, { routing, bindings })).not.toThrow();
      const failure = (() => {
        try {
          assertSwitchyardRootApplyEnvironment({ OPENAI_API_KEY: value }, { routing, bindings });
        } catch (error) {
          return error;
        }
      })();
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("must not supply provider credentials");
      expect((failure as Error).message).not.toContain(value);
    },
  );

  it("rejects an empty root-supplied provider credential (#13863)", async () => {
    const f = fixture();
    const { bindings } = await f.setup();
    expect(() =>
      assertSwitchyardRootApplyEnvironment({ OPENAI_API_KEY: "" }, { routing, bindings }),
    ).toThrow("must not supply provider credentials");
  });
});
