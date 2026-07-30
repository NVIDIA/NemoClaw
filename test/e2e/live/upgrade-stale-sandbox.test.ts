// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// @retired-selector-compatibility-entrypoint upgrade-stale-sandbox
// Trusted main can still invoke this path while the candidate removes its
// legacy job graph. Exercise the retained canonical rebuild test during that
// rollout window instead of restoring the retired coverage.
import { prepareRetiredRebuildSelectorCompatibility } from "./retired-rebuild-selector-compatibility.ts";

if (process.env.NEMOCLAW_E2E_PHASE_COLLECTION !== "1") {
  prepareRetiredRebuildSelectorCompatibility("upgrade-stale-sandbox");
  await import("./rebuild-openclaw.test.ts");
}
