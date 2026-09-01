// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, test as it } from "../helpers/owned-test-resources";
import {
  livePolicyMetadata,
  managedSandboxEntry,
  SANDBOX_ID,
} from "../helpers/live-policy-fixture";

import { runWithEnv, runWithInput, testTimeoutOptions, writeSandboxRegistry } from "./helpers";

function readOpenShellPolicy(home: string): string {
  return fs.readFileSync(path.join(home, "applied-policy.yaml"), "utf8");
}

function writePolicyMutationOpenshellStub(home: string): string {
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });
  const openshell = path.join(localBin, "openshell");
  const appliedPolicy = path.join(home, "applied-policy.yaml");
  fs.writeFileSync(appliedPolicy, "version: 1\nnetwork_policies: {}\n", { mode: 0o600 });
  fs.writeFileSync(
    openshell,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then',
      `  printf 'Name: alpha\\nId: ${SANDBOX_ID}\\nPhase: Ready\\n'`,
      "  exit 0",
      "fi",
      'if [ "$1" = "policy" ] && [ "$2" = "get" ]; then',
      '  if [[ " $* " == *" --output json "* ]]; then',
      `    printf '%s\\n' ${JSON.stringify(livePolicyMetadata("alpha"))}`,
      "    exit 0",
      "  fi",
      `  cat ${JSON.stringify(appliedPolicy)}`,
      "  exit 0",
      "fi",
      'if [ "$1" = "policy" ] && [ "$2" = "set" ]; then',
      '  while [ "$#" -gt 0 ]; do',
      '    if [ "$1" = "--policy" ]; then',
      `      cp "$2" ${JSON.stringify(appliedPolicy)}`,
      "      break",
      "    fi",
      "    shift",
      "  done",
      "  exit 0",
      "fi",
      'printf "unexpected openshell args: %s\\n" "$*" >&2',
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
  return openshell;
}

describe("CLI dispatch", () => {
  it("connect help uses native oclif usage through the public sandbox route", ({ testHome }) => {
    const { home } = testHome;
    writeSandboxRegistry(home);

    const connect = runWithEnv("alpha connect --help", testHome.environment());

    expect(connect.code).toBe(0);
    expect(connect.out).toContain("Usage: nemoclaw alpha connect");
    expect(connect.out).not.toContain("sandbox:connect");
  });

  it(
    "keeps public compatibility help routes for sandbox command families",
    testTimeoutOptions(30_000),
    ({ testHome }) => {
      const { home } = testHome;
      writeSandboxRegistry(home);

      const logs = runWithEnv("alpha logs --help", testHome.environment());
      expect(logs.code).toBe(0);
      expect(logs.out).toContain("$ nemoclaw alpha logs");
      expect(logs.out).not.toContain("$ nemoclaw sandbox logs");
      expect(logs.out).toContain("--tail");

      const policy = runWithEnv("alpha policy-add --help", testHome.environment());
      expect(policy.code).toBe(0);
      expect(policy.out).toContain("$ nemoclaw alpha policy add");
      expect(policy.out).not.toContain("$ nemoclaw sandbox policy add");

      const hosts = runWithEnv("alpha hosts-add --help", testHome.environment());
      expect(hosts.code).toBe(0);
      expect(hosts.out).toContain("$ nemoclaw alpha hosts-add");
      expect(hosts.out).not.toContain("$ nemoclaw sandbox hosts add");

      const channels = runWithEnv("alpha channels add --help", testHome.environment());
      expect(channels.code).toBe(0);
      expect(channels.out).toContain("$ nemoclaw alpha channels add");
      expect(channels.out).not.toContain("$ nemoclaw sandbox channels add");

      const config = runWithEnv("alpha config get --help", testHome.environment());
      expect(config.code).toBe(0);
      expect(config.out).toContain("$ nemoclaw alpha config get");
      expect(config.out).not.toContain("$ nemoclaw sandbox config get");
      expect(config.out).toContain("--format json|yaml");
    },
  );

  it("keeps public mutation dry-runs and native sandbox command routes", ({ testHome }) => {
    const { home } = testHome;
    writeSandboxRegistry(home);

    const policy = runWithEnv("alpha policy-add github --dry-run", testHome.environment());
    expect(policy.code).toBe(0);
    expect(policy.out).toContain("--dry-run: no changes applied.");

    const channels = runWithEnv("alpha channels add telegram --dry-run", testHome.environment());
    expect(channels.code).toBe(0);
    expect(channels.out).toContain("--dry-run: would enable channel 'telegram' for 'alpha'.");

    const snapshots = runWithEnv("sandbox snapshot list alpha", testHome.environment());
    expect(snapshots.code).toBe(0);
    expect(snapshots.out).toContain("No snapshots found for 'alpha'.");
  });

  it("keeps public policy-add/remove built-in mutation routes", ({ testHome }) => {
    const { home } = testHome;
    writeSandboxRegistry(home, managedSandboxEntry("alpha"));
    const openshell = writePolicyMutationOpenshellStub(home);

    const add = runWithEnv(
      "alpha policy-add github --yes",
      testHome.environment({
        NEMOCLAW_OPENSHELL_BIN: openshell,
      }),
    );
    expect(add.code).toBe(0);
    expect(add.out).toContain("Applied preset: github");
    expect(readOpenShellPolicy(home)).toContain("github:");

    const remove = runWithEnv(
      "alpha policy-remove github -y",
      testHome.environment({
        NEMOCLAW_OPENSHELL_BIN: openshell,
      }),
    );
    expect(remove.code).toBe(0);
    expect(remove.out).toContain("Removed preset: github");
    expect(readOpenShellPolicy(home)).not.toContain("github:");
  });

  it("keeps public policy-add non-interactive missing-preset failure before mutation", ({
    testHome,
  }) => {
    const { home } = testHome;
    writeSandboxRegistry(home);
    const openshell = writePolicyMutationOpenshellStub(home);

    const result = runWithEnv(
      "alpha policy-add",
      testHome.environment({
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_OPENSHELL_BIN: openshell,
      }),
    );

    expect(result.code).toBe(1);
    expect(result.out).toContain("Non-interactive mode requires a preset name.");
    expect(readOpenShellPolicy(home)).toBe("version: 1\nnetwork_policies: {}\n");
  });

  it("keeps public policy-add missing-preset failure when stdin contains probe output", ({
    testHome,
  }) => {
    const { home } = testHome;
    writeSandboxRegistry(home);
    const openshell = writePolicyMutationOpenshellStub(home);

    const result = runWithInput(
      "alpha policy-add",
      "/usr/bin/dmesg\n3",
      testHome.environment({
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_OPENSHELL_BIN: openshell,
      }),
    );

    expect(result.code).toBe(1);
    expect(result.out).toContain("Non-interactive mode requires a preset name.");
    expect(result.out).not.toContain("Unknown preset '/usr/bin/dmesg");
    expect(readOpenShellPolicy(home)).toBe("version: 1\nnetwork_policies: {}\n");
  });

  it("sandbox channels start rejects a sandbox missing from the registry (#4584)", ({
    testHome,
  }) => {
    const { home } = testHome;
    writeSandboxRegistry(home);

    const startMissing = runWithEnv(
      "sandbox channels start does-not-exist telegram",
      testHome.environment(),
    );
    const stopMissing = runWithEnv(
      "sandbox channels stop does-not-exist telegram",
      testHome.environment(),
    );

    expect(startMissing.code).toBe(1);
    expect(startMissing.out).toContain("Sandbox 'does-not-exist' not found in the registry.");
    expect(stopMissing.code).toBe(1);
    expect(stopMissing.out).toContain("Sandbox 'does-not-exist' not found in the registry.");
  });
});
