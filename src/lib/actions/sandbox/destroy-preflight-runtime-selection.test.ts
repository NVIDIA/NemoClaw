// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";

describe("destroy preflight runtime selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
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
    const harness = createDestroyHarness({ callThroughGatewaySelection: true });
    const preflight = await harness.prepareSandboxDestroy("alpha", {
      operationRuntimeSelection: runtimeSelection,
    });
    expect(preflight.runtimeSelection).toEqual(runtimeSelection);
    expect(harness.selectGatewaySpy).toHaveBeenCalledWith(
      "alpha",
      "nemoclaw-19080",
      expect.anything(),
      runtimeSelection,
    );
    const frozenOptions = {
      replaceEnv: true,
      env: expect.objectContaining({
        OPENSHELL_GATEWAY: "nemoclaw-19080",
        OPENSHELL_WORKSPACE: "default",
        OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
      }),
    };
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["gateway", "select", "nemoclaw-19080"],
      expect.objectContaining(frozenOptions),
    );
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "list", "-o", "json"],
      expect.objectContaining(frozenOptions),
    );
    const selectionOptions = harness.runOpenshellSpy.mock.lastCall?.[1] as {
      env: NodeJS.ProcessEnv;
    };
    expect(selectionOptions.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
  }, 30_000);
});
