// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { printMcpRebuildRetryCommand } from "./rebuild-mcp-phase";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP rebuild retry guidance", () => {
  it.each([
    [true, "--observability"],
    [false, "--no-observability"],
  ])("preserves an explicit observability=%s override", (enabled, expectedFlag) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    printMcpRebuildRetryCommand("alpha", [{} as never], "progressive", {
      enabled,
      requestedExplicitly: true,
    });

    const output = error.mock.calls.flat().join("\n");
    expect(output).toContain(
      `nemoclaw alpha rebuild --yes --tool-disclosure progressive ${expectedFlag}`,
    );
  });

  it("preserves an explicit opt-out on the resume retry form", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    printMcpRebuildRetryCommand("alpha", [], "direct", {
      enabled: false,
      requestedExplicitly: true,
    });

    expect(error.mock.calls.flat().join("\n")).toContain(
      "nemoclaw onboard --resume --tool-disclosure direct --no-observability",
    );
  });

  it("does not turn inherited observability state into an explicit retry override", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    printMcpRebuildRetryCommand("alpha", [{} as never], "progressive", {
      enabled: true,
      requestedExplicitly: false,
    });

    const command = error.mock.calls.flat().find((line) => line.includes("rebuild --yes"));
    expect(command).not.toContain("--observability");
    expect(command).not.toContain("--no-observability");
  });

  it("keeps inherited observability state implicit on the resume retry form", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    printMcpRebuildRetryCommand("alpha", [], "progressive", {
      enabled: false,
      requestedExplicitly: false,
    });

    const command = error.mock.calls.flat().find((line) => line.includes("onboard --resume"));
    expect(command).not.toContain("--observability");
    expect(command).not.toContain("--no-observability");
  });
});
