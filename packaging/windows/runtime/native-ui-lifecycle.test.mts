// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { NativeGatewaySession } from "./native-gateway-session.mts";
import {
  nativeConsoleFailureCode,
  waitForConsoleAgentExit,
} from "./run-installed-native-console-agent.mts";
import {
  nativeMxcCompletion,
  waitForNativeMxcCompletion,
  watchNativeUiSandbox,
  confirmNativeUiRegistryEmpty,
  requestNativeUiSandboxDeletion,
  attemptNativeUiCleanup,
} from "./native-ui-lifecycle.mts";

const sandboxName = "owned-native-session";
const completed = { type: "Ready", status: "True", reason: "AgentCompleted" };

for (const format of ["conditions", "ready_condition"] as const) {
  function observation(phase: string, status: string, reason: string) {
    const condition = { type: "Ready", status, reason };
    return {
      name: sandboxName,
      phase,
      [format]: format === "conditions" ? [condition] : condition,
    };
  }

  test(`${format} confirms executor completion but not running or generic readiness`, () => {
    assert.equal(
      nativeMxcCompletion(observation("Ready", "True", "AgentCompleted"), sandboxName),
      "AgentCompleted",
    );
    assert.equal(
      nativeMxcCompletion(observation("Error", "False", "ExecFailed"), sandboxName),
      "ExecFailed",
    );
    for (const [phase, status, reason] of [
      ["Ready", "True", "AgentRunning"],
      ["Ready", "True", "DependenciesReady"],
      ["Provisioning", "True", "AgentCompleted"],
      ["Ready", "False", "AgentCompleted"],
      ["Ready", "False", "ExecFailed"],
    ])
      assert.equal(nativeMxcCompletion(observation(phase, status, reason), sandboxName), null);
  });

  test(`${format} preserves sandbox identity and terminal-state rejection`, () => {
    const value = observation("Ready", "True", "AgentCompleted");
    assert.throws(() => nativeMxcCompletion(value, "other-session"), /owned sandbox/u);
    for (const phase of ["Error", "Stopped", "Stopping", "Deleting"])
      assert.throws(
        () => nativeMxcCompletion({ ...value, phase }, sandboxName),
        /without confirming execution cleanup/u,
      );
  });
}

test("upstream lifecycle conditions remain separate from endpoint and health observations", () => {
  const value = {
    name: sandboxName,
    phase: "Ready",
    conditions: [
      { type: "Health", status: "True", reason: "AgentCompleted" },
      {
        ...completed,
        message: "private-message-canary",
        last_transition_time: "2026-10-08T00:00:00Z",
      },
    ],
    endpoint_statuses: [{ last_result: "TransportFailed" }],
  };
  assert.equal(nativeMxcCompletion(value, sandboxName), "AgentCompleted");
  assert.equal(
    nativeMxcCompletion({ ...value, conditions: value.conditions.slice(0, 1) }, sandboxName),
    null,
  );
});

test("upstream conditions cannot fall back to a conflicting legacy completion", () => {
  for (const conditions of [[], [{ ...completed, reason: "AgentRunning" }]])
    assert.equal(
      nativeMxcCompletion(
        { name: sandboxName, phase: "Ready", conditions, ready_condition: completed },
        sandboxName,
      ),
      null,
    );
});

test("malformed and duplicate upstream conditions fail without exposing their content", () => {
  for (const conditions of [
    null,
    {},
    "private-message-canary",
    [null],
    [[]],
    [{}],
    [{ ...completed, status: true }],
    [{ ...completed, reason: null }],
    [completed, completed],
    [completed, { ...completed, reason: "AgentRunning" }],
  ]) {
    assert.throws(
      () =>
        nativeMxcCompletion(
          { name: sandboxName, phase: "Ready", conditions, ready_condition: completed },
          sandboxName,
        ),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /cleanup conditions/u);
        assert(!error.message.includes("private-message-canary"));
        return true;
      },
    );
  }
});

test("missing lifecycle evidence never confirms execution completion", () => {
  for (const extra of [
    {},
    { ready_condition: null },
    { ready_condition: "AgentCompleted" },
    { conditions: [] },
  ])
    assert.equal(
      nativeMxcCompletion({ name: sandboxName, phase: "Ready", ...extra }, sandboxName),
      null,
    );
  for (const value of [null, [], {}, { name: sandboxName }, { name: sandboxName, phase: null }])
    assert.throws(() => nativeMxcCompletion(value, sandboxName), /owned sandbox/u);
});

test("completion polling retains the lease, gateway and deadline gates before launching a probe", async () => {
  const running = { exitCode: null, signalCode: null };
  await assert.rejects(
    waitForNativeMxcCompletion(
      "must-not-launch",
      {},
      sandboxName,
      running,
      null,
      undefined,
      () => {
        throw new Error("Unexpected command");
      },
      AbortSignal.abort(),
    ),
    /cancelled/u,
  );
  await assert.rejects(
    waitForNativeMxcCompletion(
      "must-not-launch",
      {},
      sandboxName,
      running,
      {
        assertHeld() {
          throw new Error("lease revoked");
        },
      },
      undefined,
      () => {
        throw new Error("Unexpected command");
      },
    ),
    /lease revoked/u,
  );
  await assert.rejects(
    waitForNativeMxcCompletion(
      "must-not-launch",
      {},
      sandboxName,
      { ...running, exitCode: 1 },
      null,
      undefined,
      () => {
        throw new Error("Unexpected command");
      },
    ),
    /gateway stopped/u,
  );
  await assert.rejects(
    waitForNativeMxcCompletion("must-not-launch", {}, sandboxName, running, null, 0, () => {
      throw new Error("Unexpected command");
    }),
    /before its deadline/u,
  );
});

function mainExit(exitCode: unknown, phase = "Completed", reason = "MainProcessCompleted") {
  return {
    name: sandboxName,
    phase,
    exit_code: exitCode,
    conditions: [{ type: "Ready", status: "False", reason }],
  };
}

test("canonical main exit remains distinct from legacy executor teardown", () => {
  assert.equal(nativeMxcCompletion(mainExit(0), sandboxName), "MainProcessCompleted");
  for (const exitCode of [1, -1, -2147483648, 2147483647])
    assert.equal(
      nativeMxcCompletion(mainExit(exitCode, "Error", "MainProcessFailed"), sandboxName),
      "MainProcessFailed",
    );
});

test("canonical main exit rejects missing, contradictory and malformed evidence", () => {
  for (const value of [
    ...[undefined, null, "0", false, 1, -1, 0.5].map((code) => mainExit(code)),
    ...[undefined, null, "1", true, 0, 0.5, -2147483649, 2147483648].map((code) =>
      mainExit(code, "Error", "MainProcessFailed"),
    ),
    mainExit(0, "Completed", "MainProcessFailed"),
    mainExit(0, "Completed", "AgentCompleted"),
    { ...mainExit(0), conditions: [] },
    {
      ...mainExit(0),
      conditions: [{ type: "Ready", status: "True", reason: "MainProcessCompleted" }],
    },
    { ...mainExit(0), conditions: undefined, ready_condition: completed },
  ])
    assert.throws(() => nativeMxcCompletion(value, sandboxName));
  assert.throws(() => nativeMxcCompletion(mainExit(0), "another-session"), /owned sandbox/u);
});

// Only the external CLI is a fixture. The production polling and status parser
// run unchanged in the parent; no gateway, sandbox or installed state is used.
function cliFixture(
  statuses: unknown[],
  options: {
    args?: string[];
    commands?: string[][];
    stdout?: string;
    exitCode?: number;
    delayMs?: number;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mxc-lifecycle-"));
  const script = path.join(root, "cli.mjs");
  const calls = path.join(root, "calls.jsonl");
  const children = new Set<childProcess.ChildProcess>();
  fs.writeFileSync(
    script,
    `
    import fs from "node:fs";
    import path from "node:path";
    const calls = ${JSON.stringify(calls)};
    const args = [path.basename(process.argv[1]), ...process.argv.slice(2)];
    const count = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\\n").length : 0;
    fs.appendFileSync(calls, JSON.stringify(args) + "\\n");
    const commands = ${JSON.stringify(options.commands ?? [options.args ?? ["sandbox", "get", sandboxName, "-o", "json"]])};
    if (JSON.stringify(args) !== JSON.stringify(commands[Math.min(count, commands.length - 1)])) process.exit(81);
    const statuses = ${JSON.stringify(statuses)};
    await new Promise(resolve => setTimeout(resolve, ${options.delayMs ?? 0}));
    fs.writeSync(1, ${JSON.stringify(options.stdout)} ?? JSON.stringify(statuses[Math.min(count, statuses.length - 1)]));
    process.exit(${options.exitCode ?? 0});
  `,
  );
  return {
    ownProcess(child: childProcess.ChildProcess) {
      children.add(child);
      child.once("close", () => children.delete(child));
    },
    environment: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      NODE_OPTIONS: `--import=${pathToFileURL(script).href}`,
    },
    calls: () =>
      fs
        .readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    close: () => {
      assert.equal(children.size, 0, "Keep fixture files until command pipes close.");
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const [phase, code, reason] of [
  ["Completed", 0, "MainProcessCompleted"],
  ["Error", 7, "MainProcessFailed"],
] as const) {
  test(`polling observes ${reason} after a running state without deleting the sandbox`, async () => {
    const fixture = cliFixture([
      {
        name: sandboxName,
        phase: "Ready",
        conditions: [{ type: "Ready", status: "True", reason: "AgentRunning" }],
      },
      mainExit(code, phase, reason),
    ]);
    let leaseChecks = 0;
    try {
      assert.equal(
        await waitForNativeMxcCompletion(
          process.execPath,
          fixture.environment,
          sandboxName,
          { exitCode: null, signalCode: null },
          {
            assertHeld() {
              leaseChecks++;
            },
          },
          5000,
          fixture.ownProcess,
        ),
        reason,
      );
      assert.equal(leaseChecks, 4, "Check ownership before and after each status request.");
      assert.deepEqual(
        fixture.calls(),
        Array.from({ length: 2 }, () => ["sandbox", "get", sandboxName, "-o", "json"]),
      );
    } finally {
      fixture.close();
    }
  });
}

for (const revoked of ["lease", "gateway-exit", "gateway-signal"] as const) {
  test(`completion polling rejects ${revoked} during a successful status request`, async () => {
    const fixture = cliFixture([mainExit(0)]);
    const gateway = { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
    let checks = 0;
    try {
      await assert.rejects(
        waitForNativeMxcCompletion(
          process.execPath,
          fixture.environment,
          sandboxName,
          gateway,
          {
            assertHeld() {
              if (++checks !== 2) return;
              if (revoked === "lease") throw new Error("lease revoked during request");
              if (revoked === "gateway-exit") gateway.exitCode = 0;
              else gateway.signalCode = "SIGTERM";
            },
          },
          undefined,
          fixture.ownProcess,
        ),
        revoked === "lease" ? /lease revoked during request/u : /gateway stopped/u,
      );
      assert.equal(fixture.calls().length, 1);
    } finally {
      fixture.close();
    }
  });
}

test("completion polling rejects a successful reply observed after its deadline", async (t) => {
  const fixture = cliFixture([mainExit(0)]);
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  try {
    await assert.rejects(
      waitForNativeMxcCompletion(
        process.execPath,
        fixture.environment,
        sandboxName,
        { exitCode: null, signalCode: null },
        {
          assertHeld() {
            try {
              if (fixture.calls().length) now = 6000;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          },
        },
        5000,
        fixture.ownProcess,
      ),
      /before its deadline/u,
    );
    assert.equal(fixture.calls().length, 1);
  } finally {
    t.mock.restoreAll();
    fixture.close();
  }
});

test("the UI watcher rejects a completed main process while the gateway remains alive", async () => {
  const fixture = cliFixture([mainExit(0)]);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await assert.rejects(
      watchNativeUiSandbox(
        process.execPath,
        fixture.environment,
        sandboxName,
        { exitCode: null, signalCode: null },
        null,
        controller.signal,
        () => {},
      ),
      /session stopped/u,
    );
    assert.equal(fixture.calls().length, 1);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    fixture.close();
  }
});

for (const revoked of ["lease", "gateway-exit", "gateway-signal"] as const) {
  test(`UI polling rejects ${revoked} before interpreting a completed status`, async () => {
    const fixture = cliFixture([mainExit(0)]);
    const gateway = { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let checks = 0;
    try {
      await assert.rejects(
        watchNativeUiSandbox(
          process.execPath,
          fixture.environment,
          sandboxName,
          gateway,
          {
            assertHeld() {
              if (++checks !== 2) return;
              if (revoked === "lease") throw new Error("lease revoked during request");
              if (revoked === "gateway-exit") gateway.exitCode = 0;
              else gateway.signalCode = "SIGTERM";
            },
          },
          controller.signal,
          () => {},
        ),
        revoked === "lease" ? /lease revoked during request/u : /gateway stopped/u,
      );
      assert.equal(fixture.calls().length, 1);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      fixture.close();
    }
  });
}

const listArgs = ["sandbox", "list", "-o", "json"];

test("console diagnostics retain bounded failure codes without child text", () => {
  for (const code of [
    "ECONNREFUSED",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "EACCES",
    "EPERM",
    "ENOENT",
    "EBUSY",
    "ABORT_ERR",
  ]) {
    assert.equal(
      nativeConsoleFailureCode(
        new Error(`The contained native UI connection failed before opening (${code}).`),
      ),
      `UI_CONNECT_${code}`,
    );
    assert.equal(
      nativeConsoleFailureCode(Object.assign(new Error("private-message-canary"), { code })),
      `AGENT_IO_${code}`,
    );
  }
  assert.equal(
    nativeConsoleFailureCode(
      new Error("The native UI relay frame remained locked after 27 bounded attempts."),
    ),
    "UI_FRAME_LOCKED",
  );
  for (const error of [
    null,
    undefined,
    "private-message-canary",
    new Error("private-message-canary"),
    Object.assign(new Error("private-message-canary"), { code: "private-message-canary" }),
  ])
    assert.equal(nativeConsoleFailureCode(error), "AGENT_FAILED");
});

for (const scenario of [
  "published",
  "missing",
  "wrong-agent",
  "invalid-code",
  "contradictory-code",
  "failed",
] as const) {
  test(`console completion reconciles the receipt after its status request: ${scenario}`, async () => {
    const failed = scenario === "failed";
    const status = failed ? mainExit(1, "Error", "MainProcessFailed") : mainExit(0);
    const fixture = cliFixture([status, status]);
    let reads = 0;
    try {
      const receipt = {
        schemaVersion: 1,
        agent: scenario === "wrong-agent" ? "other" : "hermes",
        exitCode: failed ? 1 : 0,
        ...(failed
          ? { failureCode: "UI_CONNECT_EBUSY" }
          : scenario === "invalid-code"
            ? { failureCode: "private-message-canary" }
            : scenario === "contradictory-code"
              ? { failureCode: "AGENT_FAILED" }
              : {}),
      };
      const pending = waitForConsoleAgentExit(
        process.execPath,
        fixture.environment,
        sandboxName,
        { exitCode: null, signalCode: null },
        async () =>
          ++reads === 1 || scenario === "missing" ? null : JSON.stringify(receipt) + "\n",
        "hermes",
        { assertHeld() {} },
        undefined,
        fixture.ownProcess,
      );
      if (scenario === "published") assert.equal(await pending, 0);
      else
        await assert.rejects(pending, (error: unknown) => {
          assert(error instanceof Error);
          assert.match(
            error.message,
            failed
              ? /UI_CONNECT_EBUSY; exit 1/u
              : scenario === "missing"
                ? /before it published an exit receipt/u
                : /exit receipt is invalid/u,
          );
          assert(!error.message.includes("private-message-canary"));
          return true;
        });
      assert.equal(reads, 2);
      assert.equal(fixture.calls().length, scenario === "published" || failed ? 2 : 1);
    } finally {
      fixture.close();
    }
  });
}

for (const failed of [false, true]) {
  test(`console completion binds its command owner and rejects contradictory exit evidence: ${failed}`, async () => {
    const fixture = cliFixture([failed ? mainExit(1, "Error", "MainProcessFailed") : mainExit(0)]);
    try {
      const pending = waitForConsoleAgentExit(
        process.execPath,
        fixture.environment,
        sandboxName,
        { exitCode: null, signalCode: null },
        async () => JSON.stringify({ schemaVersion: 1, agent: "hermes", exitCode: 0 }) + "\n",
        "hermes",
        { assertHeld() {} },
        undefined,
        fixture.ownProcess,
      );
      if (failed) await assert.rejects(pending, /MXC failed after/u);
      else assert.equal(await pending, 0);
      assert.equal(fixture.calls().length, 1);
    } finally {
      fixture.close();
    }
  });
}

for (const receiptPublished of [false, true]) {
  for (const closes of [true, false]) {
    test(`console polling keeps its cancelled command owned until closure: receipt=${receiptPublished}, closes=${closes}`, async (t) => {
      const controller = new AbortController();
      const session = new NativeGatewaySession(
        path.resolve("owned-install"),
        path.resolve("owned-run"),
      );
      let launches = 0;
      let kills = 0;
      let outcome: unknown;
      const child = Object.assign(new EventEmitter(), {
        pid: 987654,
        exitCode: null as number | null,
        signalCode: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => {
          kills++;
          return false;
        },
      });
      t.mock.method(childProcess, "spawn", () => {
        launches++;
        return child;
      });
      t.mock.method(fs, "existsSync", () => false);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      syncBuiltinESMExports();
      try {
        const pending = waitForConsoleAgentExit(
          "owned-cli",
          {},
          sandboxName,
          { exitCode: null, signalCode: null },
          async () =>
            receiptPublished
              ? JSON.stringify({ schemaVersion: 1, agent: "hermes", exitCode: 0 }) + "\n"
              : null,
          "hermes",
          { assertHeld() {} },
          controller.signal,
          session.ownCommandProcess,
        ).then(
          (value) => {
            outcome = value;
          },
          (error) => {
            outcome = error;
          },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(launches, 1);
        controller.abort();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(kills, 1, "Cancellation must reach either pending status command.");
        assert.equal(outcome, undefined);
        if (closes) {
          child.exitCode = 1;
          child.emit("exit", 1, null);
          child.emit("close", 1, null);
        } else t.mock.timers.tick(5000);
        await pending;
        assert(outcome instanceof Error);
        assert.match(
          outcome.message,
          receiptPublished ? /cancelled|did not close/u : /running state could not be confirmed/u,
        );
        assert.equal(launches, 1);
        if (!closes) {
          const disposal = assert.rejects(session.dispose(), /owned process did not stop/u);
          await new Promise<void>((resolve) => setImmediate(resolve));
          t.mock.timers.tick(5000);
          await disposal;
          child.exitCode = 1;
          child.emit("exit", 1, null);
          child.emit("close", 1, null);
        }
        await session.dispose();
      } finally {
        child.exitCode = 1;
        child.emit("exit", 1, null);
        child.emit("close", 1, null);
        t.mock.timers.reset();
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  }
}

for (const operation of ["delete", "registry", "completion"] as const) {
  for (const closes of [true, false]) {
    test(`lifecycle ${operation} retains its timed-out command until closure: ${closes}`, async (t) => {
      const session = new NativeGatewaySession(
        path.resolve("owned-install"),
        path.resolve("owned-run"),
      );
      const gateway = { exitCode: null, signalCode: null };
      const ownership = { sandboxName, gateway, stateSession: null };
      let launches = 0;
      let kills = 0;
      let outcome: unknown;
      const child = Object.assign(new EventEmitter(), {
        pid: 987654,
        exitCode: null as number | null,
        signalCode: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill() {
          kills++;
          return false;
        },
      });
      t.mock.method(childProcess, "spawn", () => {
        launches++;
        return child;
      });
      t.mock.method(fs, "existsSync", () => false);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      syncBuiltinESMExports();
      try {
        const pending =
          operation === "delete"
            ? requestNativeUiSandboxDeletion("owned-cli", {}, ownership, session.ownCommandProcess)
            : operation === "registry"
              ? confirmNativeUiRegistryEmpty("owned-cli", {}, ownership, session.ownCommandProcess)
              : waitForNativeMxcCompletion(
                  "owned-cli",
                  {},
                  sandboxName,
                  gateway,
                  null,
                  undefined,
                  session.ownCommandProcess,
                );
        const finished = pending.then(
          () => {
            outcome = "unexpected success";
          },
          (error) => {
            outcome = error;
          },
        );
        child.stderr.emit("data", Buffer.from("private-command-canary"));
        t.mock.timers.tick(operation === "delete" ? 30_000 : 10_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(kills, 1);
        assert.equal(outcome, undefined, "A timeout is not confirmed command closure.");
        if (closes) {
          child.exitCode = 1;
          child.emit("exit", 1, null);
          child.emit("close", 1, null);
        } else t.mock.timers.tick(5000);
        await finished;
        assert(outcome instanceof Error);
        assert(!String(outcome).includes("private-command-canary"));
        assert.equal(launches, 1, "Never retry an ambiguous deletion or failed read.");
        if (!closes) {
          const disposal = assert.rejects(session.dispose(), /owned process did not stop/u);
          await new Promise<void>((resolve) => setImmediate(resolve));
          t.mock.timers.tick(5000);
          await disposal;
          child.exitCode = 1;
          child.emit("exit", 1, null);
          child.emit("close", 1, null);
        }
        await session.dispose();
      } finally {
        t.mock.timers.reset();
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  }
}

for (const stopped of [true, false]) {
  test(`UI monitor cancellation retains its probe until shutdown is confirmed: ${stopped}`, async (t) => {
    const controller = new AbortController();
    const session = new NativeGatewaySession(
      path.resolve("owned-install"),
      path.resolve("owned-run"),
    );
    const owned: unknown[] = [];
    let settled = false;
    let kills = 0;
    const child = Object.assign(new EventEmitter(), {
      pid: 987654,
      exitCode: null as number | null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill() {
        kills++;
        return true;
      },
    });
    t.mock.method(childProcess, "spawn", () => child);
    t.mock.method(fs, "existsSync", () => false);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    syncBuiltinESMExports();
    try {
      const monitoring = watchNativeUiSandbox(
        "owned-cli",
        {},
        sandboxName,
        { exitCode: null, signalCode: null },
        null,
        controller.signal,
        (process) => {
          owned.push(process);
          session.ownCommandProcess(process);
        },
      ).then(() => {
        settled = true;
      });
      void monitoring.catch(() => {});
      assert.deepEqual(owned, [child]);
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(kills, 1);
      assert.equal(settled, false, "An abort signal alone is not process closure.");
      if (stopped) {
        child.exitCode = 0;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      } else t.mock.timers.tick(5000);
      await monitoring;
      if (!stopped) {
        assert.equal(child.exitCode, null);
        const disposal = assert.rejects(session.dispose(), /owned process did not stop/u);
        await new Promise<void>((resolve) => setImmediate(resolve));
        t.mock.timers.tick(5000);
        await disposal;
        child.exitCode = 0;
        child.emit("exit", 0, null);
        await assert.rejects(session.dispose(), /command pipes did not close/u);
        child.emit("close", 0, null);
      }
      await session.dispose();
    } finally {
      t.mock.timers.reset();
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}
const deleting = { name: sandboxName, phase: "Deleting" };

test("UI shutdown requests deletion before confirming registry absence", async () => {
  const deleteArgs = ["sandbox", "delete", sandboxName];
  // This fixture accepts deletion while running. A premature completion probe fails.
  const fixture = cliFixture([{}, [deleting], []], {
    commands: [deleteArgs, listArgs, listArgs],
  });
  const gateway = { exitCode: null as number | null, signalCode: null };
  let held = true;
  const ownership = {
    sandboxName,
    gateway,
    stateSession: {
      assertHeld() {
        assert(held, "Keep the session lease until removal is confirmed.");
      },
    },
  };
  try {
    await requestNativeUiSandboxDeletion(
      process.execPath,
      fixture.environment,
      ownership,
      fixture.ownProcess,
    );
    assert.deepEqual(fixture.calls(), [deleteArgs]);
    await confirmNativeUiRegistryEmpty(
      process.execPath,
      fixture.environment,
      ownership,
      fixture.ownProcess,
    );
    assert.deepEqual(fixture.calls(), [deleteArgs, listArgs, listArgs]);
    gateway.exitCode = 0;
    held = false;
  } finally {
    fixture.close();
  }
});

test("UI deletion checks ownership before and after its only mutation", async () => {
  for (const revoked of ["lease", "gateway"] as const) {
    for (const atCheck of [1, 2]) {
      const fixture = cliFixture([{}], { args: ["sandbox", "delete", sandboxName] });
      const gateway = { exitCode: null as number | null, signalCode: null };
      let checks = 0;
      try {
        await assert.rejects(
          requestNativeUiSandboxDeletion(
            process.execPath,
            fixture.environment,
            {
              sandboxName,
              gateway,
              stateSession: {
                assertHeld() {
                  if (++checks === atCheck) {
                    if (revoked === "lease") throw new Error("lease revoked");
                    gateway.exitCode = 1;
                  }
                },
              },
            },
            fixture.ownProcess,
          ),
          revoked === "lease" ? /lease revoked/u : /gateway stopped/u,
        );
        if (atCheck === 1) assert.throws(() => fixture.calls(), { code: "ENOENT" });
        else assert.deepEqual(fixture.calls(), [["sandbox", "delete", sandboxName]]);
      } finally {
        fixture.close();
      }
    }
  }
});

test("a rejected UI create confirms absence without requesting deletion", async () => {
  for (const registry of [[], [deleting], [{ name: "foreign-session", phase: "Ready" }]]) {
    const fixture = cliFixture([registry], { args: listArgs });
    try {
      const operation = requestNativeUiSandboxDeletion(
        process.execPath,
        fixture.environment,
        {
          sandboxName,
          gateway: { exitCode: null, signalCode: null },
          stateSession: null,
          creationRejected: true,
        },
        fixture.ownProcess,
      );
      if (registry.length === 0) await operation;
      else await assert.rejects(operation, /not confirmed empty/u);
      assert.deepEqual(fixture.calls(), [listArgs]);
    } finally {
      fixture.close();
    }
  }
});

test("failed UI deletion remains a cleanup failure without retry or command output disclosure", async () => {
  const fixture = cliFixture([{}], {
    args: ["sandbox", "delete", sandboxName],
    stdout: "private-delete-canary",
    exitCode: 1,
  });
  let subsequentCleanup = false;
  try {
    const failures = await attemptNativeUiCleanup([
      [
        "sandbox deletion",
        async () => {
          try {
            await requestNativeUiSandboxDeletion(
              process.execPath,
              fixture.environment,
              {
                sandboxName,
                gateway: { exitCode: null, signalCode: null },
                stateSession: null,
              },
              fixture.ownProcess,
            );
          } catch (error) {
            assert(error instanceof Error);
            assert.match(error.message, /deletion request could not be confirmed/u);
            assert(!error.message.includes("private-delete-canary"));
            throw error;
          }
        },
      ],
      [
        "remaining cleanup",
        () => {
          subsequentCleanup = true;
        },
      ],
    ]);
    assert.deepEqual(failures, ["sandbox deletion"]);
    assert(subsequentCleanup);
    assert.deepEqual(fixture.calls(), [["sandbox", "delete", sandboxName]]);
  } finally {
    fixture.close();
  }
});

test("registry confirmation accepts the complete upstream envelope and waits for deletion", async () => {
  const fixture = cliFixture(
    [
      { sandboxes: [deleting], next_page_token: "" },
      { sandboxes: [], next_page_token: "" },
    ],
    { args: listArgs },
  );
  try {
    await confirmNativeUiRegistryEmpty(
      process.execPath,
      fixture.environment,
      {
        sandboxName,
        gateway: { exitCode: null, signalCode: null },
        stateSession: null,
        timeout: 5000,
      },
      fixture.ownProcess,
    );
    assert.deepEqual(fixture.calls(), [listArgs, listArgs]);
    await confirmNativeUiRegistryEmpty(
      process.execPath,
      fixture.environment,
      undefined,
      fixture.ownProcess,
    );
  } finally {
    fixture.close();
  }
});

test("registry confirmation rejects incomplete pages and malformed upstream envelopes", async () => {
  for (const reply of [
    { sandboxes: [] },
    { sandboxes: [], next_page_token: null },
    { sandboxes: [], next_page_token: "private-page-canary" },
    { sandboxes: [deleting], next_page_token: "private-page-canary" },
    { sandboxes: null, next_page_token: "" },
    { next_page_token: "" },
  ]) {
    const fixture = cliFixture([reply, { sandboxes: [], next_page_token: "" }], { args: listArgs });
    try {
      await assert.rejects(
        confirmNativeUiRegistryEmpty(
          process.execPath,
          fixture.environment,
          {
            sandboxName,
            gateway: { exitCode: null, signalCode: null },
            stateSession: null,
            timeout: 5000,
          },
          fixture.ownProcess,
        ),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.match(error.message, /not confirmed empty/u);
          assert(!error.message.includes("private-page-canary"));
          return true;
        },
      );
      assert.equal(fixture.calls().length, 1);
    } finally {
      fixture.close();
    }
  }
});

test("registry confirmation waits for owned deletion without repeating the mutation", async () => {
  const fixture = cliFixture([[deleting], []], { args: listArgs });
  let leaseChecks = 0;
  try {
    await confirmNativeUiRegistryEmpty(
      process.execPath,
      fixture.environment,
      {
        sandboxName,
        gateway: { exitCode: null, signalCode: null },
        stateSession: {
          assertHeld() {
            leaseChecks++;
          },
        },
        timeout: 5000,
      },
      fixture.ownProcess,
    );
    assert.deepEqual(fixture.calls(), [listArgs, listArgs]);
    assert.equal(leaseChecks, 4, "Recheck ownership before and after each external probe.");
  } finally {
    fixture.close();
  }
});

test("one-shot empty-registry confirmation does not wait past retained entries", async () => {
  const fixture = cliFixture([[deleting], []], { args: listArgs });
  try {
    await assert.rejects(
      confirmNativeUiRegistryEmpty(
        process.execPath,
        fixture.environment,
        undefined,
        fixture.ownProcess,
      ),
      /not confirmed empty/u,
    );
    assert.equal(fixture.calls().length, 1);
  } finally {
    fixture.close();
  }
});

test("registry polling rejects malformed and foreign records without exposing their contents", async () => {
  for (const registry of [
    null,
    {},
    "private-canary",
    [null],
    [{}],
    [{ name: "private-canary", phase: "Deleting" }],
    [deleting, deleting],
    [{ ...deleting, phase: "Ready" }],
    [{ ...deleting, phase: "Completed" }],
  ]) {
    const fixture = cliFixture([registry, []], { args: listArgs });
    try {
      await assert.rejects(
        confirmNativeUiRegistryEmpty(
          process.execPath,
          fixture.environment,
          {
            sandboxName,
            gateway: { exitCode: null, signalCode: null },
            stateSession: null,
            timeout: 5000,
          },
          fixture.ownProcess,
        ),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.match(error.message, /not confirmed empty/u);
          assert(!error.message.includes("private-canary"));
          return true;
        },
      );
      assert.equal(fixture.calls().length, 1);
    } finally {
      fixture.close();
    }
  }
});

test("registry confirmation rejects failed commands and invalid JSON without retrying", async () => {
  for (const options of [
    { stdout: "private-canary", exitCode: 1 },
    { stdout: "private-canary" },
    { stdout: "[]", exitCode: 1 },
  ]) {
    const fixture = cliFixture([[]], { ...options, args: listArgs });
    try {
      await assert.rejects(
        confirmNativeUiRegistryEmpty(
          process.execPath,
          fixture.environment,
          {
            sandboxName,
            gateway: { exitCode: null, signalCode: null },
            stateSession: null,
            timeout: 5000,
          },
          fixture.ownProcess,
        ),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.match(error.message, /could not be read/u);
          assert(!error.message.includes("private-canary"));
          return true;
        },
      );
      assert.equal(fixture.calls().length, 1);
    } finally {
      fixture.close();
    }
  }
});

test("registry confirmation rejects lease loss and gateway exit during a successful empty probe", async () => {
  for (const revoked of ["lease", "gateway"] as const) {
    const fixture = cliFixture([[]], { args: listArgs });
    const gateway = { exitCode: null as number | null, signalCode: null };
    let checks = 0;
    try {
      await assert.rejects(
        confirmNativeUiRegistryEmpty(
          process.execPath,
          fixture.environment,
          {
            sandboxName,
            gateway,
            timeout: 5000,
            stateSession: {
              assertHeld() {
                if (++checks === 2) {
                  if (revoked === "lease") throw new Error("lease revoked");
                  gateway.exitCode = 1;
                }
              },
            },
          },
          fixture.ownProcess,
        ),
        revoked === "lease" ? /lease revoked/u : /gateway stopped/u,
      );
      assert.equal(fixture.calls().length, 1);
    } finally {
      fixture.close();
    }
  }
});

test("registry confirmation bounds retained deletion and a stalled CLI", async () => {
  for (const delayMs of [0, 5000]) {
    const fixture = cliFixture([[deleting]], { args: listArgs, delayMs });
    const started = Date.now();
    try {
      await assert.rejects(
        confirmNativeUiRegistryEmpty(
          process.execPath,
          fixture.environment,
          {
            sandboxName,
            gateway: { exitCode: null, signalCode: null },
            stateSession: null,
            timeout: 500,
          },
          fixture.ownProcess,
        ),
        /deadline/u,
      );
      assert(Date.now() - started < 5000);
    } finally {
      fixture.close();
    }
  }
  await assert.rejects(
    confirmNativeUiRegistryEmpty(
      "must-not-launch",
      {},
      {
        sandboxName,
        gateway: { exitCode: null, signalCode: null },
        stateSession: null,
        timeout: 0,
      },
      () => {
        throw new Error("Unexpected command");
      },
    ),
    /deadline/u,
  );
});
