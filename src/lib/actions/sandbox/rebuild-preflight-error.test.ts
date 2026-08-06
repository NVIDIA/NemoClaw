// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { printRebuildPreflightFailure } from "./rebuild-preflight-error";

describe("printRebuildPreflightFailure (#7794)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("outputs 'Aborting rebuild' and calls bail with the bail message", () => {
    const bail = vi.fn() as unknown as (message: string, code?: number) => never;

    printRebuildPreflightFailure("policy apply failed.", "Check network.", "policy error", bail);

    const output = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");
    expect(output).toMatch(/Aborting rebuild/i);
    expect(output).toContain("sandbox is untouched, no data was lost.");
    expect(bail).toHaveBeenCalledWith("policy error");
  });

  it("includes the summary and detail in output", () => {
    const bail = vi.fn() as unknown as (message: string, code?: number) => never;

    printRebuildPreflightFailure("something broke.", "Try again.", "broke", bail);

    const output = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");
    expect(output).toContain("something broke.");
    expect(output).toContain("Try again.");
  });

  it("preserves an explicit bail exit code", () => {
    const bail = vi.fn() as unknown as (message: string, code?: number) => never;

    printRebuildPreflightFailure(
      "policy restore is pending.",
      "Repair the pending transition.",
      "pending policy transition",
      bail,
      1,
    );

    expect(bail).toHaveBeenCalledWith("pending policy transition", 1);
  });
});
