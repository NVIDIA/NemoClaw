// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { deleteUninstallProviders } from "./runtime-commands";

describe("uninstall provider commands", () => {
  it("keeps the uninstall environment and reports a failed deletion without retrying it", async () => {
    const env = { HOME: "/home/uninstall", OPENSHELL_GATEWAY: "owned-gateway" };
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: null, stdout: "", stderr: "connection reset" });
    const log = vi.fn();
    const warn = vi.fn();

    await deleteUninstallProviders(["nvidia-nim", "ollama-local"], { env, run, log, warn });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(
      1,
      "openshell",
      ["provider", "delete", "nvidia-nim"],
      expect.objectContaining({ env }),
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      "openshell",
      ["provider", "delete", "ollama-local"],
      expect.objectContaining({ env }),
    );
    expect(log).toHaveBeenCalledExactlyOnceWith("Deleted provider 'nvidia-nim'");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("ollama-local");
  });
});
