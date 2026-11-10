// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { switchyardBindingFixture } from "../../../test/helpers/hermes-switchyard";
import { createHermesSwitchyardRoutingIntent } from "../hermes-switchyard-routing";
import { cloneSandboxWorkloadReceipt } from "./registry/workload";
import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  decodeManagedStartupProfile,
  encodeManagedStartupProfile,
  type ManagedStartupHermesConfig,
} from "../onboard/managed-startup/profile";
import { assertHermesSwitchyardRoutingReusable } from "../onboard/sandbox-reuse";
import type { SandboxEntry } from "./registry";

function legacyRoutedSandbox(
  options: { judge?: { provider: "nvidia-prod"; model: string }; bindings?: unknown } = {},
) {
  const routing = createHermesSwitchyardRoutingIntent({
    efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
    capable: { provider: "openai-api", model: "gpt-5" },
    ...(options.judge ? { judge: options.judge } : {}),
  });
  const profile = managedStartupE2eProfile("hermes");
  const encoded = encodeManagedStartupProfile({
    ...profile,
    agentConfig: {
      ...(profile.agentConfig as ManagedStartupHermesConfig),
      switchyardRouting: routing,
      switchyardBindings: switchyardBindingFixture(routing),
    },
  });
  const legacy = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
    agentConfig: ManagedStartupHermesConfig;
  };
  // JSON omits undefined bindings while retaining the encoder's canonical property order.
  Reflect.set(legacy.agentConfig, "switchyardBindings", options.bindings);
  const encodedProfile = Buffer.from(JSON.stringify(legacy)).toString("base64url");
  return {
    name: "legacy-routed",
    agent: "hermes",
    provider: routing.capable.provider,
    model: routing.capable.model,
    gatewayName: "test-gateway",
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
      startupProfileSha256: createHash("sha256").update(encodedProfile).digest("hex"),
      credentialProxyReplayRequired: true,
      shared: true,
    },
  } satisfies SandboxEntry;
}

it("preserves pre-binding routed receipts across registry reads and unrelated writes (#13863)", async () => {
  const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-switchyard-legacy-"));
  vi.stubEnv("HOME", testHome);
  vi.resetModules();
  try {
    const registry = await import("./registry");
    const persistence = await import("./registry/persistence");
    const legacy = legacyRoutedSandbox();
    persistence.save({ defaultSandbox: null, sandboxes: {} });
    await fs.writeFile(
      registry.REGISTRY_FILE,
      JSON.stringify({
        defaultSandbox: "ordinary",
        sandboxes: {
          [legacy.name]: legacy,
          ordinary: { name: "ordinary", agent: "openclaw", model: "original-model" },
        },
      }),
    );
    const before = await fs.readFile(registry.REGISTRY_FILE, "utf8");
    expect(registry.getSandbox(legacy.name)?.workload).toEqual(legacy.workload);
    expect(registry.getSandbox("ordinary")?.model).toBe("original-model");
    expect(await fs.readFile(registry.REGISTRY_FILE, "utf8")).toBe(before);
    registry.updateSandbox("ordinary", { model: "updated-model" });
    const stored = registry.getSandbox(legacy.name);
    expect(stored?.workload).toEqual(legacy.workload);
    expect(stored?.hermesSwitchyard).toBeUndefined();
    expect(registry.getSandbox("ordinary")?.model).toBe("updated-model");
    const workload = legacy.workload;
    expect(() => decodeManagedStartupProfile(workload.encodedProfile)).toThrow();
  } finally {
    await fs.rm(testHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

it.each(
  ["ready", "not_ready", "missing"].flatMap((sandboxState) =>
    ["hermes", "openclaw"].map((agentName) => ({ sandboxState, agentName })),
  ),
)(
  "rejects legacy routed $sandboxState reuse as $agentName without changing the receipt (#13863)",
  ({ sandboxState, agentName }) => {
    const entry = legacyRoutedSandbox();
    const before = structuredClone(entry);
    expect(() =>
      assertHermesSwitchyardRoutingReusable({
        agentName,
        entry,
        env: {},
        recreate: true,
        sandboxState,
      }),
    ).toThrow("onboard with a new sandbox name");
    expect(entry).toEqual(before);
  },
);

it.each([
  { name: "explicit null bindings", options: { bindings: null } },
  { name: "partial bindings", options: { bindings: { schemaVersion: 1 } } },
  {
    name: "unbound dedicated judge",
    options: { judge: { provider: "nvidia-prod" as const, model: "nvidia/judge" } },
  },
])("rejects $name instead of treating it as a legacy receipt (#13863)", ({ options }) => {
  const entry = legacyRoutedSandbox(options);
  const before = structuredClone(entry);
  expect(cloneSandboxWorkloadReceipt(entry.workload)).toBeUndefined();
  expect(entry).toEqual(before);
});

it("rejects noncanonical legacy payloads even when their receipt hash matches (#13863)", () => {
  const entry = legacyRoutedSandbox();
  const workload = entry.workload;
  const parsed: unknown = JSON.parse(Buffer.from(workload.encodedProfile, "base64url").toString());
  const encodedProfile = Buffer.from(JSON.stringify(parsed, null, 2)).toString("base64url");
  expect(
    cloneSandboxWorkloadReceipt({
      ...workload,
      encodedProfile,
      startupProfileSha256: createHash("sha256").update(encodedProfile).digest("hex"),
    }),
  ).toBeUndefined();
});

it.each([undefined, "openclaw"])(
  "rejects legacy routed reuse when registry agent metadata is %s (#13863)",
  (recordedAgent) => {
    const entry = { ...legacyRoutedSandbox(), agent: recordedAgent };
    const before = structuredClone(entry);
    expect(() =>
      assertHermesSwitchyardRoutingReusable({
        agentName: "openclaw",
        entry,
        env: {},
        recreate: true,
        sandboxState: "ready",
      }),
    ).toThrow("onboard with a new sandbox name");
    expect(entry).toEqual(before);
  },
);

it("preserves ordinary managed OpenClaw reuse without a Switchyard route (#13863)", () => {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile("openclaw"));
  const entry = {
    ...legacyRoutedSandbox(),
    agent: "openclaw",
    workload: {
      ...legacyRoutedSandbox().workload,
      reference: `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"1".repeat(64)}`,
      encodedProfile,
      startupProfileSha256: createHash("sha256").update(encodedProfile).digest("hex"),
    },
  };
  const before = structuredClone(entry);
  expect(() =>
    assertHermesSwitchyardRoutingReusable({
      agentName: "openclaw",
      entry,
      env: {},
      recreate: false,
      sandboxState: "ready",
    }),
  ).not.toThrow();
  expect(entry).toEqual(before);
});

it("retains binding observations across reservation reload and rejects malformed persisted roles (#13863)", async () => {
  const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-switchyard-registry-"));
  vi.stubEnv("HOME", testHome);
  vi.resetModules();
  try {
    const registry = await import("./registry");
    const routing = createHermesSwitchyardRoutingIntent({
      efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
      capable: { provider: "openai-api", model: "gpt-5" },
    });
    const bindings = switchyardBindingFixture(routing);
    const hermesSwitchyard = { routing, bindings };
    expect(
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: routing.capable.provider,
        model: routing.capable.model,
        endpointUrl: "https://api.openai.com/v1",
        endpointSource: "onboard",
        credentialEnv: "OPENAI_API_KEY",
        gatewayName: "test-gateway",
        preferredInferenceApi: "openai-completions",
        reservationSessionId: "test-session",
        hermesSwitchyard,
      }),
    ).toBe(true);
    expect(registry.getSandbox("alpha")?.hermesSwitchyard).toEqual(hermesSwitchyard);
    const pending = registry.getSandbox("alpha")!;
    const replacement = {
      routing,
      bindings: {
        ...bindings,
        providers: bindings.providers.map((provider, index) =>
          index === 0 ? { ...provider, resourceVersion: 2 } : provider,
        ),
      },
    };
    const beforeRegistration = await fs.readFile(registry.REGISTRY_FILE, "utf8");
    expect(() =>
      registry.registerSandbox({ ...pending, hermesSwitchyard: undefined }, undefined, {
        pending: true,
        reservationSessionId: "test-session",
      }),
    ).toThrow("recorded Switchyard provider bindings changed");
    expect(await fs.readFile(registry.REGISTRY_FILE, "utf8")).toBe(beforeRegistration);
    expect(() =>
      registry.registerSandbox({ ...pending, hermesSwitchyard: replacement }, undefined, {
        pending: true,
        reservationSessionId: "test-session",
      }),
    ).toThrow("recorded Switchyard provider bindings changed");
    expect(await fs.readFile(registry.REGISTRY_FILE, "utf8")).toBe(beforeRegistration);
    expect(
      registry.registerSandbox(pending, undefined, {
        pending: true,
        reservationSessionId: "test-session",
      }).hermesSwitchyard,
    ).toEqual(hermesSwitchyard);
    registry.registerSandbox({
      name: "registered",
      agent: "hermes",
      provider: routing.capable.provider,
      model: routing.capable.model,
      gatewayName: "test-gateway",
      hermesSwitchyard,
    });
    expect(registry.getSandbox("registered")?.hermesSwitchyard).toEqual(hermesSwitchyard);
    expect(() =>
      registry.registerSandbox({
        name: "invalid",
        provider: routing.capable.provider,
        model: routing.capable.model,
        hermesSwitchyard: {
          routing,
          bindings: { ...bindings, judge: { ...bindings.judge, model: "wrong-model" } },
        },
      }),
    ).toThrow("provider state");
  } finally {
    await fs.rm(testHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

it.each(["gpt-5", "another-model"])(
  "rejects a binding-free reservation for a routed sandbox selecting %s (#13863)",
  async (model) => {
    const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-switchyard-reservation-"));
    vi.stubEnv("HOME", testHome);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const routing = createHermesSwitchyardRoutingIntent({
        efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
        capable: { provider: "openai-api", model: "gpt-5" },
      });
      const route = {
        provider: routing.capable.provider,
        model: routing.capable.model,
        endpointUrl: "https://api.openai.com/v1",
        endpointSource: "onboard" as const,
        credentialEnv: "OPENAI_API_KEY",
        preferredInferenceApi: "openai-completions",
        gatewayName: "test-gateway",
      };
      registry.registerSandbox({
        name: "routed",
        agent: "hermes",
        ...route,
        hermesSwitchyard: { routing, bindings: switchyardBindingFixture(routing) },
      });
      const before = await fs.readFile(registry.REGISTRY_FILE, "utf8");
      expect(() =>
        registry.reserveSandboxInferenceRoute("routed", {
          ...route,
          model,
          reservationSessionId: "resume-session",
        }),
      ).toThrow("recorded Switchyard provider bindings");
      expect(await fs.readFile(registry.REGISTRY_FILE, "utf8")).toBe(before);
    } finally {
      await fs.rm(testHome, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
);

it.each(["load", "save"] as const)(
  "identifies the sandbox and preserves the cause when binding validation prevents %s (#13863)",
  async (operation) => {
    const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-switchyard-invalid-"));
    vi.stubEnv("HOME", testHome);
    vi.resetModules();
    try {
      const persistence = await import("./registry/persistence");
      const routing = createHermesSwitchyardRoutingIntent({
        efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
        capable: { provider: "openai-api", model: "gpt-5" },
      });
      const bindings = switchyardBindingFixture(routing);
      const data = {
        defaultSandbox: null,
        sandboxes: {
          routed: {
            name: "routed",
            hermesSwitchyard: {
              routing,
              bindings: { ...bindings, judge: { ...bindings.judge, model: "wrong-model" } },
            },
          },
        },
      };
      persistence.save({ defaultSandbox: null, sandboxes: {} });
      const attempts = {
        load: async () => {
          await fs.writeFile(persistence.REGISTRY_FILE, JSON.stringify(data));
          return () => persistence.load();
        },
        save: async () => () => persistence.save(data),
      };
      const attempt = await attempts[operation]();
      const before = await fs.readFile(persistence.REGISTRY_FILE, "utf8");
      const error = await Promise.resolve()
        .then(attempt)
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        message: expect.stringContaining(`Cannot ${operation} sandbox "routed"`),
        cause: expect.any(Error),
      });
      expect((error as Error).message).toContain(
        "Inspect and repair hermesSwitchyard before retrying",
      );
      expect(await fs.readFile(persistence.REGISTRY_FILE, "utf8")).toBe(before);
    } finally {
      await fs.rm(testHome, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
);
