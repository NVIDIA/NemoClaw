// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  auditSandboxDeleteSites,
  SANDBOX_DELETE_SITES,
} from "../scripts/checks/sandbox-replacement-journal.mts";

const repoRoot = path.join(import.meta.dirname, "..");
const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const target = created.pop();
    if (target) fs.rmSync(target, { recursive: true, force: true });
  }
});

function stageRepo(): string {
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-delete-audit-"));
  created.push(staged);
  fs.cpSync(path.join(repoRoot, "src", "lib"), path.join(staged, "src", "lib"), {
    recursive: true,
  });
  return staged;
}

describe("same-name sandbox replacement audit", () => {
  it("accepts the recorded delete call sites", () => {
    expect(auditSandboxDeleteSites(repoRoot)).toEqual([]);
  });

  it("rejects a new sandbox delete call site that bypasses the recreate transaction (#7736)", () => {
    const staged = stageRepo();
    fs.writeFileSync(
      path.join(staged, "src", "lib", "onboard", "bypass-probe.ts"),
      'export const argv = ["sandbox", "delete", "my-assistant"];\n',
    );

    const problems = auditSandboxDeleteSites(staged);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/bypass-probe\.ts: 1 unaccounted 'sandbox delete' call site/);
  });

  it("rejects an extra delete call added to a recorded site (#7736)", () => {
    const staged = stageRepo();
    const target = path.join(staged, "src", "lib", "onboard", "cancel-rollback.ts");
    fs.appendFileSync(target, 'export const extra = ["sandbox", "delete", "my-assistant"];\n');

    const problems = auditSandboxDeleteSites(staged);

    expect(problems).toEqual([
      "src/lib/onboard/cancel-rollback.ts: expected 1 'sandbox delete' call site(s), found 2.",
    ]);
  });

  it("rejects a recorded site whose delete call disappeared (#7736)", () => {
    const staged = stageRepo();
    fs.rmSync(path.join(staged, "src", "lib", "onboard", "hermes-dashboard.ts"));

    const problems = auditSandboxDeleteSites(staged);

    expect(problems).toEqual([
      "src/lib/onboard/hermes-dashboard.ts: recorded 'sandbox delete' call site is gone. Remove it from scripts/checks/sandbox-replacement-journal.mts.",
    ]);
  });

  it("records why every audited site may delete a sandbox", () => {
    for (const site of SANDBOX_DELETE_SITES) {
      expect(site.reason).not.toBe("");
      expect(site.expectedCalls).toBeGreaterThan(0);
    }
  });
});
