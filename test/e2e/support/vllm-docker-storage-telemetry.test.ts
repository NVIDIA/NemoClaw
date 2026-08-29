// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readGpuMemoryDevices } from "../../../src/lib/inference/vllm.ts";
import { VLLM_DOCKER_STORAGE_NVIDIA_SMI_SOURCE } from "../fixtures/vllm-docker-storage-telemetry.ts";

let temporaryRoot = "";

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-storage-telemetry-"));
  const nvidiaSmiPath = path.join(temporaryRoot, "nvidia-smi");
  fs.writeFileSync(nvidiaSmiPath, VLLM_DOCKER_STORAGE_NVIDIA_SMI_SOURCE, { mode: 0o755 });
  vi.stubEnv("PATH", temporaryRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
});

describe("managed vLLM storage-gate telemetry fixture", () => {
  it("reports one valid GPU memory device before the cache-directory check (#10153)", () => {
    expect(readGpuMemoryDevices()).toEqual([
      {
        index: 0,
        uuid: expect.stringMatching(/^GPU-/u),
        totalBytes: 137_438_953_472n,
        freeBytes: 137_438_953_472n,
      },
    ]);
  });
});
