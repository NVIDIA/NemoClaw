// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as registry from "../../state/registry";
import * as mcpBridge from "./mcp-bridge";
import {
  preflightMcpRebuildState,
  printMcpRebuildRetryCommand,
  restoreMcpRegistryForRebuildRetry,
} from "./rebuild-mcp-phase";

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

describe("MCP rebuild transaction recovery", () => {
  it("rolls back an ownership-proven prepared destroy without deleting the sandbox", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha", mcp: { bridges: {} } });
    const preparation = {
      entries: [{ server: "server" }] as never[],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
      destroyAlreadyPrepared: true,
      destroyAlreadyPending: false,
    };
    vi.spyOn(mcpBridge, "prepareMcpBridgesForDestroy").mockResolvedValue(preparation);
    const restore = vi
      .spyOn(mcpBridge, "restoreMcpBridgesAfterDestroyAbort")
      .mockResolvedValue(undefined);
    const log = vi.fn();

    await expect(
      preflightMcpRebuildState(
        {
          name: "alpha",
          mcp: {
            bridges: { server: { server: "server" } as never },
            destroyPreparedAt: "2026-07-08T00:00:00.000Z",
          },
        },
        false,
        log,
        (message) => {
          throw new Error(message);
        },
      ),
    ).resolves.toMatchObject({ name: "alpha" });

    expect(restore).toHaveBeenCalledWith("alpha", preparation);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("without deleting"));
  });

  it("keeps replacement registry metadata authoritative after recreate failure", () => {
    const original = { name: "alpha", model: "old" };
    const restoreIfMissing = vi
      .spyOn(registry, "restorePreservedSandboxEntryIfMissing")
      .mockReturnValue(false);
    const restore = vi.spyOn(registry, "restoreSandboxEntry");
    const log = vi.fn();

    restoreMcpRegistryForRebuildRetry(false, [{} as never], original, log);

    expect(restoreIfMissing).toHaveBeenCalledWith(original);
    expect(restore).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("kept the current"));
  });
});
