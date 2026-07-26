// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type VitestFeedback = {
  isCi: boolean;
  silent: false | "passed-only";
};

export function resolveVitestFeedback(
  environment: NodeJS.ProcessEnv = process.env,
): VitestFeedback {
  const isCi =
    environment.GITHUB_ACTIONS === "true" || environment.CI === "true" || environment.CI === "1";
  return { isCi, silent: isCi ? "passed-only" : false };
}
