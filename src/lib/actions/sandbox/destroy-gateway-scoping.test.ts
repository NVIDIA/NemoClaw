// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";

describe("destroy gateway scoping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
  });

  it("does not mutate active gateway state and scopes its preflight probe", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "gateway-foreign");
    const harness = createDestroyHarness();

    await harness.prepareSandboxDestroy("alpha");

    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "list", "-g", "nemoclaw-19080", "-o", "json"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["gateway", "select", "nemoclaw-19080"],
      expect.anything(),
    );
    expect(process.env.OPENSHELL_GATEWAY).toBe("gateway-foreign");
  }, 30_000);
});
