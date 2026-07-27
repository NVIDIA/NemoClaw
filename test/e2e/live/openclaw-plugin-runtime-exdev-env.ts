// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const RELEASE_BASELINE_TEST_SELECTOR = "release-baseline";
export const CURRENT_LIFECYCLE_TEST_SELECTOR = "current-lifecycle";
export const RELEASE_SANDBOX_BASE_IMAGE_REF = "ghcr.io/nvidia/nemoclaw/sandbox-base:v0.0.71";

export type OpenClawPluginRuntimeExdevSelector =
  | typeof RELEASE_BASELINE_TEST_SELECTOR
  | typeof CURRENT_LIFECYCLE_TEST_SELECTOR;

export function buildOpenClawPluginRuntimeExdevBaseImageEnv(
  selector: OpenClawPluginRuntimeExdevSelector,
): NodeJS.ProcessEnv {
  return selector === RELEASE_BASELINE_TEST_SELECTOR
    ? { NEMOCLAW_SANDBOX_BASE_IMAGE_REF: RELEASE_SANDBOX_BASE_IMAGE_REF }
    : {};
}
