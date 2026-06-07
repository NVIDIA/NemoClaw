// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PARSER_EXIT_CODE, runWithEnv, testTimeoutOptions, writeSandboxRegistry } from "./helpers";

describe("CLI dispatch", () => {
  it("sandbox inspection help uses native oclif usage", testTimeoutOptions(45_000), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-inspection-help-"));
    writeSandboxRegistry(home);

    const connect = runWithEnv("alpha connect --help", { HOME: home });
    expect(connect.code).toBe(0);
    expect(connect.out).toContain("Usage: nemoclaw alpha connect");
    expect(connect.out).not.toContain("sandbox:connect");

    const status = runWithEnv("alpha status --help", { HOME: home });
    expect(status.code).toBe(0);
    expect(status.out).toContain("$ nemoclaw sandbox status <name>");

    const doctor = runWithEnv("alpha doctor --help", { HOME: home });
    expect(doctor.code).toBe(0);
    expect(doctor.out).toContain("$ nemoclaw sandbox doctor <name> [--json]");

    const logs = runWithEnv("alpha logs --help", { HOME: home });
    expect(logs.code).toBe(0);
    expect(logs.out).toContain("$ nemoclaw sandbox logs <name>");
    expect(logs.out).toContain("--follow");
    expect(logs.out).toContain("--tail");
    expect(logs.out).toContain("--since");

    const destroy = runWithEnv("alpha destroy --help", { HOME: home });
    expect(destroy.code).toBe(0);
    expect(destroy.out).toContain("$ nemoclaw sandbox destroy <name>");

    const rebuild = runWithEnv("alpha rebuild --help", { HOME: home });
    expect(rebuild.code).toBe(0);
    expect(rebuild.out).toContain("$ nemoclaw sandbox rebuild <name>");

    for (const action of ["policy-add", "policy-remove", "policy-list"]) {
      const policy = runWithEnv(`alpha ${action} --help`, { HOME: home });
      expect(policy.code).toBe(0);
      expect(policy.out).toContain("$ nemoclaw sandbox ");
    }

    for (const action of ["hosts-add", "hosts-list", "hosts-remove"]) {
      const hosts = runWithEnv(`alpha ${action} --help`, { HOME: home });
      expect(hosts.code).toBe(0);
      expect(hosts.out).toContain("$ nemoclaw sandbox hosts ");
    }

    const channels = runWithEnv("alpha channels list --help", { HOME: home });
    expect(channels.code).toBe(0);
    expect(channels.out).toContain("$ nemoclaw sandbox channels list <name>");

    for (const subcommand of ["add", "remove", "stop", "start"]) {
      const result = runWithEnv(`alpha channels ${subcommand} --help`, { HOME: home });
      expect(result.code).toBe(0);
      expect(result.out).toContain(`$ nemoclaw sandbox channels ${subcommand} <name>`);
    }

    const config = runWithEnv("alpha config get --help", { HOME: home });
    expect(config.code).toBe(0);
    expect(config.out).toContain("$ nemoclaw sandbox config get <name>");
    expect(config.out).toContain("--format json|yaml");
  });

  it("policy mutation dry-run paths dispatch through oclif", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-policy-dry-run-"));
    writeSandboxRegistry(home);

    const add = runWithEnv("alpha policy-add github --dry-run", { HOME: home });
    expect(add.code).toBe(0);
    expect(add.out).toContain("--dry-run: no changes applied.");

    const registryPath = path.join(home, ".nemoclaw", "sandboxes.json");
    const registryJson = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    registryJson.sandboxes.alpha.policies = ["github"];
    fs.writeFileSync(registryPath, JSON.stringify(registryJson), { mode: 0o600 });

    const remove = runWithEnv("alpha policy-remove github --dry-run", { HOME: home });
    expect(remove.code).toBe(0);
    expect(remove.out).toContain("--dry-run: no changes applied.");
  });

  it(
    "channels mutation dry-run paths dispatch through oclif",
    testTimeoutOptions(15_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-channels-dry-run-"));
      writeSandboxRegistry(home);

      const add = runWithEnv("alpha channels add telegram --dry-run", { HOME: home });
      expect(add.code).toBe(0);
      expect(add.out).toContain("--dry-run: would enable channel 'telegram' for 'alpha'.");

      const addMixedCase = runWithEnv("alpha channels add Telegram --dry-run", { HOME: home });
      expect(addMixedCase.code).toBe(0);
      expect(addMixedCase.out).toContain("--dry-run: would enable channel 'telegram' for 'alpha'.");

      const remove = runWithEnv("alpha channels remove telegram --dry-run", { HOME: home });
      expect(remove.code).toBe(0);
      expect(remove.out).toContain("--dry-run: would remove channel 'telegram' for 'alpha'.");

      const removeMixedCase = runWithEnv("alpha channels remove Telegram --dry-run", {
        HOME: home,
      });
      expect(removeMixedCase.code).toBe(0);
      expect(removeMixedCase.out).toContain(
        "--dry-run: would remove channel 'telegram' for 'alpha'.",
      );

      const stop = runWithEnv("alpha channels stop telegram --dry-run", { HOME: home });
      expect(stop.code).toBe(0);
      expect(stop.out).toContain("--dry-run: would stop channel 'telegram' for 'alpha'.");

      const start = runWithEnv("alpha channels start telegram --dry-run", { HOME: home });
      expect(start.code).toBe(0);
      expect(start.out).toContain("Channel 'telegram' is already enabled for 'alpha'. Nothing to do.");
    },
  );

  it("sandbox channels start rejects a sandbox missing from the registry (#4584)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-channels-missing-"));
    writeSandboxRegistry(home);
    // The native `sandbox channels start <name> <channel>` grammar reaches
    // sandboxChannelsSetEnabled directly, bypassing the public-route existence
    // guard. For a missing sandbox the start path short-circuited as
    // "already enabled ... Nothing to do" and exited 0, while stop exited 1.
    const startMissing = runWithEnv("sandbox channels start does-not-exist telegram", { HOME: home });
    expect(startMissing.code).toBe(1);
    expect(startMissing.out).toContain("Sandbox 'does-not-exist' not found in the registry.");
    const stopMissing = runWithEnv("sandbox channels stop does-not-exist telegram", { HOME: home });
    expect(stopMissing.code).toBe(1);
    expect(stopMissing.out).toContain("Sandbox 'does-not-exist' not found in the registry.");
  });

  it("supports oclif-native sandbox command forms", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-native-sandbox-"));
    writeSandboxRegistry(home);

    const statusHelp = runWithEnv("sandbox status alpha --help", { HOME: home });
    expect(statusHelp.code).toBe(0);
    expect(statusHelp.out).toContain("$ nemoclaw sandbox status <name>");
    expect(statusHelp.out).not.toContain("Sandbox 'sandbox' does not exist");

    const policy = runWithEnv("sandbox policy add alpha github --dry-run", { HOME: home });
    expect(policy.code).toBe(0);
    expect(policy.out).toContain("--dry-run: no changes applied.");

    const channels = runWithEnv("sandbox channels add alpha telegram --dry-run", { HOME: home });
    expect(channels.code).toBe(0);
    expect(channels.out).toContain("--dry-run: would enable channel 'telegram' for 'alpha'.");

    const snapshots = runWithEnv("sandbox snapshot list alpha", { HOME: home });
    expect(snapshots.code).toBe(0);
    expect(snapshots.out).toContain("No snapshots found for 'alpha'.");
  });

  it(
    "policy and channel mutations reject missing parser-owned values before dispatch",
    testTimeoutOptions(30_000),
    () => {
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-cli-mutation-missing-values-"),
      );
      writeSandboxRegistry(home);

      const missingPolicyFile = runWithEnv("alpha policy-add --from-file 2>&1", {
        HOME: home,
      });
      expect(missingPolicyFile.code).not.toBe(0);
      expect(missingPolicyFile.out).toContain("--from-file");

      for (const action of ["add", "remove", "start", "stop"]) {
        const missingChannel = runWithEnv(`alpha channels ${action} 2>&1`, { HOME: home });
        expect(
          missingChannel.code,
          `alpha channels ${action} exited ${missingChannel.code} with output:\n${missingChannel.out}`,
        ).toBe(PARSER_EXIT_CODE);
        expect(missingChannel.out).toContain("Missing 1 required arg:");
        expect(missingChannel.out).toContain("channel  Messaging channel");
        expect(missingChannel.out).toContain("USAGE");
        expect(missingChannel.out).toContain(
          `$ nemoclaw sandbox channels ${action} <name> <channel> [--dry-run]`,
        );
        expect(missingChannel.out).not.toContain("RequiredArgsError");
        expect(missingChannel.out).not.toContain("at validateArgs");
        expect(missingChannel.out).not.toContain(`Command alpha:channels:${action} not found`);
      }
    },
  );

  it("diagnostic commands reject invalid parser-owned flags before dispatch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-diagnostics-invalid-flags-"));
    writeSandboxRegistry(home);

    const badConfigFormat = runWithEnv("alpha config get --format xml 2>&1", { HOME: home });
    expect(badConfigFormat.code).not.toBe(0);
    expect(badConfigFormat.out).toContain("--format");
    expect(badConfigFormat.out).toContain("json");
    expect(badConfigFormat.out).toContain("yaml");

    const badDoctorFlag = runWithEnv("alpha doctor --bogus 2>&1", { HOME: home });
    expect(badDoctorFlag.code).not.toBe(0);
    expect(badDoctorFlag.out).toContain("Nonexistent flag: --bogus");
  });
});
