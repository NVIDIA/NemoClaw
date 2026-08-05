// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  applyVllmInstallProbeDefaults,
  createVllmInstallSpies,
  inconclusiveModelStorage,
  mockSuccessfulVllmInstall,
  type VllmInstallMocks,
} from "./vllm-install.test-support";

function createInstallMocks(): VllmInstallMocks {
  return {
    dockerCapture: vi.fn(),
    dockerForceRm: vi.fn(),
    dockerImageInspectFormat: vi.fn(),
    dockerPullWithProgressWatchdog: vi.fn(),
    dockerRunDetached: vi.fn(),
    dockerSpawn: vi.fn(),
    dockerStop: vi.fn(),
    findUnwritableModelCachePath: vi.fn(),
    getGpuIndicesByName: vi.fn<(_pattern: RegExp) => number[]>(() => []),
    measureDirectorySizeBytes: vi.fn(),
    probeDockerStorage: vi.fn(),
    probeHostStorage: vi.fn(),
    runCapture: vi.fn(),
  };
}

describe("shared vLLM install setup", () => {
  it("gives each install setup its own ownership queue (#8351)", () => {
    const first = createInstallMocks();
    mockSuccessfulVllmInstall(first, "nemoclaw-vllm", [() => "first-row"]);

    expect(first.dockerCapture(["container"])).toBe("");
    expect(first.dockerCapture(["container"])).toBe("first-row");
    expect(first.dockerCapture(["container"])).toBe("");

    const second = createInstallMocks();
    mockSuccessfulVllmInstall(second, "nemoclaw-vllm", [() => "second-row"]);

    expect(second.dockerCapture(["container"])).toBe("");
    expect(second.dockerCapture(["container"])).toBe("second-row");
  });

  it("fails an install setup that inspects ambient ownership more than it queued (#8351)", () => {
    const mocks = createInstallMocks();
    mockSuccessfulVllmInstall(mocks, "nemoclaw-vllm", [() => ""]);

    mocks.dockerCapture(["container"]);
    mocks.dockerCapture(["container"]);
    mocks.dockerCapture(["container"]);

    expect(() => mocks.dockerCapture(["container"])).toThrow(
      "Unexpected extra ambient vLLM ownership inspection",
    );
  });

  it("returns fresh storage probe defaults for each invocation (#8351)", () => {
    const first = createInstallMocks();
    applyVllmInstallProbeDefaults(first);
    first.probeHostStorage().capacity.availableBytes = 0n;

    const second = createInstallMocks();
    applyVllmInstallProbeDefaults(second);

    expect(second.probeHostStorage().capacity.availableBytes).toBe(1_000_000_000_000n);
  });

  it("returns a distinct inconclusive model-storage result per call (#8351)", () => {
    const first = inconclusiveModelStorage();
    const second = inconclusiveModelStorage("statfs unavailable after image pull");

    expect(first).not.toBe(second);
    expect(first.reason).toBe("statfs unavailable");
    expect(second.reason).toBe("statfs unavailable after image pull");
  });

  it("restores every console and filesystem spy it installs (#8351)", () => {
    const originalLog = console.log;
    const originalError = console.error;
    const originalMkdir = fs.mkdirSync;
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;

    const spies = createVllmInstallSpies();
    expect(console.log).not.toBe(originalLog);

    spies.restore();

    expect(console.log).toBe(originalLog);
    expect(console.error).toBe(originalError);
    expect(fs.mkdirSync).toBe(originalMkdir);
    expect(process.stdout.write).toBe(originalStdoutWrite);
    expect(process.stderr.write).toBe(originalStderrWrite);
  });
});
