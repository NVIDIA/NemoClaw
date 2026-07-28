// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CURRENT_LIFECYCLE_TEST_SELECTOR,
  RELEASE_BASELINE_TEST_SELECTOR,
  RELEASE_SANDBOX_BASE_IMAGE_REF,
  resolveOpenClawPluginRuntimeExdevFixture,
} from "../live/openclaw-plugin-runtime-exdev-fixture.ts";

describe("OpenClaw plugin runtime EXDEV fixture selection", () => {
  it("keeps the release baseline on its matching source and sandbox base image", () => {
    expect(resolveOpenClawPluginRuntimeExdevFixture(RELEASE_BASELINE_TEST_SELECTOR)).toEqual({
      selector: RELEASE_BASELINE_TEST_SELECTOR,
      source: "release",
      baseImageEnv: {
        NEMOCLAW_SANDBOX_BASE_IMAGE_REF: RELEASE_SANDBOX_BASE_IMAGE_REF,
      },
      openClawModulePath: "/usr/local/lib/node_modules/openclaw",
    });
  });

  it("uses checkout source with CLI-selected base-image resolution and the managed OpenClaw module path", () => {
    expect(resolveOpenClawPluginRuntimeExdevFixture(CURRENT_LIFECYCLE_TEST_SELECTOR)).toEqual({
      selector: CURRENT_LIFECYCLE_TEST_SELECTOR,
      source: "current",
      baseImageEnv: {},
      openClawModulePath: "/usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw",
    });
  });
});
