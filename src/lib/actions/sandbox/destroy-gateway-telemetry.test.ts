// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";

describe("destroySandbox scoped gateway telemetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
  });

  it("keeps the ambient selection unchanged while targeting the recorded gateway", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "gateway-foreign");
    const harness = createDestroyHarness();

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: false }),
    ).resolves.toBeUndefined();

    expect(process.env.OPENSHELL_GATEWAY).toBe("gateway-foreign");
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "list", "-g", "nemoclaw-19080", "-o", "json"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["gateway", "select", "nemoclaw-19080"],
      expect.anything(),
    );
    expect(harness.recordDestroyCompletionSpy).toHaveBeenCalledWith(
      "alpha",
      "completed",
      undefined,
      "nemoclaw-19080",
    );
  }, 30_000);

  it("uses the registered gateway before confirming a destroy", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "gateway-foreign");
    const harness = createDestroyHarness({ promptResponses: ["n"] });

    await expect(harness.destroySandbox("alpha", {})).resolves.toBeUndefined();

    expect(harness.getActiveSandboxSessionsSpy).toHaveBeenCalledWith(
      "alpha",
      expect.any(Object),
      "nemoclaw-19080",
    );
    expect(harness.executeSandboxDestroySpy).not.toHaveBeenCalled();
  }, 30_000);
});
