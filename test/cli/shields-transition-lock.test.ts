// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, test as it } from "../helpers/owned-test-resources";

import { runWithEnv, testTimeoutOptions, writeSandboxRegistry } from "./helpers";

const REFUSAL_BUDGET_MS = 15_000;

function writeCorruptTransitionLock(home: string, sandboxName: string): string {
  const stateDir = path.join(home, ".nemoclaw", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, `shields-transition-lock-${sandboxName}.json`);
  fs.writeFileSync(lockPath, "", { mode: 0o600 });
  fs.utimesSync(lockPath, new Date(1_000), new Date(1_000));
  return lockPath;
}

function expectCleanRefusal(out: string): void {
  expect(out).toContain("the owner record is incomplete");
  expect(out).toContain("Recovery:");
  expect(out).toContain("manually");
  expect(out).not.toContain("ShieldsTransitionLockManager");
  expect(out).not.toMatch(/^\s+at /m);
  expect(out).not.toContain("Node.js v");
}

describe("shields commands with a corrupt transition lock", () => {
  it(
    "refuses read-only status without a raw stack trace (#8108)",
    testTimeoutOptions(30_000),
    ({ testHome }) => {
      const { home } = testHome;
      writeSandboxRegistry(home);
      const lockPath = writeCorruptTransitionLock(home, "alpha");

      const startedAt = Date.now();
      const status = runWithEnv("alpha shields status 2>&1", testHome.environment());
      const elapsedMs = Date.now() - startedAt;

      expect(status.code).toBe(1);
      expectCleanRefusal(status.out);
      expect(elapsedMs).toBeLessThan(REFUSAL_BUDGET_MS);
      expect(fs.readFileSync(lockPath, "utf8")).toBe("");
    },
  );

  it(
    "refuses shields up without a raw stack trace (#8108)",
    testTimeoutOptions(30_000),
    ({ testHome }) => {
      const { home } = testHome;
      writeSandboxRegistry(home);
      const lockPath = writeCorruptTransitionLock(home, "alpha");

      const startedAt = Date.now();
      const up = runWithEnv("alpha shields up 2>&1", testHome.environment());
      const elapsedMs = Date.now() - startedAt;

      expect(up.code).toBe(1);
      expectCleanRefusal(up.out);
      expect(elapsedMs).toBeLessThan(REFUSAL_BUDGET_MS);
      expect(fs.readFileSync(lockPath, "utf8")).toBe("");
    },
  );

  it(
    "refuses shields down without a raw stack trace (#8108)",
    testTimeoutOptions(30_000),
    ({ testHome }) => {
      const { home } = testHome;
      writeSandboxRegistry(home);
      const lockPath = writeCorruptTransitionLock(home, "alpha");

      const startedAt = Date.now();
      const down = runWithEnv("alpha shields down --reason test 2>&1", testHome.environment());
      const elapsedMs = Date.now() - startedAt;

      expect(down.code).toBe(1);
      expectCleanRefusal(down.out);
      expect(elapsedMs).toBeLessThan(REFUSAL_BUDGET_MS);
      expect(fs.readFileSync(lockPath, "utf8")).toBe("");
    },
  );
});
