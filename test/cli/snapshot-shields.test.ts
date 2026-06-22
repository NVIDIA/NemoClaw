// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runWithEnv, testTimeoutOptions, writeSandboxRegistry } from "./helpers";

describe("CLI dispatch", () => {
  it("shields help uses native oclif usage", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-shields-help-"));
    writeSandboxRegistry(home);

    const down = runWithEnv("alpha shields down --help", { HOME: home });
    expect(down.code).toBe(0);
    expect(down.out).toContain("$ nemoclaw sandbox shields down <name>");

    const up = runWithEnv("alpha shields up --help", { HOME: home });
    expect(up.code).toBe(0);
    expect(up.out).toContain("$ nemoclaw sandbox shields up <name>");

    const status = runWithEnv("alpha shields status --help", { HOME: home });
    expect(status.code).toBe(0);
    expect(status.out).toContain("$ nemoclaw sandbox shields status <name>");
  });

  it("snapshot subcommand help uses native oclif usage", testTimeoutOptions(30_000), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-snapshot-help-"));
    writeSandboxRegistry(home);

    const parent = runWithEnv("alpha snapshot --help", { HOME: home });
    expect(parent.code).toBe(0);
    expect(parent.out).toContain("$ nemoclaw sandbox snapshot <create|list|restore> <name>");
    expect(parent.out).toContain("sandbox snapshot create");
    expect(parent.out).toContain("sandbox snapshot list");

    const list = runWithEnv("alpha snapshot list --help", { HOME: home });
    expect(list.code).toBe(0);
    expect(list.out).toContain("$ nemoclaw sandbox snapshot list <name>");

    const create = runWithEnv("alpha snapshot create --help", { HOME: home });
    expect(create.code).toBe(0);
    expect(create.out).toContain("$ nemoclaw sandbox snapshot create <name> [--name <label>]");

    const restore = runWithEnv("alpha snapshot restore --help", { HOME: home });
    expect(restore.code).toBe(0);
    expect(restore.out).toContain(
      "$ nemoclaw sandbox snapshot restore <name> [selector] [--to <dst>]",
    );
  });

  it("snapshot list dispatches through oclif", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-snapshot-list-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha snapshot list", { HOME: home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("No snapshots found for 'alpha'.");
  });

  it("unknown snapshot subcommands fail before action dispatch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-snapshot-unknown-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha snapshot bogus 2>&1", { HOME: home });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Unexpected argument:|Command .*not found/);
  });
});
