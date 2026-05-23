// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NemoClawState } from "../blueprint/state.js";

vi.mock("../blueprint/state.js", () => ({
  loadState: vi.fn(),
}));

import { slashShieldsStatus } from "./shields-status.js";
import { loadState } from "../blueprint/state.js";

const mockedLoadState = vi.mocked(loadState);

function blankState(): NemoClawState {
  return {
    lastRunId: null,
    lastAction: null,
    blueprintVersion: null,
    sandboxName: null,
    migrationSnapshot: null,
    hostBackupPath: null,
    createdAt: null,
    updatedAt: new Date().toISOString(),
    lastRebuildAt: null,
    lastRebuildBackupPath: null,
    shieldsDown: false,
    shieldsDownAt: null,
    shieldsDownTimeout: null,
    shieldsDownReason: null,
    shieldsDownPolicy: null,
    shieldsPolicySnapshotPath: null,
  };
}

describe("commands/shields-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadState.mockReturnValue(blankState());
  });

  it("reports shields UP when not down", () => {
    const result = slashShieldsStatus();
    expect(result.text).toContain("Shields: UP");
    expect(result.text).toContain("normal security level");
  });

  it("shows last-lowered info when UP with a previous snapshot", () => {
    mockedLoadState.mockReturnValue({
      ...blankState(),
      shieldsDown: false,
      shieldsPolicySnapshotPath: "/home/user/.nemoclaw/state/policy-snapshot-123.yaml",
    });
    const result = slashShieldsStatus();
    expect(result.text).toContain("Shields: UP");
    expect(result.text).toContain("policy-snapshot-123.yaml");
  });

  it("reports shields DOWN with details", () => {
    mockedLoadState.mockReturnValue({
      ...blankState(),
      shieldsDown: true,
      shieldsDownAt: "2026-04-13T14:30:00Z",
      shieldsDownTimeout: 300,
      shieldsDownReason: "Installing Slack plugin",
      shieldsDownPolicy: "permissive",
      shieldsPolicySnapshotPath: "/home/user/.nemoclaw/state/policy-snapshot-1681394200.yaml",
    });

    const result = slashShieldsStatus();
    expect(result.text).toContain("Shields: DOWN");
    expect(result.text).toContain("2026-04-13T14:30:00Z");
    expect(result.text).toContain("Installing Slack plugin");
    expect(result.text).toContain("permissive");
  });

  it("shows remaining time when shields are down", () => {
    const fiveMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    mockedLoadState.mockReturnValue({
      ...blankState(),
      shieldsDown: true,
      shieldsDownAt: fiveMinutesAgo,
      shieldsDownTimeout: 300, // 5 minutes total
      shieldsDownReason: "Testing",
      shieldsDownPolicy: "permissive",
    });

    const result = slashShieldsStatus();
    expect(result.text).toContain("remaining");
  });

  it("handles shields DOWN with no timeout set", () => {
    mockedLoadState.mockReturnValue({
      ...blankState(),
      shieldsDown: true,
      shieldsDownAt: new Date().toISOString(),
      shieldsDownTimeout: null,
      shieldsDownReason: "Manual override",
      shieldsDownPolicy: "custom",
    });

    const result = slashShieldsStatus();
    expect(result.text).toContain("Shields: DOWN");
    expect(result.text).toContain("Manual override");
    expect(result.text).not.toContain("remaining");
  });

  it("includes security warning when shields are down", () => {
    mockedLoadState.mockReturnValue({
      ...blankState(),
      shieldsDown: true,
      shieldsDownAt: new Date().toISOString(),
      shieldsDownTimeout: 300,
    });

    const result = slashShieldsStatus();
    expect(result.text).toContain("Warning");
    expect(result.text).toContain("nemoclaw shields up");
  });

  it("shows default values when reason and policy are not specified", () => {
    mockedLoadState.mockReturnValue({
      ...blankState(),
      shieldsDown: true,
      shieldsDownAt: new Date().toISOString(),
      shieldsDownTimeout: 300,
    });

    const result = slashShieldsStatus();
    expect(result.text).toContain("not specified");
    expect(result.text).toContain("permissive");
  });
});
