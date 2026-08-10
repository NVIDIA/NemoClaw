// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CuaRuntimeReadiness } from "../cua/contract";

const originalHome = process.env.HOME;
const originalCuaEnabled = process.env.NEMOCLAW_CUA_ENABLED;
const originalCuaQualification = process.env.NEMOCLAW_CUA_QUALIFICATION;
const temporaryHomes: string[] = [];
const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function readiness(): CuaRuntimeReadiness {
  const component = (name: string, character: string) => ({
    name,
    version: "1.0.0",
    digest: digest(character),
    owner: "NVIDIA",
  });
  return {
    schemaVersion: "1.0.0",
    kind: "runtime-readiness",
    agent: "nemocua",
    mode: "standalone",
    status: "candidate",
    sourceRevision: "a".repeat(40),
    sourceClean: true,
    runtimeManifestDigest: digest("b"),
    providerAuthorityDigest: digest("c"),
    qualification: {
      state: "candidate",
      environmentDigest: digest("d"),
      bundleReceiptDigest: digest("e"),
    },
    components: {
      openshell: component("openshell", "1"),
      runtime: component("nemocua-runtime", "2"),
      sandboxImage: component("nemocua-sandbox", "3"),
      targetAdapter: component("target-adapter", "4"),
      policy: component("nemocua-policy", "5"),
      taskProtocol: component("task-protocol", "6"),
      securityVerifier: component("security-verifier", "7"),
    },
    inference: {
      provider: "nvidia",
      model: "nvidia/nvidia/nemotron-3-super-120b-a12b",
      routeDigest: digest("8"),
    },
    appliedPolicy: { revision: 2, digest: digest("9") },
    commands: { interactive: true, headless: true, version: true, smoke: true },
    limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
    requiredCapabilities: ["browser", "computer", "terminal"],
    targetOperations: [],
    securityOperations: [],
    taskOperations: [],
  };
}

async function loadRegistry(document: unknown = { defaultSandbox: null, sandboxes: {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-registry-cua-readiness-"));
  temporaryHomes.push(home);
  const configDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "sandboxes.json"), JSON.stringify(document), {
    mode: 0o600,
  });
  process.env.HOME = home;
  process.env.NEMOCLAW_CUA_ENABLED = "1";
  process.env.NEMOCLAW_CUA_QUALIFICATION = "1";
  vi.resetModules();
  return import("./registry");
}

afterEach(() => {
  process.env.HOME = originalHome;
  originalCuaEnabled === undefined
    ? delete process.env.NEMOCLAW_CUA_ENABLED
    : (process.env.NEMOCLAW_CUA_ENABLED = originalCuaEnabled);
  originalCuaQualification === undefined
    ? delete process.env.NEMOCLAW_CUA_QUALIFICATION
    : (process.env.NEMOCLAW_CUA_QUALIFICATION = originalCuaQualification);
  vi.resetModules();
  for (const home of temporaryHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("CUA candidate readiness persistence (#7755)", () => {
  it("accepts readiness only through the whole-record onboarding write", async () => {
    const registry = await loadRegistry();
    registry.registerSandbox({
      name: "alpha",
      agent: "nemocua",
      provider: "nvidia",
      model: "nvidia/nvidia/nemotron-3-super-120b-a12b",
      policies: ["managed-inference"],
      cuaRuntimeReadiness: readiness(),
    });
    registry.registerSandbox({ name: "beta", agent: "openclaw", model: "unchanged" });

    expect(registry.getSandbox("alpha")?.cuaRuntimeReadiness).toBeUndefined();
    expect(registry.updateSandbox("alpha", { cuaRuntimeReadiness: readiness() })).toBe(false);
    expect(
      registry.recordCuaRuntimeReadiness("alpha", readiness(), registry.getSandbox("alpha")!),
    ).toBe(true);

    expect(registry.getSandbox("alpha")).toMatchObject({
      name: "alpha",
      agent: "nemocua",
      policies: ["managed-inference"],
      cuaRuntimeReadiness: readiness(),
    });
    expect(registry.getSandbox("beta")).toMatchObject({
      name: "beta",
      agent: "openclaw",
      model: "unchanged",
    });
  });

  it.each([
    ["provider", "other-provider"],
    ["model", "nvidia/other-model"],
    ["endpointUrl", "https://inference.example.test/v1"],
  ] as const)("invalidates readiness when inference %s changes", async (field, value) => {
    const registry = await loadRegistry();
    registry.registerSandbox({
      name: "alpha",
      agent: "nemocua",
      provider: "nvidia",
      model: "nvidia/nvidia/nemotron-3-super-120b-a12b",
    });
    registry.recordCuaRuntimeReadiness("alpha", readiness(), registry.getSandbox("alpha")!);

    expect(registry.updateSandbox("alpha", { [field]: value })).toBe(true);

    expect(registry.getSandbox("alpha")?.cuaRuntimeReadiness).toBeUndefined();
    expect(registry.getSandbox("alpha")?.[field]).toBe(value);
  });

  it("preserves readiness for unrelated and normalized-equivalent updates", async () => {
    const registry = await loadRegistry();
    registry.registerSandbox({
      name: "alpha",
      agent: "nemocua",
      provider: "nvidia",
      model: "nvidia/nvidia/nemotron-3-super-120b-a12b",
    });
    registry.recordCuaRuntimeReadiness("alpha", readiness(), registry.getSandbox("alpha")!);

    expect(
      registry.updateSandbox("alpha", {
        provider: " nvidia ",
        dashboardPort: 18080,
        cuaRuntimeReadiness: undefined,
      }),
    ).toBe(true);

    expect(registry.getSandbox("alpha")?.cuaRuntimeReadiness).toEqual(readiness());
    expect(registry.getSandbox("alpha")?.dashboardPort).toBe(18080);
  });

  it("invalidates readiness on every durable policy-authority mutation (#7755)", async () => {
    const registry = await loadRegistry();
    registry.registerSandbox({
      name: "alpha",
      agent: "nemocua",
      provider: "nvidia",
      model: "nvidia/nvidia/nemotron-3-super-120b-a12b",
      policies: ["managed-inference"],
    });
    registry.recordCuaRuntimeReadiness("alpha", readiness(), registry.getSandbox("alpha")!);

    expect(registry.updateSandbox("alpha", { policies: ["managed-inference"] })).toBe(true);

    expect(registry.getSandbox("alpha")?.cuaRuntimeReadiness).toBeUndefined();
    expect(registry.getSandbox("alpha")?.policies).toEqual(["managed-inference"]);

    registry.recordCuaRuntimeReadiness("alpha", readiness(), registry.getSandbox("alpha")!);
    expect(
      registry.addCustomPolicy("alpha", {
        name: "unsafe-extra",
        content: "network_policies:\n  unsafe-extra: {}\n",
        sourcePath: "/tmp/unsafe-extra.yaml",
      }),
    ).toBe(true);
    expect(registry.getSandbox("alpha")?.cuaRuntimeReadiness).toBeUndefined();

    registry.recordCuaRuntimeReadiness("alpha", readiness(), registry.getSandbox("alpha")!);
    expect(registry.removeCustomPolicyByName("alpha", "unsafe-extra")).toBe(true);
    expect(registry.getSandbox("alpha")?.cuaRuntimeReadiness).toBeUndefined();
  });

  it.each([
    ["agent", "openclaw"],
    ["imageTag", "replacement-image"],
    ["fromDockerfile", "/tmp/replacement/Dockerfile"],
    ["gatewayName", "replacement-gateway"],
    ["gatewayPort", 19999],
    ["openshellDriver", "replacement-driver"],
    ["openshellVersion", "9.9.9"],
    ["lifecycleGeneration", "generation-2"],
    ["lifecycleLiveIdentityFingerprint", "replacement-fingerprint"],
  ] as const)("invalidates readiness when runtime authority %s changes", async (field, value) => {
    const registry = await loadRegistry();
    registry.registerSandbox({
      name: "alpha",
      agent: "nemocua",
      provider: "nvidia",
      model: "nvidia/nvidia/nemotron-3-super-120b-a12b",
    });
    registry.recordCuaRuntimeReadiness("alpha", readiness(), registry.getSandbox("alpha")!);

    expect(registry.updateSandbox("alpha", { [field]: value })).toBe(true);
    expect(registry.getSandbox("alpha")?.cuaRuntimeReadiness).toBeUndefined();
    expect(registry.getSandbox("alpha")?.[field]).toBe(value);
  });

  it("does not establish readiness for an ordinary or pending row", async () => {
    const registry = await loadRegistry();
    registry.registerSandbox({ name: "ordinary", agent: "openclaw" });
    expect(
      registry.recordCuaRuntimeReadiness("ordinary", readiness(), registry.getSandbox("ordinary")!),
    ).toBe(false);

    registry.registerSandbox({ name: "pending", agent: "nemocua" });
    registry.updateSandbox("pending", { pendingRouteReservation: true });
    expect(
      registry.recordCuaRuntimeReadiness("pending", readiness(), registry.getSandbox("pending")!),
    ).toBe(false);
  });

  it("rejects a stale same-row readiness writer while preserving another sandbox", async () => {
    const registry = await loadRegistry();
    registry.registerSandbox({
      name: "alpha",
      agent: "nemocua",
      provider: "nvidia",
      model: "nvidia/nvidia/nemotron-3-super-120b-a12b",
      dashboardPort: 18080,
    });
    registry.registerSandbox({ name: "beta", agent: "openclaw", dashboardPort: 28080 });
    const staleAlpha = registry.getSandbox("alpha")!;

    expect(registry.updateSandbox("beta", { dashboardPort: 28081 })).toBe(true);
    expect(registry.updateSandbox("alpha", { dashboardPort: 18081 })).toBe(true);
    expect(registry.recordCuaRuntimeReadiness("alpha", readiness(), staleAlpha)).toBe(false);

    expect(registry.getSandbox("alpha")?.dashboardPort).toBe(18081);
    expect(registry.getSandbox("alpha")?.cuaRuntimeReadiness).toBeUndefined();
    expect(registry.getSandbox("beta")?.dashboardPort).toBe(28081);
  });

  it("invalidates readiness whenever a new route reservation starts", async () => {
    const registry = await loadRegistry();
    registry.registerSandbox({
      name: "alpha",
      agent: "nemocua",
      provider: "nvidia",
      model: "nvidia/nvidia/nemotron-3-super-120b-a12b",
    });
    registry.recordCuaRuntimeReadiness("alpha", readiness(), registry.getSandbox("alpha")!);

    expect(
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "nvidia",
        model: "nvidia/nvidia/nemotron-3-super-120b-a12b",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: "openai-completions",
        gatewayName: "nemoclaw-alpha",
      }),
    ).toBe(true);

    expect(registry.getSandbox("alpha")?.cuaRuntimeReadiness).toBeUndefined();
  });

  it.each([
    ["legacy", { ...readiness(), sourceClean: undefined }],
    ["malformed", { ...readiness(), repository: "https://private.invalid/source" }],
  ])("drops only %s readiness while preserving unrelated rows", async (_label, invalid) => {
    const registry = await loadRegistry({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: {
          name: "alpha",
          agent: "nemocua",
          provider: "nvidia",
          cuaRuntimeReadiness: invalid,
        },
        beta: { name: "beta", agent: "openclaw", model: "preserved" },
      },
    });

    expect(registry.getSandbox("alpha")).toMatchObject({
      name: "alpha",
      agent: "nemocua",
      provider: "nvidia",
    });
    expect(registry.getSandbox("alpha")?.cuaRuntimeReadiness).toBeUndefined();
    expect(registry.getSandbox("beta")).toEqual({
      name: "beta",
      agent: "openclaw",
      model: "preserved",
    });
  });

  it("does not restore readiness through generic recovery paths", async () => {
    const registry = await loadRegistry();
    registry.restoreSandboxEntry({ name: "alpha", cuaRuntimeReadiness: readiness() });
    expect(registry.getSandbox("alpha")?.cuaRuntimeReadiness).toBeUndefined();

    registry.registerSandbox({ name: "beta", agent: "nemocua" });
    registry.recordCuaRuntimeReadiness("beta", readiness(), registry.getSandbox("beta")!);
    const receipt = registry.removeSandboxWithReceipt("beta");
    expect(receipt).not.toBeNull();
    expect(registry.restoreSandboxEntryIfMissing(receipt!)).toBe(true);
    expect(registry.getSandbox("beta")?.cuaRuntimeReadiness).toBeUndefined();
  });

  it("clears readiness without erasing the sandbox row", async () => {
    const registry = await loadRegistry();
    registry.registerSandbox({ name: "alpha", agent: "nemocua", dashboardPort: 18080 });
    registry.recordCuaRuntimeReadiness("alpha", readiness(), registry.getSandbox("alpha")!);

    expect(registry.clearCuaRuntimeReadiness("alpha")).toBe(true);

    expect(registry.getSandbox("alpha")).toMatchObject({
      name: "alpha",
      agent: "nemocua",
      dashboardPort: 18080,
    });
    expect(registry.getSandbox("alpha")?.cuaRuntimeReadiness).toBeUndefined();
  });
});
