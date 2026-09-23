// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { collectN1xWslProduct } from "./n1x-wsl";

const PRODUCT_COMMAND = [
  "powershell.exe",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "(Get-CimInstance Win32_ComputerSystem).Model",
];

describe("N1x WSL product identity", () => {
  it("bounds the Windows product query and accepts RTX Spark N1X", () => {
    const runCaptureImpl = vi.fn(() => "RTX Spark N1X\r\n");

    expect(collectN1xWslProduct({ isWsl: true, runCaptureImpl })).toBe(true);
    expect(runCaptureImpl).toHaveBeenCalledWith(PRODUCT_COMMAND, {
      ignoreError: true,
      timeout: 10_000,
    });
  });

  it("rejects a different Windows product", () => {
    expect(collectN1xWslProduct({ isWsl: true, runCaptureImpl: () => "SKU 1\r\n" })).toBe(false);
  });

  it.each([
    ["empty product", ""],
    ["multiline product", "RTX Spark N1X\nforged"],
    ["oversized product", `RTX Spark N1X${"x".repeat(300)}`],
  ])("returns no identity for an %s result", (_scenario, value) => {
    expect(collectN1xWslProduct({ isWsl: true, runCaptureImpl: () => value })).toBeUndefined();
  });

  it("returns no identity when the Windows product query fails", () => {
    expect(
      collectN1xWslProduct({
        isWsl: true,
        runCaptureImpl: () => {
          throw new Error("unavailable");
        },
      }),
    ).toBeUndefined();
  });
});
