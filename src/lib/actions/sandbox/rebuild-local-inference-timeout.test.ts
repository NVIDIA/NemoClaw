// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The local inference timeout range is enforced where a route carries the
// timeout. Rebuild's inner onboard resumes a recorded inference step, so rebuild
// preflight must not reject a value that the recreate never sends (#13734).

import { describe, expect, it, vi } from "vitest";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../../test/helpers/rebuild-flow-generic-harness";

describe("rebuild local inference timeout (#13734)", () => {
  installRebuildFlowTestHooks({ acceptThirdPartySoftware: true });

  it("does not stop rebuild preflight for a timeout above the route maximum", async () => {
    vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", "7200");
    const onboard = vi.fn();
    const harness = createRebuildFlowHarness({ sandboxEntry: {}, onboard });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(onboard).toHaveBeenCalledTimes(1);
  });
});
