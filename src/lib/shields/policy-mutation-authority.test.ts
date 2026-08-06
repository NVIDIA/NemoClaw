// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveNemoclawStateDir } from "../state/paths";
import {
  assertShieldsPolicyMutationAllowed,
  issueManagedMcpPolicyMutationAuthority,
  issueRebuildPolicyMutationAuthority,
} from "./transition-lock";

const sandboxName = "alpha";
const processToken = "a".repeat(32);

function writeShieldsState(shieldsDown: boolean): void {
  const stateDir = resolveNemoclawStateDir();
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(stateDir, `shields-${sandboxName}.json`),
    JSON.stringify({ shieldsDown, shieldsPolicySnapshotPath: "/tmp/snapshot.yaml" }),
    { mode: 0o600 },
  );
}

describe("Shields policy mutation authority", () => {
  afterEach(() => {
    const stateDir = resolveNemoclawStateDir();
    fs.rmSync(path.join(stateDir, `shields-${sandboxName}.json`), { force: true });
    fs.rmSync(path.join(stateDir, `shields-timer-${sandboxName}.json`), { force: true });
    fs.rmSync(path.join(stateDir, `shields-transition-${sandboxName}-${processToken}.json`), {
      force: true,
    });
  });

  it("allows ordinary policy mutation in fresh and explicitly locked postures (#8176)", () => {
    expect(() => assertShieldsPolicyMutationAllowed(sandboxName)).not.toThrow();
    writeShieldsState(false);
    expect(() => assertShieldsPolicyMutationAllowed(sandboxName)).not.toThrow();
  });

  it("blocks ordinary policy mutation while Shields are down (#8176)", () => {
    writeShieldsState(true);
    expect(() => assertShieldsPolicyMutationAllowed(sandboxName)).toThrow(/Shields are down/);
  });

  it("accepts only sandbox-bound managed MCP and rebuild authority while Shields are down (#8176)", () => {
    writeShieldsState(true);
    const managedMcp = issueManagedMcpPolicyMutationAuthority(sandboxName);
    const rebuild = issueRebuildPolicyMutationAuthority(sandboxName);
    const wrongSandbox = issueManagedMcpPolicyMutationAuthority("beta");

    expect(() => assertShieldsPolicyMutationAllowed(sandboxName, managedMcp)).not.toThrow();
    expect(() => assertShieldsPolicyMutationAllowed(sandboxName, rebuild)).not.toThrow();
    expect(() => assertShieldsPolicyMutationAllowed(sandboxName, wrongSandbox)).toThrow(
      /Shields are down/,
    );
    expect(() => assertShieldsPolicyMutationAllowed(sandboxName, {} as never)).toThrow(
      /Shields are down/,
    );
  });

  it("accepts internal authority for a complete timer-bound Shields-down generation (#8176)", () => {
    writeShieldsState(true);
    const stateDir = resolveNemoclawStateDir();
    const snapshotPath = "/tmp/snapshot.yaml";
    fs.writeFileSync(
      path.join(stateDir, `shields-timer-${sandboxName}.json`),
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: new Date(Date.now() + 60_000).toISOString(),
        processToken,
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(stateDir, `shields-transition-${sandboxName}-${processToken}.json`),
      JSON.stringify({
        version: 1,
        phase: "active",
        ownerPid: process.pid,
        ownerStartIdentity: "test-owner",
        processToken,
        sandboxName,
        snapshotPath,
      }),
      { mode: 0o600 },
    );

    const authority = issueManagedMcpPolicyMutationAuthority(sandboxName);
    expect(() => assertShieldsPolicyMutationAllowed(sandboxName, authority)).not.toThrow();
    expect(() => assertShieldsPolicyMutationAllowed(sandboxName)).toThrow(/Shields are down/);
  });

  it("denies internal authority when timer recovery is incomplete (#8176)", () => {
    writeShieldsState(true);
    fs.writeFileSync(
      path.join(resolveNemoclawStateDir(), `shields-timer-${sandboxName}.json`),
      "{}",
      { mode: 0o600 },
    );

    expect(() =>
      assertShieldsPolicyMutationAllowed(
        sandboxName,
        issueRebuildPolicyMutationAuthority(sandboxName),
      ),
    ).toThrow(/incomplete Shields transition/);
  });
});
