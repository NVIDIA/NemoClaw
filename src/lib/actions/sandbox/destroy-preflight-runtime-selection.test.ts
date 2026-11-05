// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";
import { resolveSandboxDestroyGatewayName } from "./destroy-preflight";

describe("destroy preflight runtime selection", () => {
  it("refuses conflicting pending-create and registry gateway authority", () => {
    const sandbox = {
      name: "alpha",
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
      pendingCreateIdentity: {
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      },
    } as Parameters<typeof resolveSandboxDestroyGatewayName>[1];

    expect(() => resolveSandboxDestroyGatewayName("alpha", sandbox)).toThrow(
      /pending create gateway 'nemoclaw' does not match registered gateway 'nemoclaw-19080'/u,
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
  });
  it("rejects an endpoint override before OpenShell probes or deletion", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://foreign.invalid");
    const harness = createDestroyHarness();

    await expect(harness.prepareSandboxDestroy("alpha")).rejects.toThrow(
      "OpenShell may bypass the gateway recorded for this sandbox",
    );
    expect(harness.captureOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
  });
  it("binds typed selection and inventory to the operation's frozen authority", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "foreign");
    vi.stubEnv("OPENSHELL_WORKSPACE", "foreign");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://foreign.invalid");
    const runtimeSelection = {
      gatewayName: "nemoclaw-19080",
      workspace: "default",
      localTlsDir: "/authority/tls",
    };
    const harness = createDestroyHarness();
    const preflight = await harness.prepareSandboxDestroy("alpha", {
      operationRuntimeSelection: runtimeSelection,
    });
    expect(preflight.runtimeSelection).toEqual(runtimeSelection);
    const frozenOptions = {
      replaceEnv: true,
      env: expect.objectContaining({
        OPENSHELL_GATEWAY: "nemoclaw-19080",
        OPENSHELL_WORKSPACE: "default",
        OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
      }),
    };
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["gateway", "select", "nemoclaw-19080"],
      expect.anything(),
    );
    expect(process.env.OPENSHELL_GATEWAY).toBe("foreign");
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "list", "-g", "nemoclaw-19080", "-o", "json"],
      expect.objectContaining(frozenOptions),
    );
    const selectionOptions = harness.runOpenshellSpy.mock.lastCall?.[1] as {
      env: NodeJS.ProcessEnv;
    };
    expect(selectionOptions.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
  }, 30_000);

  it("keeps destroy commands gateway-scoped across ambient gateway changes", async () => {
    const harness = createDestroyHarness();
    const preflight = await harness.prepareSandboxDestroy("alpha");
    harness.runOpenshellSpy.mockClear();

    // Model another NemoClaw operation changing the process-wide selection
    // after destroy preflight. Destroy's sandbox and provider commands must
    // still name their recorded gateway explicitly.
    vi.stubEnv("OPENSHELL_GATEWAY", "gateway-other");
    expect(() => preflight.selectedRunOpenshell(["status"])).toThrow(
      /Refusing to run unscoped OpenShell destroy command/u,
    );
    preflight.selectedRunOpenshell(["sandbox", "exec", "--name", "alpha", "--", "true"]);
    preflight.selectedRunOpenshell(["sandbox", "provider", "detach", "alpha", "github"]);
    preflight.selectedCaptureOpenshell?.(["sandbox", "list"]);

    expect(harness.runOpenshellSpy.mock.calls.map(([args]) => args)).toEqual([
      ["sandbox", "exec", "-g", "nemoclaw-19080", "--name", "alpha", "--", "true"],
      ["sandbox", "provider", "detach", "-g", "nemoclaw-19080", "alpha", "github"],
    ]);
    expect(harness.captureOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "list", "-g", "nemoclaw-19080"],
      expect.any(Object),
    );
  }, 30_000);
});
