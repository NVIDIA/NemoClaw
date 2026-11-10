// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import ts from "typescript";
import { interactiveWorkloadSource } from "./run-installed-native-console-agent.mts";

const source = interactiveWorkloadSource();
const tree = ts.createSourceFile(
  "interactive.mjs",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const selected: string[] = [];
function visit(node: ts.Node) {
  if (
    (ts.isFunctionDeclaration(node) &&
      ["waitForOwnedNativeAgent", "stopOwnedNativeAgent"].includes(node.name?.text ?? "")) ||
    (ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((item) => item.name.getText(tree) === "observe"))
  ) {
    selected.push(node.getText(tree));
    return;
  }
  ts.forEachChild(node, visit);
}
visit(tree);
const declarations = selected.join("\n");
const helpers = new Function(
  "setTimeout",
  `${declarations}\nreturn {observe, stopOwnedNativeAgent};`,
)(setTimeout);

function child() {
  const events: string[] = [];
  const value = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill() {
      events.push("kill");
      return false;
    },
    unref() {
      events.push("unref");
    },
    stdout: {
      unpipe() {
        events.push("unpipe");
      },
      destroy() {
        events.push("stdout-close");
      },
    },
    stderr: {
      unpipe() {},
      destroy() {
        events.push("stderr-close");
      },
    },
    stdin: {
      destroy() {
        events.push("stdin-close");
      },
    },
  });
  return { value, events };
}

test("Hermes process error and exit events cannot stand in for close", async () => {
  const { value } = child();
  const closed = helpers.observe(value);
  let settled = false;
  void closed.then(() => {
    settled = true;
  });
  value.emit("error", new Error("owned process control failed"));
  value.emit("exit", 0);
  await Promise.resolve();
  assert.equal(settled, false);
  value.emit("close", 0);
  assert.equal(await closed, 1, "a failed process cannot become a successful exit");
});

test("Hermes cleanup does not confirm closure after a failed kill emits error", async () => {
  const { value, events } = child();
  value.kill = () => {
    events.push("kill");
    value.emit("error", new Error("kill failed"));
    return false;
  };
  const stopped = await helpers.stopOwnedNativeAgent(value, helpers.observe(value), 5);
  assert.equal(stopped, false);
  assert(events.includes("unref"));
  assert(events.includes("stdout-close"));
  value.emit("close", 1);
});

test("Hermes cleanup bounds a throwing kill and still waits for actual closure", async () => {
  const { value } = child();
  value.kill = () => {
    throw new Error("kill threw");
  };
  const closed = helpers.observe(value);
  assert.equal(await helpers.stopOwnedNativeAgent(value, closed, 5), false);
  value.emit("close", 1);
  assert.equal(await closed, 1);
});

test("Hermes observer records actual spawned-child close, including spawn failure", async () => {
  for (const executable of [process.execPath, "/missing-hermes-test-executable"]) {
    const value = spawn(executable, ["-e", "process.exit(0)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    let closed = false;
    value.once("close", () => {
      closed = true;
    });
    const code = await helpers.observe(value);
    assert(closed);
    assert.equal(code, executable === process.execPath ? 0 : 1);
  }
});

let messagingCleanup = "";
function findCleanup(node: ts.Node) {
  if (ts.isIfStatement(node) && node.expression.getText(tree) === "messaging") {
    assert.equal(messagingCleanup, "", "one messaging cleanup owner");
    messagingCleanup = node.getText(tree);
  }
  ts.forEachChild(node, findCleanup);
}
findCleanup(tree);
assert(messagingCleanup);

for (const mode of [
  "success",
  "marker-error",
  "marker-throw",
  "spawn-throw",
  "gateway-error",
  "already-exited",
  "absent",
]) {
  test(`Hermes messaging cleanup is bounded and truthful: ${mode}`, { timeout: 1000 }, async () => {
    const gateway = child();
    const marker = child();
    const deadlines: number[] = [];
    const logs: string[] = [];
    const gatewayClosed = helpers.observe(gateway.value);
    const closeGateway = (code: number) => {
      gateway.value.exitCode = code;
      gateway.value.emit("close", code);
    };
    if (mode === "already-exited") {
      gateway.value.exitCode = 7;
      queueMicrotask(() => closeGateway(7));
    }
    marker.value.kill = () => {
      if (mode === "marker-throw") throw new Error("cannot kill marker");
      marker.value.emit("error", new Error("cannot kill marker"));
      return false;
    };
    gateway.value.kill = () => {
      gateway.value.emit("error", new Error("cannot kill gateway"));
      return false;
    };
    const run = new Function(
      "setTimeout",
      "spawn",
      "messaging",
      "messagingExit",
      "console",
      `
      ${declarations}
      const python = "owned-python", home = "owned-home", childEnvironment = {};
      let messagingFailure = false;
      return (async () => { ${messagingCleanup}; return messagingFailure; })();
    `,
    );
    let spawns = 0;
    const failure = await run(
      (callback: () => void, delay: number) => {
        deadlines.push(delay);
        return setTimeout(callback, 5);
      },
      (executable: string, args: string[], options: { stdio: string; windowsHide: boolean }) => {
        spawns++;
        assert.equal(executable, "owned-python");
        assert.equal(args.at(-1), String(gateway.value.pid));
        assert.match(args[1], /get_running_pid\(\)==pid and write_planned_stop_marker\(pid\)/);
        assert.equal(options.stdio, "ignore");
        assert.equal(options.windowsHide, true);
        if (mode === "spawn-throw") {
          queueMicrotask(() => closeGateway(0));
          throw new Error("spawn threw");
        }
        queueMicrotask(() => {
          if (mode === "marker-error") marker.value.emit("error", new Error("marker failed"));
          else if (mode !== "marker-throw") marker.value.emit("close", 0);
          if (mode !== "gateway-error") closeGateway(0);
        });
        return marker.value;
      },
      mode === "absent" ? undefined : gateway.value,
      gatewayClosed,
      {
        error(message: string) {
          logs.push(message);
        },
      },
    );
    assert.equal(failure, !["success", "absent"].includes(mode));
    assert.equal(spawns, ["absent", "already-exited"].includes(mode) ? 0 : 1);
    if (mode !== "absent") assert(deadlines.includes(30000));
    if (["marker-error", "marker-throw", "gateway-error"].includes(mode)) {
      assert(logs.some((message) => message.includes("cleanup deadline")));
      assert(deadlines.includes(10000));
    }
    marker.value.emit("close", 1);
    closeGateway(1);
  });
}
