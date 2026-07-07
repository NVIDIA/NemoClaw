// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { assessHost, checkContainerRuntimeResources } from "./preflight";

function colimaHost(cpus = 2, memoryGiB = 2) {
  return assessHost({
    platform: "darwin",
    env: {},
    dockerInfoOutput: JSON.stringify({
      ServerVersion: "27.4.0",
      OperatingSystem: "Colima",
      NCPU: cpus,
      MemTotal: memoryGiB * 1024 ** 3,
    }),
    commandExistsImpl: (name: string) => name === "docker",
  });
}

describe("checkContainerRuntimeResources", () => {
  it("aborts an interactive run when the user declines an undersized runtime", async () => {
    const confirm = vi.fn(async () => false);
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    const warn = vi.fn();
    const error = vi.fn();

    await expect(
      checkContainerRuntimeResources(colimaHost(), {
        ignored: false,
        nonInteractive: false,
        confirm,
        warn,
        error,
        exit,
      }),
    ).rejects.toThrow("exit:1");

    expect(confirm).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("⚠ Container runtime under-provisioned");
    expect(warn.mock.calls.flat().join("\n")).toContain("2 vCPU / 2.0 GiB");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Aborted by user"));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("warns but does not prompt in non-interactive mode", async () => {
    const confirm = vi.fn(async () => false);
    const warn = vi.fn();

    await checkContainerRuntimeResources(colimaHost(), {
      ignored: false,
      nonInteractive: true,
      confirm,
      warn,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join("\n")).toContain(
      "Non-interactive mode is continuing despite under-provisioned runtime",
    );
  });

  it("honors the ignore override while still reporting detected capacity", async () => {
    const confirm = vi.fn(async () => false);
    const log = vi.fn();

    await checkContainerRuntimeResources(colimaHost(), {
      ignored: true,
      nonInteractive: false,
      confirm,
      log,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("  ✓ Container runtime resources: 2 vCPU / 2.0 GiB");
  });
});
