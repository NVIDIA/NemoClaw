// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawnSync: spawnSyncMock };
});

import { resolveCpuModel } from "./resources-cmd.js";

describe("resources-cmd lscpu adapter", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("reads Linux CPU models through the bounded lscpu adapter (#9403)", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ cpus: [{ modelname: "Cortex-X925" }] }),
    });

    expect(resolveCpuModel([{ model: "unknown" }], { platform: "linux" })).toBe("Cortex-X925");
    expect(spawnSyncMock).toHaveBeenCalledWith("lscpu", ["--json", "--extended=CPU,MODELNAME"], {
      encoding: "utf-8",
      timeout: 3000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  });
});
