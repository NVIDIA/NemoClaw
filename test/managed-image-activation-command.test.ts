// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { managedActivationOnboardArgs } from "./e2e/live/managed-image-activation-e2e-helpers";

describe("managed image activation command", () => {
  it("uses an exact stock catalog without enabling candidate activation", () => {
    expect(
      managedActivationOnboardArgs("/tmp/catalog.json", "openclaw", "managed-openclaw"),
    ).toEqual([
      "onboard",
      "--temp-managed-runtime-catalog",
      "/tmp/catalog.json",
      "--fresh",
      "--recreate-sandbox",
      "--non-interactive",
      "--yes",
      "--no-gpu",
      "--agent",
      "openclaw",
      "--name",
      "managed-openclaw",
    ]);
  });
});
