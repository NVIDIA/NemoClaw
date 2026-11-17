// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NemoClawState } from "./blueprint/state.js";
import type { NemoClawConfig } from "./index.js";
import { getRuntimeSummary } from "./runtime-context.js";

vi.mock("./blueprint/state.js", () => ({ loadState: vi.fn() }));

import { loadState } from "./blueprint/state.js";

const mockedLoadState = vi.mocked(loadState);

const defaultConfig: NemoClawConfig = {
  blueprintVersion: "latest",
  blueprintRegistry: "ghcr.io/nvidia/nemoclaw-blueprint",
  sandboxName: "openclaw",
  inferenceProvider: "nvidia",
};

function blankState(patch: Partial<NemoClawState> = {}): NemoClawState {
  return {
    lastRunId: null,
    lastAction: null,
    blueprintVersion: null,
    sandboxName: null,
    migrationSnapshot: null,
    hostBackupPath: null,
    createdAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    lastRebuildAt: null,
    lastRebuildBackupPath: null,
    ...patch,
  };
}

describe("getRuntimeSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadState.mockReturnValue(blankState());
  });

  it("returns static deny-by-default context for the configured sandbox", () => {
    const summary = getRuntimeSummary(defaultConfig);

    expect(summary.sandboxName).toBe("openclaw");
    expect(summary.sandboxPhase).toBeNull();
    expect(summary.networkLines.join(" ")).toContain("deny-by-default");
    expect(summary.networkLines.join(" ")).toContain(
      "Try the request before declaring a host unreachable",
    );
    expect(summary.filesystemLines).toContain(
      "filesystem and process access are scoped to the sandbox, not the host; do not assume access to host paths outside it",
    );
  });

  it("prefers the persisted sandbox name when available", () => {
    mockedLoadState.mockReturnValue(blankState({ sandboxName: "my-assistant" }));

    const summary = getRuntimeSummary(defaultConfig);

    expect(summary.sandboxName).toBe("my-assistant");
  });

  it("falls back to plugin config when state cannot be read", () => {
    mockedLoadState.mockImplementation(() => {
      throw new Error("state unavailable");
    });

    const summary = getRuntimeSummary(defaultConfig);

    expect(summary.sandboxName).toBe("openclaw");
  });
});
