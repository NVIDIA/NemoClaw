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

  it("treats an empty string argument as a read-only status request", () => {
    const result = slashShieldsStatus("");
    expect(result.text).toContain("Shields: UP");
  });

  it("treats whitespace-only argument as a read-only status request", () => {
    const result = slashShieldsStatus("   ");
    expect(result.text).toContain("Shields: UP");
  });

  it("treats explicit `status` argument as a read-only status request", () => {
    const result = slashShieldsStatus("status");
    expect(result.text).toContain("Shields: UP");
  });

  it("returns a host-only guidance message for `down`", () => {
    const result = slashShieldsStatus("down");
    expect(result.text).toContain("Shields down");
    expect(result.text).toContain("host-only");
    expect(result.text).toContain("nemoclaw <name> shields down");
    expect(mockedLoadState).not.toHaveBeenCalled();
  });

  it("returns a host-only guidance message for `up`", () => {
    const result = slashShieldsStatus("up");
    expect(result.text).toContain("Shields up");
    expect(result.text).toContain("host-only");
    expect(result.text).toContain("nemoclaw <name> shields up");
    expect(mockedLoadState).not.toHaveBeenCalled();
  });

  it("returns an `Unknown argument` message for an unrecognised sub-argument", () => {
    const result = slashShieldsStatus("abcxyz");
    expect(result.text).toContain("Unknown argument");
    expect(result.text).toContain("abcxyz");
    expect(result.text).toContain("/nemoclaw shields [status]");
    expect(mockedLoadState).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace before classifying the sub-argument", () => {
    const result = slashShieldsStatus("  down  ");
    expect(result.text).toContain("Shields down");
    expect(result.text).toContain("host-only");
  });

  it("strips backticks from the echoed unknown argument so inline-code formatting cannot be broken", () => {
    const result = slashShieldsStatus("`evil`");
    expect(result.text).toContain("Unknown argument");
    expect(result.text).not.toContain("`evil`");
    expect(result.text).toContain("?evil?");
  });

  it("strips ASCII control characters from the echoed unknown argument", () => {
    const result = slashShieldsStatus("ab\x01cd\x1Fef");
    expect(result.text).toContain("Unknown argument");
    expect(result.text).toContain("ab?cd?ef");
    expect(result.text).not.toContain("\x01");
    expect(result.text).not.toContain("\x1F");
  });

  it("truncates an overly long unknown argument with an ellipsis", () => {
    const long = "a".repeat(64);
    const result = slashShieldsStatus(long);
    expect(result.text).toContain("Unknown argument");
    expect(result.text).toContain(`${"a".repeat(32)}…`);
    expect(result.text).not.toContain("a".repeat(33));
  });
});
