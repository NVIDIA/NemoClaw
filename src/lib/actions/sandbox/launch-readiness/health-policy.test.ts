// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import { readLaunchReadinessLivePolicy } from "./health";

it("forwards typed policy capture options and the evidence buffer limit (#9805)", async () => {
  const document = "version: 1\nnetwork_policies: {}";
  const capture = vi.fn(() => ({
    status: 0,
    output: document,
    stdout: document,
    stderr: "",
  }));

  await expect(readLaunchReadinessLivePolicy("alpha", "nemoclaw-18080", { capture })).resolves.toBe(
    document,
  );
  expect(capture).toHaveBeenCalledWith(
    ["policy", "get", "-g", "nemoclaw-18080", "--full", "alpha"],
    {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      timeout: 15_000,
      maxBuffer: 2 * 1_024 * 1_024,
    },
  );
});
