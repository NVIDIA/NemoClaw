// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import {
  acquireNativeStateInspection,
  acquireNativeStateConfiguration,
  acquireNativeStateSession,
} from "./native-state.mts";

const realSpawn = childProcess.spawn;

async function withOwner(record: unknown, operation: () => Promise<void>, exitCode = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-state-inspection-"));
  const script = path.join(root, "owner.cjs");
  fs.writeFileSync(
    script,
    `process.stdout.write(process.argv[2]+'\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(${exitCode}));`,
  );
  const calls: string[][] = [];
  const replacement = test.mock.method(
    childProcess,
    "spawn",
    (_file: string, args: readonly string[], options: unknown) => {
      calls.push([...args]);
      return realSpawn(
        process.execPath,
        [script, typeof record === "string" ? record : JSON.stringify(record)],
        options as childProcess.SpawnOptionsWithoutStdio,
      );
    },
  );
  syncBuiltinESMExports();
  try {
    await operation();
    return calls;
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const receipt = (present = true) => ({
  schemaVersion: 1,
  kind: "native-state-inspection",
  agent: "openclaw",
  stateRoot: "C:\\NemoClawState-S-1-5-21-1001-openclaw",
  present,
  leaseHeld: true,
});

for (const present of [false, true]) {
  test(`inspection retains its owner for ${present ? "present" : "absent"} state and releases once`, async () => {
    const calls = await withOwner(receipt(present), async () => {
      const owner = await acquireNativeStateInspection("fixture", "openclaw");
      assert.equal(owner.present, present);
      assert.equal(owner.created, false);
      owner.assertHeld();
      await Promise.all([owner.release(), owner.release()]);
      assert.throws(() => owner.assertHeld(), /lease is closed/);
    });
    assert.deepEqual(calls, [["--state-inspect", "openclaw"]]);
  });
}

test("inspection rejects creating, wrong-owner, ambiguous and oversized receipts", async () => {
  for (const value of [
    { ...receipt(), kind: "native-state-configuration", created: true },
    { ...receipt(), present: undefined },
    { ...receipt(), present: "false" },
    { ...receipt(), leaseHeld: false },
    { ...receipt(), created: false },
    { ...receipt(), removed: false },
    { ...receipt(), agent: "hermes" },
    { ...receipt(), stateRoot: "C:\\NemoClawState-S-1-5-21-1001-hermes" },
    { ...receipt(), stateRoot: "C:\\Users\\data-openclaw" },
    "not-json",
    "x".repeat(4097),
  ])
    await withOwner(value, async () => {
      await assert.rejects(
        acquireNativeStateInspection("fixture", "openclaw"),
        /receipt|unavailable/,
      );
    });
});

test("inspection readiness cannot satisfy an ordinary configuration or session lease", async () => {
  await withOwner(receipt(), async () => {
    await assert.rejects(acquireNativeStateConfiguration("fixture", "openclaw"), /receipt/);
    await assert.rejects(acquireNativeStateSession("fixture", "openclaw"), /receipt/);
  });
});

test("ordinary configuration and session receipts retain their existing contracts", async () => {
  for (const mode of ["configuration", "session"] as const) {
    const value = {
      schemaVersion: 1,
      kind: `native-state-${mode}`,
      agent: "openclaw",
      stateRoot: receipt().stateRoot,
      created: true,
      leaseHeld: true,
    };
    await withOwner(value, async () => {
      const owner = await (
        mode === "configuration" ? acquireNativeStateConfiguration : acquireNativeStateSession
      )("fixture", "openclaw");
      assert.equal(owner.created, true);
      assert.equal(Object.hasOwn(owner, "present"), false);
      await owner.release();
    });
  }
});

test("inspection release failure is not reported as successful cleanup", async () => {
  await withOwner(
    receipt(),
    async () => {
      const owner = await acquireNativeStateInspection("fixture", "openclaw");
      await assert.rejects(owner.release(), /did not restore/);
      assert.throws(() => owner.assertHeld(), /lease is closed/);
    },
    3,
  );
});

test("unsupported inspection purposes are rejected before starting an owner", async () => {
  const calls = await withOwner(receipt(), async () => {
    for (const purpose of ["inference", "pi", "../openclaw", "unknown"])
      await assert.rejects(acquireNativeStateInspection("fixture", purpose), /supported/);
  });
  assert.deepEqual(calls, []);
});

for (const agent of ["openclaw", "hermes"]) {
  test(`${agent} retained owner can unref its actual pipes without releasing its live lease`, async () => {
    await withOwner(
      {
        schemaVersion: 1,
        kind: "native-state-session",
        agent,
        stateRoot: `C:\\NemoClawState-S-1-5-21-1001-${agent}`,
        created: true,
        leaseHeld: true,
      },
      async () => {
        const owner = await acquireNativeStateSession("fixture", agent);
        try {
          owner.unrefWithoutRelease();
          owner.unrefWithoutRelease();
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          owner.assertHeld();
        } finally {
          await owner.release();
        }
        assert.throws(() => owner.assertHeld(), /lease is closed/u);
      },
    );
  });
}
