// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test as it } from "../helpers/owned-test-resources";

import { runWithEnv, testTimeoutOptions, writeSandboxRegistry } from "./helpers";

describe("CLI dispatch", () => {
  it("shields help uses native oclif usage", testTimeoutOptions(30_000), ({ testHome }) => {
    const { home } = testHome;
    writeSandboxRegistry(home);

    const down = runWithEnv("alpha shields down --help", testHome.environment());
    expect(down.code).toBe(0);
    expect(down.out).toContain("$ nemoclaw sandbox shields down <name>");

    const up = runWithEnv("alpha shields up --help", testHome.environment());
    expect(up.code).toBe(0);
    expect(up.out).toContain("$ nemoclaw sandbox shields up <name>");

    const status = runWithEnv("alpha shields status --help", testHome.environment());
    expect(status.code).toBe(0);
    expect(status.out).toContain("$ nemoclaw sandbox shields status <name>");
  });

  it(
    "snapshot subcommand help uses native oclif usage",
    testTimeoutOptions(30_000),
    ({ testHome }) => {
      const { home } = testHome;
      writeSandboxRegistry(home);

      const parent = runWithEnv("alpha snapshot --help", testHome.environment());
      expect(parent.code).toBe(0);
      expect(parent.out).toContain("$ nemoclaw sandbox snapshot <create|list|restore> <name>");
      expect(parent.out).toContain("sandbox snapshot create");
      expect(parent.out).toContain("sandbox snapshot list");

      const list = runWithEnv("alpha snapshot list --help", testHome.environment());
      expect(list.code).toBe(0);
      expect(list.out).toContain("$ nemoclaw sandbox snapshot list <name>");

      const create = runWithEnv("alpha snapshot create --help", testHome.environment());
      expect(create.code).toBe(0);
      expect(create.out).toContain("$ nemoclaw sandbox snapshot create <name> [--name <label>]");

      const restore = runWithEnv("alpha snapshot restore --help", testHome.environment());
      expect(restore.code).toBe(0);
      expect(restore.out).toContain(
        "$ nemoclaw sandbox snapshot restore <name> [selector] [--to <dst>]",
      );
    },
  );

  it("snapshot list dispatches through oclif", ({ testHome }) => {
    const { home } = testHome;
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha snapshot list", testHome.environment());
    expect(r.code).toBe(0);
    expect(r.out).toContain("No snapshots found for 'alpha'.");
  });

  it("unknown snapshot subcommands fail before action dispatch", ({ testHome }) => {
    const { home } = testHome;
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha snapshot bogus 2>&1", testHome.environment());
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Unexpected argument:|Command .*not found/);
  });
});
