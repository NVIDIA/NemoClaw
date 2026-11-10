// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { openNativeWebSession } from "./native-web-session.mts";

const realSpawn = childProcess.spawn;

for (const agent of ["openclaw", "hermes"] as const) {
  for (const code of [0, 23]) {
    test(`${agent} completion ${code === 0 ? "accepts zero" : "rejects nonzero"} UI exit`, async (t) => {
      let child: ReturnType<typeof realSpawn> | undefined;
      const replacement = t.mock.method(childProcess, "spawn", (_file, _args, options) => {
        child = realSpawn(
          process.execPath,
          [
            "-e",
            `
            process.stdout.write('{"kind":"ready"}\\n');
            process.stdin.resume();
            process.stdin.on('end', () => process.exit(${code}));
          `,
          ],
          { ...options, env: {} },
        );
        return child;
      });
      syncBuiltinESMExports();
      try {
        const session = await openNativeWebSession("fixture-installation", agent);
        if (code === 0) await session.complete(true);
        else {
          await assert.rejects(session.complete(true), /did not close successfully/u);
          await assert.rejects(session.complete(false), /did not close successfully/u);
        }
        assert.equal(child?.exitCode, code);
        assert.equal(replacement.mock.callCount(), 1);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
          child.kill();
          await closed;
        }
        replacement.mock.restore();
        syncBuiltinESMExports();
      }
    });
  }
}

async function controlledSession(t: TestContext) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {
      kills++;
      child.emit("close", 0);
      return true;
    },
  });
  let kills = 0;
  const records: { kind?: string }[] = [];
  child.stdin.on("data", (chunk: Buffer) => records.push(JSON.parse(chunk.toString("utf8"))));
  const replacement = t.mock.method(childProcess, "spawn", () => {
    queueMicrotask(() => child.stdout.write('{"kind":"ready"}\n'));
    return child as unknown as ReturnType<typeof realSpawn>;
  });
  syncBuiltinESMExports();
  t.after(() => {
    child.emit("close", 1);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    replacement.mock.restore();
    syncBuiltinESMExports();
  });
  const session = await openNativeWebSession("fixture-installation", "hermes");
  return { child, session, records, kills: () => kills };
}

test("successful completion rejects a signal-only close", async (t) => {
  const { child, session } = await controlledSession(t);
  const completed = session.complete(true);
  await Promise.resolve();
  child.emit("close", null, "SIGTERM");
  await assert.rejects(completed, /did not close successfully/u);
});

test("completion timeout cannot become success even when the child reports zero", async (t) => {
  const { session, kills } = await controlledSession(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const completed = session.complete(true);
  const rejected = assert.rejects(completed, /did not close successfully/u);
  await Promise.resolve();
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(kills(), 1);
});

test("failure notice stays open until closure and completion sends one failure record", async (t) => {
  const { child, session, records, kills } = await controlledSession(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const completed = session.complete(false).then(() => {
    settled = true;
  });
  const repeated = session.complete(true);
  await Promise.resolve();
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(kills(), 0);
  assert.deepEqual(
    records.filter((record) => record.kind),
    [{ kind: "failed" }],
  );
  child.emit("close", 1);
  await Promise.all([completed, repeated]);
  assert.equal(settled, true);
});

test("protocol failure remains the primary error when completion also exits nonzero", async (t) => {
  const { child, session } = await controlledSession(t);
  child.stdout.write('{"kind":"invalid"}\n');
  const completed = session.complete(true);
  await Promise.resolve();
  child.emit("close", 23);
  await assert.rejects(completed, /control stopped unexpectedly/u);
  assert.equal(session.signal.aborted, true);
});

test("failure notice timeout rejects instead of reporting deliberate closure", async (t) => {
  const { session, kills } = await controlledSession(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const completed = session.complete(false);
  const rejected = assert.rejects(completed, /did not close successfully/u);
  await Promise.resolve();
  t.mock.timers.tick(24 * 60 * 60_000);
  await rejected;
  assert.equal(kills(), 1);
});
