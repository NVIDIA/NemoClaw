// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { focusedE2eJobsForChangedFiles } from "../../../tools/e2e/workflow-boundary.mts";

describe("messaging providers fixture routing", () => {
  it("selects the installed-runtime proof for fake WeChat API fixture changes (#10079)", () => {
    const fixture = "test/e2e/lib/fake-wechat-api.mts";

    expect(focusedE2eJobsForChangedFiles([fixture])).toEqual([
      { id: "messaging-providers", matchedFiles: [fixture] },
    ]);
  });
});
