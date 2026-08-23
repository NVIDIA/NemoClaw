// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateNativePodmanSetupAction } from "../../../tools/e2e/workflow-boundary.mts";

describe("native Podman E2E setup boundary", () => {
  it("provides Podman authority without impersonating Docker", () => {
    expect(validateNativePodmanSetupAction()).toEqual([]);
  });
});
