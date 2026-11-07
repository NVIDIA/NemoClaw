// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createInstalledMxcRuntimeProviderBundle } from "./mxc-installed";
import { createInstalledRuntimeSession, type InstalledRuntimeSession } from "./installed-session";
import { createRuntimeProviderBundleRegistry, requireRuntimeProviderBundle } from "./registry";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "./current";
import { resolveSandboxWorkloadRuntimeCapabilities } from "../workload/runtime";
import { resolveSandboxWorkloadSource } from "../workload/source";

const input = { installation: "owned-installation", runRoot: "owned-run" };

describe("installed runtime provider sessions", () => {
  it.each([
    ["arm64", "openclaw"],
    ["arm64", "hermes"],
    ["x64", "openclaw"],
    ["x64", "hermes"],
  ])("rejects portable workload selection on %s for %s", (architecture, agentName) => {
    const create = vi.fn(() => ({ providerId: "mxc" }) as InstalledRuntimeSession);
    const registry = createRuntimeProviderBundleRegistry([
      ["mxc", createInstalledMxcRuntimeProviderBundle(create)],
    ]);
    const runtime = resolveSandboxWorkloadRuntimeCapabilities(
      { driverName: "mxc" },
      registry,
      architecture,
    );
    expect(runtime.managedImages).toBeNull();
    expect(runtime.externalImages).toBeNull();
    expect(runtime.portableAgentRuntime).toBeNull();
    expect(runtime.legacyDockerfileBuilds).toBe(false);
    const options = {
      agentName,
      legacyDockerfilePath: "Dockerfile",
      runtime,
      catalog: {},
      candidateAgentsEnabled: true,
    };
    expect(() => resolveSandboxWorkloadSource(options)).toThrow(
      "does not advertise managed images",
    );
    expect(() => resolveSandboxWorkloadSource({ ...options, policy: "prefer-managed" })).toThrow();
    expect(() =>
      resolveSandboxWorkloadSource({ ...options, customDockerfilePath: "custom.Dockerfile" }),
    ).toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it("resolves the registered bundle without enabling portable MXC", () => {
    const session = { providerId: "mxc" } as InstalledRuntimeSession;
    const create = vi.fn(() => session);
    const registry = createRuntimeProviderBundleRegistry([
      ["mxc", createInstalledMxcRuntimeProviderBundle(create)],
    ]);
    const bundle = requireRuntimeProviderBundle("mxc", registry);
    expect(createInstalledRuntimeSession(bundle, input)).toBe(session);
    expect(create).toHaveBeenCalledExactlyOnceWith(input);
    expect(Object.isFrozen(bundle.gateway.installedSession)).toBe(true);
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES).not.toHaveProperty("mxc");
    expect(bundle.workload.acceptsReceipt(undefined)).toBe(false);
    expect(bundle.mutationAuthority.supported).toBe(false);
    expect(bundle.bootstrap.supported).toBe(false);
    expect(bundle.cleanup.supported).toBe(false);
    expect(bundle.containerEngine.supported).toBe(false);
  });

  it.each([
    undefined,
    { providerId: "mxc", supported: false as const, reason: "Not available." },
    { providerId: "other", supported: true as const, create: vi.fn() },
  ])("rejects an unavailable or foreign installed-session surface: %j", (surface) => {
    const create = vi.fn();
    const bundle = createInstalledMxcRuntimeProviderBundle(create);
    const candidate = { ...bundle, gateway: { ...bundle.gateway, installedSession: surface } };
    expect(() => createInstalledRuntimeSession(candidate, input)).toThrow(
      "no installed-session authority",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a session returned under another provider identity", () => {
    const create = vi.fn(() => ({ providerId: "other" }) as InstalledRuntimeSession);
    expect(() =>
      createInstalledRuntimeSession(createInstalledMxcRuntimeProviderBundle(create), input),
    ).toThrow("does not match its provider");
  });

  it.each([
    { providerId: "other", supported: true, create: vi.fn() },
    { providerId: "mxc", supported: true, create: null },
    { providerId: "mxc", supported: false, reason: "" },
  ])("rejects malformed installed-session registration: %j", (surface) => {
    const bundle = createInstalledMxcRuntimeProviderBundle(vi.fn());
    Object.assign(bundle.gateway, { installedSession: surface });
    expect(() => createRuntimeProviderBundleRegistry([["mxc", bundle]])).toThrow();
  });
});
