// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadAgent } from "./defs";
import {
  readStateDirectories,
  stateDirectoryPaths,
  stateDirectoryPrefixes,
} from "./state-directory-contract";

describe("agent state directory contract", () => {
  it("derives portable and machine-local state from one declaration", () => {
    const directories = readStateDirectories({
      state_dirs: [
        "history",
        { path: "identity", backup: false },
        { path: "agents" },
        { path: "native-plugins", clear_when_absent: false },
        { prefix: "agents-", backup: false },
      ],
    });

    expect(stateDirectoryPaths(directories)).toEqual([
      "history",
      "identity",
      "agents",
      "native-plugins",
    ]);
    expect(stateDirectoryPaths(directories, { backup: true })).toEqual([
      "history",
      "agents",
      "native-plugins",
    ]);
    expect(stateDirectoryPaths(directories, { backup: false })).toEqual(["identity"]);
    expect(stateDirectoryPrefixes(directories)).toEqual(["agents-"]);
    expect(stateDirectoryPrefixes(directories, { backup: false })).toEqual(["agents-"]);
    expect(
      directories.find((entry) => entry.kind === "path" && entry.path === "native-plugins"),
    ).toMatchObject({ clearWhenAbsent: false });
  });

  it("keeps OpenClaw machine-local authentication state out of snapshots", () => {
    const agent = loadAgent("openclaw");

    expect(agent.nonBackupStateDirs).toEqual([
      "plugins",
      "profiles",
      "identity",
      "devices",
      "state",
    ]);
    expect(agent.backupStateDirs).not.toEqual(
      expect.arrayContaining(["plugins", "profiles", "identity", "devices", "state"]),
    );
    expect(agent.backupStateDirs).not.toContain("state");
    expect(agent.stateDirs).toEqual(
      expect.arrayContaining(["plugins", "profiles", "identity", "devices", "state"]),
    );
  });

  it("keeps Hermes machine-local hooks out of snapshots", () => {
    const agent = loadAgent("hermes");

    expect(agent.nonBackupStateDirs).toContain("hooks");
    expect(agent.backupStateDirs).not.toContain("hooks");
  });

  it.each([
    [{ state_dirs: "state" }, /state_dirs.*array/],
    [{ state_dirs: ["../state"] }, /canonical relative path/],
    [{ state_dirs: [{ path: "/state" }] }, /relative path/],
    [{ state_dirs: [{ path: "state", prefix: "state-" }] }, /exactly one/],
    [{ state_dirs: [{ path: "state", unknown: true }] }, /unknown.*not allowed/],
    [{ state_dirs: [{ path: "state", backup: "yes" }] }, /backup.*boolean/],
    [{ state_dirs: [{ path: "state", clear_when_absent: "no" }] }, /clear_when_absent.*boolean/],
    [{ state_dirs: ["state", "state"] }, /repeats path:state/],
    [{ state_dirs: [{ path: "state" }, { prefix: "other-" }] }, /must extend a declared/],
  ])("rejects an invalid state declaration %#", (record, expected) => {
    expect(() => readStateDirectories(record)).toThrow(expected);
  });

  it("rejects an overlapping prefix and exact path", () => {
    expect(() =>
      readStateDirectories({
        state_dirs: [
          { path: "workspace" },
          { prefix: "workspace-" },
          { path: "workspace-dev", backup: false },
        ],
      }),
    ).toThrow(/prefix 'workspace-'.*overlaps exact path 'workspace-dev'/);
  });
});
