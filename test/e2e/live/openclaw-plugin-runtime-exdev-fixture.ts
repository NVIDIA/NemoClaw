// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const RELEASE_BASELINE_TEST_SELECTOR = "release-baseline";
export const CURRENT_LIFECYCLE_TEST_SELECTOR = "current-lifecycle";
export const RELEASE_SANDBOX_BASE_IMAGE_REF = "ghcr.io/nvidia/nemoclaw/sandbox-base:v0.0.71";
const RELEASE_OPENCLAW_MODULE_PATH = "/usr/local/lib/node_modules/openclaw";
const CURRENT_OPENCLAW_MODULE_PATH =
  "/usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw";

export type OpenClawPluginRuntimeExdevSelector =
  | typeof RELEASE_BASELINE_TEST_SELECTOR
  | typeof CURRENT_LIFECYCLE_TEST_SELECTOR;

export type OpenClawPluginRuntimeExdevFixture = {
  selector: OpenClawPluginRuntimeExdevSelector;
  source: "release" | "current";
  baseImageEnv: NodeJS.ProcessEnv;
  openClawModulePath: typeof RELEASE_OPENCLAW_MODULE_PATH | typeof CURRENT_OPENCLAW_MODULE_PATH;
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
      openClawModulePath: RELEASE_OPENCLAW_MODULE_PATH,
    };
  }
  return {
    selector,
    source: "current",
    baseImageEnv: {},
    openClawModulePath: CURRENT_OPENCLAW_MODULE_PATH,
  };
}
