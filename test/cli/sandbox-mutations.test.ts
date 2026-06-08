// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runWithEnv, testTimeoutOptions, writeSandboxRegistry } from "./helpers";

describe("CLI dispatch", () => {
  it("connect help uses native oclif usage through the public sandbox route", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-inspection-help-"));
    writeSandboxRegistry(home);

    const connect = runWithEnv("alpha connect --help", { HOME: home });

    expect(connect.code).toBe(0);
    expect(connect.out).toContain("Usage: nemoclaw alpha connect");
    expect(connect.out).not.toContain("sandbox:connect");
  });

  it(
    "keeps public compatibility help routes for sandbox command families",
    testTimeoutOptions(30_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-family-help-"));
      writeSandboxRegistry(home);

      const logs = runWithEnv("alpha logs --help", { HOME: home });
      expect(logs.code).toBe(0);
      expect(logs.out).toContain("$ nemoclaw sandbox logs <name>");
      expect(logs.out).toContain("--tail");

      const policy = runWithEnv("alpha policy-add --help", { HOME: home });
      expect(policy.code).toBe(0);
      expect(policy.out).toContain("$ nemoclaw sandbox policy add <name>");

      const hosts = runWithEnv("alpha hosts-add --help", { HOME: home });
      expect(hosts.code).toBe(0);
      expect(hosts.out).toContain("$ nemoclaw sandbox hosts add <name>");

      const channels = runWithEnv("alpha channels add --help", { HOME: home });
      expect(channels.code).toBe(0);
      expect(channels.out).toContain("$ nemoclaw sandbox channels add <name>");

      const config = runWithEnv("alpha config get --help", { HOME: home });
      expect(config.code).toBe(0);
      expect(config.out).toContain("$ nemoclaw sandbox config get <name>");
      expect(config.out).toContain("--format json|yaml");
    },
  );

  it("keeps public mutation dry-runs and native sandbox command routes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-route-smoke-"));
    writeSandboxRegistry(home);

    const policy = runWithEnv("alpha policy-add github --dry-run", { HOME: home });
    expect(policy.code).toBe(0);
    expect(policy.out).toContain("--dry-run: no changes applied.");

    const channels = runWithEnv("alpha channels add telegram --dry-run", { HOME: home });
    expect(channels.code).toBe(0);
    expect(channels.out).toContain("--dry-run: would enable channel 'telegram' for 'alpha'.");

    const snapshots = runWithEnv("sandbox snapshot list alpha", { HOME: home });
    expect(snapshots.code).toBe(0);
    expect(snapshots.out).toContain("No snapshots found for 'alpha'.");
  });

  it("sandbox channels start rejects a sandbox missing from the registry (#4584)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-channels-missing-"));
    writeSandboxRegistry(home);

    const startMissing = runWithEnv("sandbox channels start does-not-exist telegram", { HOME: home });
    const stopMissing = runWithEnv("sandbox channels stop does-not-exist telegram", { HOME: home });

    expect(startMissing.code).toBe(1);
    expect(startMissing.out).toContain("Sandbox 'does-not-exist' not found in the registry.");
    expect(stopMissing.code).toBe(1);
    expect(stopMissing.out).toContain("Sandbox 'does-not-exist' not found in the registry.");
  });
});
