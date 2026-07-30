// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { allowGooglechatPresetAudienceForLiveE2e } from "./e2e-failure-injection";

const scopedEnv: NodeJS.ProcessEnv = {
  E2E_TARGET_ID: "channels-stop-start",
  NEMOCLAW_E2E_ALLOW_GOOGLECHAT_PRESET_AUDIENCE: "1",
  NEMOCLAW_RUN_LIVE_E2E: "1",
};

describe("Google Chat live E2E composition exception", () => {
  it("allows only the exact protected channel-lifecycle target and sandbox", () => {
    expect(
      allowGooglechatPresetAudienceForLiveE2e("e2e-channels-stop-start-openclaw", scopedEnv),
    ).toBe(true);
  });

  it.each([
    [{ ...scopedEnv, NEMOCLAW_RUN_LIVE_E2E: undefined }, "e2e-channels-stop-start-openclaw"],
    [
      { ...scopedEnv, NEMOCLAW_E2E_ALLOW_GOOGLECHAT_PRESET_AUDIENCE: undefined },
      "e2e-channels-stop-start-openclaw",
    ],
    [{ ...scopedEnv, E2E_TARGET_ID: "full-e2e" }, "e2e-channels-stop-start-openclaw"],
    [scopedEnv, "production-sandbox"],
    [scopedEnv, "e2e-channels-stop-start-openclaw-unsafe"],
  ])("rejects incomplete or incorrectly scoped harness state", (env, sandboxName) => {
    expect(allowGooglechatPresetAudienceForLiveE2e(sandboxName, env)).toBe(false);
  });
});
