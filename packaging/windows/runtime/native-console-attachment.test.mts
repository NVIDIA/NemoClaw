// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import {
  openNativeConsoleAttachment,
  reconcileNativeConsoleExit,
} from "./native-console-attachment.mts";

test("terminal attachment uses the authenticated CLI environment and inherited console", async (t) => {
  const actualSpawn = childProcess.spawn;
  const environment = { SystemRoot: process.env.SystemRoot, PRIVATE_SESSION: "fixture" };
  let calls = 0;
  const expectedOptions = {
    env: environment,
    stdio: "inherit",
    windowsHide: false,
  } satisfies SpawnOptions;
  t.mock.method(
    childProcess,
    "spawn",
    (file: string, args: readonly string[], options: SpawnOptions) => {
      calls++;
      assert.equal(file, "C:\\NemoClaw\\openshell.exe");
      assert.deepEqual(args, ["sandbox", "connect", "owned-sandbox"]);
      assert.deepEqual(options, expectedOptions);
      // Real child exit and retained inherited stdin; the OpenShell transport itself
      // is covered by the runtime's authenticated public-client integration test.
      return actualSpawn(
        process.execPath,
        ["-e", "setTimeout(() => process.exit(7), 20)"],
        options,
      );
    },
  );
  syncBuiltinESMExports();
  try {
    const attachment = openNativeConsoleAttachment(
      "C:\\NemoClaw\\openshell.exe",
      "owned-sandbox",
      environment,
    );
    assert.equal(await attachment.waitForExit(), 7);
    assert.equal(await attachment.exited, 7);
    await attachment.dispose();
    assert.equal(calls, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("terminal spawn and signal failures do not expose raw process errors", async (t) => {
  const secret = "private-process-error";
  for (const mode of ["error", "signal"] as const) {
    const child = new EventEmitter();
    t.mock.method(childProcess, "spawn", () => child);
    syncBuiltinESMExports();
    try {
      const attachment = openNativeConsoleAttachment("fixture.exe", "sandbox", {});
      if (mode === "error") child.emit("error", new Error(secret));
      child.emit("close", null, mode === "signal" ? "SIGTERM" : null);
      await assert.rejects(attachment.exited, (error) => {
        assert(error instanceof Error);
        assert(!error.message.includes(secret));
        assert.match(error.message, /terminal client/u);
        return true;
      });
      await attachment.dispose();
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  }
});

test("terminal drain times out without killing only the CLI", async (t) => {
  const child = Object.assign(new EventEmitter(), {
    kill() {
      assert.fail("A direct CLI kill cannot prove its OpenSSH descendants stopped");
    },
  });
  t.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();
  try {
    const attachment = openNativeConsoleAttachment("fixture.exe", "sandbox", {});
    await assert.rejects(attachment.waitForExit(10), /did not finish/u);
    child.emit("close", 0, null);
    assert.equal(await attachment.waitForExit(), 0);
    await attachment.dispose();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("terminal cleanup returns an undrained client to the native process owner", async (t) => {
  let unreferenced = false;
  const child = Object.assign(new EventEmitter(), {
    unref() {
      unreferenced = true;
    },
    kill() {
      assert.fail("The native process owner must stop the complete descendant tree");
    },
  });
  t.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();
  try {
    const attachment = openNativeConsoleAttachment("fixture.exe", "sandbox", {});
    const failure = new Error("fixture drain timeout");
    t.mock.method(attachment, "waitForExit", async () => {
      throw failure;
    });
    await assert.rejects(attachment.dispose(), (error) => error === failure);
    assert.equal(unreferenced, true);
    child.emit("close", 0, null);
    assert.equal(await attachment.exited, 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("console completion requires matching statuses in either exit order", async () => {
  for (const first of ["client", "agent"] as const) {
    for (const code of [0, 23]) {
      let finish!: (code: number) => void;
      const delayed = new Promise<number>((resolve) => {
        finish = resolve;
      });
      const result = reconcileNativeConsoleExit(
        first === "client" ? Promise.resolve(code) : delayed,
        first === "agent" ? Promise.resolve(code) : delayed,
      );
      finish(code);
      assert.equal(await result, code);
    }
    for (const [client, agent] of [
      [0, 23],
      [23, 0],
    ]) {
      let finish!: (code: number) => void;
      const delayed = new Promise<number>((resolve) => {
        finish = resolve;
      });
      const result = reconcileNativeConsoleExit(
        first === "client" ? Promise.resolve(client) : delayed,
        first === "agent" ? Promise.resolve(agent) : delayed,
      );
      await Promise.resolve();
      finish(first === "client" ? agent : client);
      await assert.rejects(result, /different exit statuses/u);
    }
  }
});

test("console completion rejects detach, stalled drain and either observer failure", async () => {
  const pending = new Promise<number>(() => {});
  await assert.rejects(
    reconcileNativeConsoleExit(Promise.resolve(0), pending, 10),
    /disconnected before the contained agent finished/u,
  );
  await assert.rejects(
    reconcileNativeConsoleExit(pending, Promise.resolve(0), 10),
    /did not finish after the contained agent exited/u,
  );
  for (const first of ["client", "agent"] as const) {
    const failure = new Error("fixture observer failed");
    await assert.rejects(
      reconcileNativeConsoleExit(
        first === "client" ? Promise.reject(failure) : pending,
        first === "agent" ? Promise.reject(failure) : pending,
      ),
      (error) => error === failure,
    );
  }
});
