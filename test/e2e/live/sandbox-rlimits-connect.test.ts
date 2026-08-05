// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeE2eSelectorId } from "../../../tools/e2e/selector-aliases.mts";
import { expect, test } from "../fixtures/e2e-test.ts";

// PR E2E runs the trusted base workflow, which can still invoke this candidate path during job
// removal. This bridge verifies selector compatibility, not live resource limits. Delete it after
// the trusted workflow no longer references the old job.
test("the retired sandbox resource-limit selector resolves to sandbox operations", {
  meta: {
    e2ePhases: [
      "resolve the retired sandbox resource-limit selector",
      "record the sandbox operations replacement",
    ],
  },
}, ({ progress }) => {
  progress.phase("resolve the retired sandbox resource-limit selector");
  expect(normalizeE2eSelectorId("sandbox-rlimits-connect")).toBe("sandbox-operations");
  progress.phase("record the sandbox operations replacement");
});
