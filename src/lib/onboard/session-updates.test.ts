// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { filterSafeUpdates } from "../state/onboard-session";
import { toSessionUpdates } from "./session-updates";

describe("toSessionUpdates", () => {
  it("carries Station checkpoint proof to binding without persisting it", () => {
    const updates = toSessionUpdates({
      provider: "vllm-local",
      model: "nemotron-ultra",
      stationExpressModelIdentity: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
    });

    expect(updates.stationExpressModelIdentity).toBe(
      "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
    );
    expect(filterSafeUpdates(updates)).toEqual({
      provider: "vllm-local",
      model: "nemotron-ultra",
    });
  });
});
