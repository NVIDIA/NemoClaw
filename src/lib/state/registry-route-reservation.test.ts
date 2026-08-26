// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializedHostLocalInferenceReceipt } from "../../../test/helpers/host-local-inference-receipt";
import type { InferenceSelection } from "../inference/selection";
import type { SandboxInferenceRouteReservationDisposition } from "./registry/route-reservation";

function ownedReservation(disposition: SandboxInferenceRouteReservationDisposition) {
  expect(disposition.kind).toBe("owned");
  return (disposition as Extract<typeof disposition, { kind: "owned" }>).reservation;
}

const EXACT_ROUTE_SELECTION = {
  provider: "ollama-local",
  model: "qwen3-vl:4b",
  endpointUrl: "http://127.0.0.1:11434/v1",
  endpointSource: null,
  credentialEnv: null,
  preferredInferenceApi: "openai-completions",
  compatibleEndpointReasoning: null,
  compatibleEndpointReasoningEffort: null,
  nimContainer: null,
} as const;

const EXACT_ROUTE_AUTHORITY = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw",
  sessionId: "session-owner",
  selection: EXACT_ROUTE_SELECTION,
} as const;

const EXACT_ROUTE_RESERVATION = {
  name: EXACT_ROUTE_AUTHORITY.sandboxName,
  gatewayName: EXACT_ROUTE_AUTHORITY.gatewayName,
  reservationSessionId: EXACT_ROUTE_AUTHORITY.sessionId,
  pendingRouteReservation: true as const,
  ...EXACT_ROUTE_SELECTION,
};

function createdSandboxRegistrationInput(
  sandboxName: string,
  gatewayName: string,
  inferenceSelection: InferenceSelection,
) {
  return {
    sandboxName,
    inferenceSelection,
    runtimeFields: {
      gpuEnabled: false,
      hostGpuDetected: false,
      sandboxGpuEnabled: false,
      sandboxGpuMode: "auto",
      sandboxGpuDevice: null,
      openshellDriver: "docker",
      openshellVersion: "0.1.2",
    },
    agent: null,
    agentVersionKnown: true,
    imageTag: null,
    workload: {
      schemaVersion: 1 as const,
      kind: "legacy-dockerfile" as const,
      reference: null,
      shared: false as const,
    },
    appliedPolicies: [],
    plannedMessagingState: undefined,
    hermesToolGateways: [],
    hermesDashboardState: { enabled: false, config: null },
    dashboardPort: 18789,
    gatewayName,
    gatewayPort: 8080,
  };
}

const EXACT_QUALIFIED_ROUTE_RESERVATION = {
  name: EXACT_ROUTE_AUTHORITY.sandboxName,
  gatewayName: EXACT_ROUTE_AUTHORITY.gatewayName,
  reservationSessionId: EXACT_ROUTE_AUTHORITY.sessionId,
  pendingRouteReservation: true as const,
  provider: EXACT_ROUTE_SELECTION.provider,
  model: EXACT_ROUTE_SELECTION.model,
  endpointUrl: EXACT_ROUTE_SELECTION.endpointUrl,
  endpointSource: EXACT_ROUTE_SELECTION.endpointSource,
  credentialEnv: EXACT_ROUTE_SELECTION.credentialEnv,
  preferredInferenceApi: EXACT_ROUTE_SELECTION.preferredInferenceApi,
};

function reserveQualifiedRoute(registry: typeof import("./registry")) {
  registry.reserveSandboxInferenceRoute(EXACT_ROUTE_AUTHORITY.sandboxName, {
    ...EXACT_ROUTE_SELECTION,
    gatewayName: EXACT_ROUTE_AUTHORITY.gatewayName,
    reservationSessionId: EXACT_ROUTE_AUTHORITY.sessionId,
  });
  return ownedReservation(
    registry.classifySandboxInferenceRouteReservation(
      EXACT_ROUTE_AUTHORITY,
      registry.getSandbox(EXACT_ROUTE_AUTHORITY.sandboxName),
    ),
  );
}

describe("sandbox inference route reservation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("persists a complete route without claiming the default sandbox", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");

      expect(
        registry.reserveSandboxInferenceRoute("alpha", {
          provider: "compatible-endpoint",
          model: "model-a",
          endpointUrl: "https://api.example.test/v1",
          credentialEnv: "CUSTOM_API_KEY",
          preferredInferenceApi: "openai-responses",
          gatewayName: "nemoclaw-9090",
        }),
      ).toBe(true);

      expect(registry.listSandboxes()).toMatchObject({
        defaultSandbox: null,
        sandboxes: [
          {
            name: "alpha",
            provider: "compatible-endpoint",
            model: "model-a",
            endpointUrl: "https://api.example.test/v1",
            credentialEnv: "CUSTOM_API_KEY",
            preferredInferenceApi: "openai-responses",
            gatewayName: "nemoclaw-9090",
          },
        ],
      });
      const reservation = registry.getSandbox("alpha");
      expect(reservation).not.toBeNull();
      const reservedEntry = reservation as NonNullable<typeof reservation>;
      expect(reservedEntry.createdAt).toBeUndefined();
      expect(registry.isRouteOnlySandboxReservation(reservedEntry)).toBe(true);
      expect(registry.getDefault()).toBeNull();
      expect(registry.setDefault("alpha")).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "fresh Model Router route",
      "model-router",
      "nvidia-router",
      "nvidia-routed",
      "http://host.openshell.internal:4000/v1",
      "NVIDIA_INFERENCE_API_KEY",
      false,
    ],
    [
      "fresh Amazon Bedrock adapter route",
      "bedrock",
      "compatible-anthropic-endpoint",
      "anthropic.claude-3-5-sonnet-20240620-v1:0",
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke",
      "COMPATIBLE_API_KEY",
      false,
    ],
    [
      "interrupted custom-endpoint resume",
      "resume",
      "compatible-endpoint",
      "test-model",
      "http://host.openshell.internal:19001/v1",
      "COMPATIBLE_API_KEY",
      true,
    ],
    [
      "missing-sandbox repair",
      "repair",
      "compatible-endpoint",
      "test-model",
      "http://host.openshell.internal:19002/v1",
      "COMPATIBLE_API_KEY",
      true,
    ],
  ] as const)(
    "stages %s from the durable route",
    async (_label, sandboxName, provider, model, endpointUrl, credentialEnv, existing) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-registration-"));
      vi.stubEnv("HOME", home);
      vi.resetModules();
      try {
        const registry = await import("./registry");
        const { registerCreatedSandbox } = await import("../onboard/sandbox-registration");
        const gatewayName = "nemoclaw";
        const sessionId = `session-${sandboxName}`;
        const reservedSelection = {
          provider,
          model,
          endpointUrl,
          endpointSource: null,
          credentialEnv,
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: null,
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
        } satisfies InferenceSelection;
        existing
          ? registry.registerSandbox({
              name: sandboxName,
              ...reservedSelection,
              agent: "openclaw",
              openshellDriver: "docker",
              gatewayName,
            })
          : undefined;
        registry.reserveSandboxInferenceRoute(sandboxName, {
          ...reservedSelection,
          gatewayName,
          reservationSessionId: sessionId,
        });
        const reconstructedSelection = {
          ...reservedSelection,
          endpointSource: "onboard" as const,
        };
        const routeKeys = [
          "provider",
          "model",
          "endpointUrl",
          "endpointSource",
          "credentialEnv",
          "preferredInferenceApi",
        ] as const;
        expect(
          routeKeys.filter(
            (key) => reconstructedSelection[key] !== reservedSelection[key],
          ),
        ).toEqual(["endpointSource"]);

        const registered = registerCreatedSandbox({
          ...createdSandboxRegistrationInput(sandboxName, gatewayName, reconstructedSelection),
          reservationSessionId: sessionId,
        });

        expect(registered).toMatchObject({
          ...reservedSelection,
          pendingRouteReservation: true,
          reservationSessionId: sessionId,
        });
        expect(registry.getDefault()).toBeNull();
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  );

  it("rejects creation registration from a foreign reservation session and preserves the pending row (#10214)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const { registerCreatedSandbox } = await import("../onboard/sandbox-registration");
      registry.reserveSandboxInferenceRoute("alpha", {
        ...EXACT_ROUTE_SELECTION,
        gatewayName: "nemoclaw",
        reservationSessionId: "session-owner",
      });
      const reserved = registry.getSandbox("alpha");
      expect(reserved).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      });

      expect(() =>
        registerCreatedSandbox({
          ...createdSandboxRegistrationInput("alpha", "nemoclaw", EXACT_ROUTE_SELECTION),
          reservationSessionId: "session-foreign",
        }),
      ).toThrow("Cannot stage a sandbox after its inference route reservation changed");
      expect(registry.getSandbox("alpha")).toEqual(reserved);
      expect(registry.getDefault()).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("retargets an existing row to the gateway protected by the reservation", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "nvidia-prod",
        model: "model-a",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      });

      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "anthropic-prod",
        model: "model-b",
        endpointUrl: null,
        credentialEnv: "ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
        gatewayName: "nemoclaw-9090",
      });

      const retargeted = registry.getSandbox("alpha");
      expect(retargeted).not.toBeNull();
      const retargetedEntry = retargeted as NonNullable<typeof retargeted>;
      expect(retargetedEntry).toMatchObject({
        gatewayName: "nemoclaw-9090",
        provider: "anthropic-prod",
        model: "model-b",
        pendingRouteReservation: true,
      });
      expect(retargetedEntry.createdAt).toEqual(expect.any(String));
      expect(retargetedEntry.gatewayPort).toBeUndefined();
      expect(registry.isRouteOnlySandboxReservation(retargetedEntry)).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("preserves the existing port when reserving a route on the same gateway", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "nvidia-prod",
        model: "model-a",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      });

      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-b",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        reservationSessionId: "session-owner",
      });

      expect(registry.getSandbox("alpha")).toMatchObject({
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("preserves an omitted host-local receipt through creation registration", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const { registerCreatedSandbox } = await import("../onboard/sandbox-registration");
      const receipt = serializedHostLocalInferenceReceipt("docker");
      const route = {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw-9090",
      } as const;

      registry.reserveSandboxInferenceRoute("alpha", {
        ...route,
        hostLocalInferenceReceipt: receipt,
      });
      registry.reserveSandboxInferenceRoute("alpha", { ...route, model: "model-b" });

      expect(registry.getSandbox("alpha")?.hostLocalInferenceReceipt).toBe(receipt);
      const entry = registerCreatedSandbox({
        sandboxName: "alpha",
        inferenceSelection: {
          provider: route.provider,
          model: "model-b",
          endpointUrl: route.endpointUrl,
          endpointSource: null,
          credentialEnv: route.credentialEnv,
          preferredInferenceApi: route.preferredInferenceApi,
          compatibleEndpointReasoning: null,
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
        },
        runtimeFields: {
          gpuEnabled: false,
          hostGpuDetected: false,
          sandboxGpuEnabled: false,
          sandboxGpuMode: "auto",
          sandboxGpuDevice: null,
          openshellDriver: "docker",
          openshellVersion: "0.1.2",
        },
        agent: null,
        agentVersionKnown: true,
        imageTag: null,
        workload: {
          schemaVersion: 1,
          kind: "legacy-dockerfile",
          reference: null,
          shared: false,
        },
        appliedPolicies: [],
        plannedMessagingState: undefined,
        hermesToolGateways: [],
        hermesDashboardState: { enabled: false, config: null },
        dashboardPort: 18789,
        gatewayName: route.gatewayName,
        gatewayPort: 9090,
      });

      expect(entry.hostLocalInferenceReceipt).toBe(receipt);
      expect(registry.getSandbox("alpha")?.hostLocalInferenceReceipt).toBe(receipt);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("removes a persisted host-local receipt when reserving a remote route", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const receipt = serializedHostLocalInferenceReceipt("docker");
      registry.registerSandbox({
        name: "alpha",
        provider: "ollama-local",
        model: "local-model",
        hostLocalInferenceReceipt: receipt,
      });

      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "remote-model",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "REMOTE_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        hostLocalInferenceReceipt: null,
      });

      expect(registry.getSandbox("alpha")).toMatchObject({
        provider: "compatible-endpoint",
        model: "remote-model",
        hostLocalInferenceReceipt: null,
      });
      vi.resetModules();
      const reloadedRegistry = await import("./registry");
      expect(reloadedRegistry.getSandbox("alpha")?.hostLocalInferenceReceipt).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("stamps the owning onboard session on the reservation (#6562)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw-9090",
        reservationSessionId: "session-owner",
      });

      expect(registry.getSandbox("alpha")).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("transfers reservation ownership when a new session retargets the route (#6562)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        reservationSessionId: "session-old",
      });

      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-b",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        reservationSessionId: "session-new",
      });

      const reserved = registry.getSandbox("alpha");
      expect(reserved).toMatchObject({
        model: "model-b",
        pendingRouteReservation: true,
        reservationSessionId: "session-new",
      });
      expect(registry.isPendingReservationForSession(reserved, "session-new")).toBe(true);
      expect(registry.isPendingReservationForSession(reserved, "session-old")).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("publishes a reused registered sandbox only for the owning onboarding session", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      });
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        reservationSessionId: "session-owner",
      });

      expect(registry.finalizeSandboxRouteReservation("alpha", "session-other")).toBe(false);
      expect(registry.getSandbox("alpha")).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      });
      expect(registry.getDefault()).toBeNull();

      expect(registry.finalizeSandboxRouteReservation("alpha", "session-owner")).toBe(true);
      expect(registry.getSandbox("alpha")).toEqual(
        expect.not.objectContaining({
          pendingRouteReservation: expect.anything(),
        }),
      );
      expect(registry.getSandbox("alpha")?.reservationSessionId).toBe("session-owner");
      expect(registry.getDefault()).toBe("alpha");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("keeps a created registration hidden until its owning sandbox step commits", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        reservationSessionId: "session-owner",
      });
      registry.registerSandbox(
        {
          name: "alpha",
          provider: "compatible-endpoint",
          model: "model-a",
          endpointUrl: "https://api.example.test/v1",
          credentialEnv: "CUSTOM_API_KEY",
          preferredInferenceApi: "openai-responses",
          compatibleEndpointReasoning: "true",
          compatibleEndpointReasoningEffort: "high",
          nimContainer: "managed-image",
          openshellDriver: "docker",
          gatewayName: "nemoclaw",
        },
        undefined,
        { pending: true, reservationSessionId: "session-owner" },
      );

      expect(registry.getSandbox("alpha")).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      });
      expect(registry.getDefault()).toBeNull();

      expect(registry.finalizeSandboxRouteReservation("alpha", "session-owner")).toBe(true);
      expect(registry.isPublishedSandboxRegistration(registry.getSandbox("alpha")!)).toBe(true);
      expect(registry.getDefault()).toBe("alpha");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("restores the recreated default when its owner publishes the registration", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      });
      registry.registerSandbox({
        name: "beta",
        provider: "compatible-endpoint",
        model: "model-b",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      });
      expect(registry.getDefault()).toBe("alpha");

      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        gatewayName: "nemoclaw",
        reservationSessionId: "session-owner",
      });
      registry.registerSandbox(
        {
          name: "alpha",
          provider: "compatible-endpoint",
          model: "model-a",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          openshellDriver: "docker",
          gatewayName: "nemoclaw",
        },
        undefined,
        { pending: true, reservationSessionId: "session-owner" },
      );

      expect(registry.setDefault("alpha")).toBe(false);
      expect(registry.getDefault()).toBe("beta");
      expect(registry.finalizeSandboxRouteReservation("alpha", "session-owner")).toBe(true);
      expect(registry.getDefault()).toBe("alpha");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["omits reservation authority", undefined],
    ["supplies an empty reservation owner", { pending: true as const, reservationSessionId: "" }],
    [
      "tries to publish through registration",
      { pending: false as const, reservationSessionId: "session-owner" },
    ],
  ])("rejects registration that %s for a session-owned row (#10214)", async (_case, options) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        reservationSessionId: "session-owner",
      });
      const entry = {
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      } as const;

      expect(() => registry.registerSandbox(entry, undefined, options)).toThrow(
        "Cannot stage a sandbox after its inference route reservation changed",
      );
      expect(registry.getSandbox("alpha")).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      });
      expect(registry.getDefault()).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("refuses generic pending-registration publication for a session-owned row", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        gatewayName: "nemoclaw",
        reservationSessionId: "session-owner",
      });
      registry.registerSandbox(
        {
          name: "alpha",
          provider: "compatible-endpoint",
          model: "model-a",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          openshellDriver: "docker",
          gatewayName: "nemoclaw",
        },
        undefined,
        { pending: true, reservationSessionId: "session-owner" },
      );

      expect(registry.finalizePendingSandboxRegistration("alpha")).toBe(false);
      expect(registry.getSandbox("alpha")).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      });
      expect(registry.getDefault()).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects an already-published sandbox without the same transaction receipt", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      });

      expect(registry.finalizeSandboxRouteReservation("alpha", "session-owner")).toBe(false);
      expect(registry.isPublishedSandboxRegistration(registry.getSandbox("alpha")!)).toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a stale session after another session publishes the same sandbox", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      });
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        reservationSessionId: "session-old",
      });
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        reservationSessionId: "session-new",
      });

      expect(registry.finalizeSandboxRouteReservation("alpha", "session-new")).toBe(true);
      expect(registry.finalizeSandboxRouteReservation("alpha", "session-new")).toBe(true);
      expect(registry.finalizeSandboxRouteReservation("alpha", "session-old")).toBe(false);
      expect(registry.getSandbox("alpha")).toMatchObject({
        reservationSessionId: "session-new",
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("does not transfer a published transaction receipt to an ownerless reservation", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      });
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        gatewayName: "nemoclaw",
        reservationSessionId: "session-owner",
      });
      expect(registry.finalizeSandboxRouteReservation("alpha", "session-owner")).toBe(true);

      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        gatewayName: "nemoclaw",
      });

      expect(registry.getSandbox("alpha")).toMatchObject({
        pendingRouteReservation: true,
      });
      expect(registry.getSandbox("alpha")?.reservationSessionId).toBeUndefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("atomically consumes only the exact qualified route reservation (#9203)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const qualified = reserveQualifiedRoute(registry);

      const registered = registry.registerSandbox(
        {
          name: "alpha",
          ...EXACT_ROUTE_SELECTION,
          agent: "hermes",
          openshellDriver: "docker",
          gatewayName: "nemoclaw",
        },
        qualified,
      );

      expect(registered).toMatchObject({
        name: "alpha",
        provider: "ollama-local",
        model: "qwen3-vl:4b",
        agent: "hermes",
      });
      expect(registered.pendingRouteReservation).toBeUndefined();
      expect(registry.getSandbox("alpha")).toEqual(registered);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("keeps an incomplete registration hidden until its caller commits it (#9733)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-pending-registration-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");

      const pending = registry.registerSandbox(
        {
          name: "clone",
          provider: "openai",
          model: "test-model",
          openshellDriver: "docker",
          gatewayName: "nemoclaw",
        },
        undefined,
        { pending: true },
      );

      expect(pending.pendingRouteReservation).toBe(true);
      expect(registry.isPublishedSandboxRegistration(pending)).toBe(false);
      expect(registry.getDefault()).toBeNull();

      expect(registry.finalizePendingSandboxRegistration("clone")).toBe(true);
      expect(registry.isPublishedSandboxRegistration(registry.getSandbox("clone")!)).toBe(true);
      expect(registry.getDefault()).toBe("clone");

      registry.registerSandbox({
        name: "later",
        provider: "openai",
        model: "test-model",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      });
      expect(registry.getDefault()).toBe("clone");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects route reservation replacement inside the registry lock (#9203)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const qualified = reserveQualifiedRoute(registry);
      registry.reserveSandboxInferenceRoute("alpha", {
        ...EXACT_ROUTE_SELECTION,
        model: "another-model",
        gatewayName: "nemoclaw",
        reservationSessionId: "another-session",
      });

      expect(() =>
        registry.registerSandbox(
          {
            name: "alpha",
            ...EXACT_ROUTE_SELECTION,
            agent: "hermes",
            openshellDriver: "docker",
            gatewayName: "nemoclaw",
          },
          qualified,
        ),
      ).toThrow("Cannot register a sandbox after its inference route reservation changed");
      expect(registry.getSandbox("alpha")).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "another-session",
        model: "another-model",
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("sandbox inference route reservation qualification (#9203)", () => {
  it.each([
    ["owned", EXACT_QUALIFIED_ROUTE_RESERVATION, "owned"],
    ["missing", null, "missing"],
    ["ownerless", { ...EXACT_ROUTE_RESERVATION, reservationSessionId: undefined }, "conflict"],
    [
      "foreign-session",
      { ...EXACT_ROUTE_RESERVATION, reservationSessionId: "another-session" },
      "conflict",
    ],
    ["mismatched-sandbox", { ...EXACT_ROUTE_RESERVATION, name: "beta" }, "conflict"],
    [
      "mismatched-gateway",
      { ...EXACT_ROUTE_RESERVATION, gatewayName: "other-gateway" },
      "conflict",
    ],
    ["mismatched-route", { ...EXACT_ROUTE_RESERVATION, model: "another-model" }, "conflict"],
    ["malformed", { ...EXACT_ROUTE_RESERVATION, gatewayPort: 0 }, "conflict"],
    [
      "completed",
      { ...EXACT_ROUTE_RESERVATION, createdAt: "2026-08-18T00:00:00.000Z" },
      "conflict",
    ],
    ["sandbox-authority", { ...EXACT_ROUTE_RESERVATION, agent: "hermes" }, "conflict"],
  ])("classifies %s reservation authority", async (_case, entry, expectedKind) => {
    const { classifySandboxInferenceRouteReservation } =
      await import("./registry/route-reservation");
    expect(classifySandboxInferenceRouteReservation(EXACT_ROUTE_AUTHORITY, entry).kind).toBe(
      expectedKind,
    );
  });

  it("admits bounded portable recreate carry metadata without sandbox authority (#10056)", async () => {
    const { classifySandboxInferenceRouteReservation } =
      await import("./registry/route-reservation");
    const disposition = classifySandboxInferenceRouteReservation(EXACT_ROUTE_AUTHORITY, {
      ...EXACT_QUALIFIED_ROUTE_RESERVATION,
      dashboardPort: 8080,
      policies: ["github"],
      policyPresetsFinalized: true,
      policyTier: "personal",
      webSearchEnabled: false,
      webSearchProvider: null,
    });

    expect(disposition.kind).toBe("owned");
  });

  it.each([
    ["invalid dashboard port", { dashboardPort: 0 }],
    ["duplicate policies", { policies: ["github", "github"] }],
    ["control character in a policy", { policies: ["github\u0000"] }],
    ["control character in the policy tier", { policyTier: "personal\u0000" }],
    ["non-boolean policy finalization", { policyPresetsFinalized: "yes" }],
    ["non-boolean web search state", { webSearchEnabled: "yes" }],
    ["unknown web search provider", { webSearchProvider: "unknown" }],
  ])("rejects %s in carried route metadata (#10056)", async (_case, updates) => {
    const { classifySandboxInferenceRouteReservation } =
      await import("./registry/route-reservation");
    const entry = {
      ...EXACT_QUALIFIED_ROUTE_RESERVATION,
      ...updates,
    } as Parameters<typeof classifySandboxInferenceRouteReservation>[1];

    expect(classifySandboxInferenceRouteReservation(EXACT_ROUTE_AUTHORITY, entry)).toMatchObject({
      kind: "conflict",
      detail: "the inference route reservation carry metadata is malformed",
    });
  });

  it.each([
    ["agent", { agent: "hermes" }],
    [
      "workload",
      { workload: { schemaVersion: 1, kind: "legacy-dockerfile", reference: null, shared: false } },
    ],
    ["lifecycle", { lifecycleGeneration: "11111111-1111-4111-8111-111111111111" }],
  ])(
    "still rejects %s sandbox authority on a carried reservation (#10056)",
    async (_case, updates) => {
      const { classifySandboxInferenceRouteReservation } =
        await import("./registry/route-reservation");
      const entry = {
        ...EXACT_QUALIFIED_ROUTE_RESERVATION,
        policies: ["github"],
        ...updates,
      } as Parameters<typeof classifySandboxInferenceRouteReservation>[1];

      expect(classifySandboxInferenceRouteReservation(EXACT_ROUTE_AUTHORITY, entry)).toMatchObject({
        kind: "conflict",
        detail: "the inference route reservation has sandbox authority",
      });
    },
  );
});

describe("pending reservation ownership (#6562)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps the reserving session's row but treats another session's as abandoned", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-ownership-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw-9090",
        reservationSessionId: "session-owner",
      });
      const reserved = registry.getSandbox("alpha");

      expect(registry.isPendingReservationForSession(reserved, "session-owner")).toBe(true);
      expect(registry.isPendingReservationForSession(reserved, "session-other")).toBe(false);
      expect(registry.isPendingReservationForSession(reserved, null)).toBe(false);
      expect(registry.isPendingReservationForSession(reserved, undefined)).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("never preserves a fully registered sandbox or a missing row (#6562)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-ownership-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "beta",
        provider: "nvidia-prod",
        model: "model-a",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      });

      expect(
        registry.isPendingReservationForSession(registry.getSandbox("beta"), "session-owner"),
      ).toBe(false);
      expect(registry.isPendingReservationForSession(null, "session-owner")).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
