// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildOpenClawPluginRuntimeExdevBaseImageEnv,
  CURRENT_LIFECYCLE_TEST_SELECTOR,
  RELEASE_BASELINE_TEST_SELECTOR,
  RELEASE_SANDBOX_BASE_IMAGE_REF,
} from "../live/openclaw-plugin-runtime-exdev-env.ts";

describe("OpenClaw plugin runtime EXDEV base image selection", () => {
  it("pins the release baseline to its matching sandbox base image", () => {
    expect(buildOpenClawPluginRuntimeExdevBaseImageEnv(RELEASE_BASELINE_TEST_SELECTOR)).toEqual({
      NEMOCLAW_SANDBOX_BASE_IMAGE_REF: RELEASE_SANDBOX_BASE_IMAGE_REF,
    });
  });

  it("does not override base-image resolution for the current-lifecycle test", () => {
    expect(buildOpenClawPluginRuntimeExdevBaseImageEnv(CURRENT_LIFECYCLE_TEST_SELECTOR)).toEqual(
      {},
    );
  });
});
