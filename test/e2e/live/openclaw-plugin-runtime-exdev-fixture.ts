// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const RELEASE_BASELINE_TEST_SELECTOR = "release-baseline";
export const CURRENT_LIFECYCLE_TEST_SELECTOR = "current-lifecycle";
export const RELEASE_SANDBOX_BASE_IMAGE_REF = "ghcr.io/nvidia/nemoclaw/sandbox-base:v0.0.71";

export type OpenClawPluginRuntimeExdevSelector =
  | typeof RELEASE_BASELINE_TEST_SELECTOR
  | typeof CURRENT_LIFECYCLE_TEST_SELECTOR;

export type OpenClawPluginRuntimeExdevFixture = {
  selector: OpenClawPluginRuntimeExdevSelector;
  source: "release" | "current";
  baseImageEnv: NodeJS.ProcessEnv;
};

export function resolveOpenClawPluginRuntimeExdevFixture(
  selector: OpenClawPluginRuntimeExdevSelector,
): OpenClawPluginRuntimeExdevFixture {
  if (selector === RELEASE_BASELINE_TEST_SELECTOR) {
    return {
      selector,
      source: "release",
      baseImageEnv: {
        NEMOCLAW_SANDBOX_BASE_IMAGE_REF: RELEASE_SANDBOX_BASE_IMAGE_REF,
      },
    };
  }
  return {
    selector,
    source: "current",
    baseImageEnv: {},
  };
}
