// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";
import {
  interactiveWorkloadSource,
  nativeHermesMessagingArguments,
} from "./run-installed-native-console-agent.mts";

const expected = {
  telegram: ["telegram.ext", "telegram.request"],
  discord: ["discord.ext.commands"],
  slack: [
    "slack_bolt.async_app",
    "slack_bolt.adapter.socket_mode.async_handler",
    "slack_sdk.web.async_client",
  ],
};

function python(source: string) {
  const result = spawnSync("python3", ["-I", "-S", "-c", source], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 65536,
    env: { PATH: process.env.PATH },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

for (const [channel, modules] of Object.entries(expected)) {
  test(
    `Hermes ${channel} preflight detects absent SDKs without lazy installation`,
    { skip: process.platform === "win32" },
    () => {
      const [flag, source] = nativeHermesMessagingArguments([channel]);
      assert.equal(flag, "-c");
      const result = python(source);
      assert.equal(result.status, 78);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    },
  );

  test(
    `Hermes ${channel} preflight checks its SDKs then starts the real gateway entrypoint`,
    { skip: process.platform === "win32" },
    () => {
      const source = nativeHermesMessagingArguments([channel])[1];
      const result = python(`
import importlib, runpy, json
seen = []
def load(name):
    seen.append(name)
importlib.import_module = load
def start(name, **kwargs):
    print(json.dumps({'modules': seen, 'entry': name, **kwargs}))
runpy.run_module = start
${source}
`);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        modules,
        entry: "gateway.run",
        run_name: "__main__",
        alter_sys: true,
      });
    },
  );
}

test("Hermes messaging preflight rejects unknown or empty selections and deduplicates modules", () => {
  for (const channels of [[], ["__proto__"], ["constructor"], ["telegram", "unknown"]])
    assert.throws(() => nativeHermesMessagingArguments(channels), /unsupported/);
  assert.deepEqual(
    nativeHermesMessagingArguments(["telegram", "telegram"]),
    nativeHermesMessagingArguments(["telegram"]),
  );
});

test(
  "Hermes messaging import failures stay distinct from errors inside the gateway",
  { skip: process.platform === "win32" },
  () => {
    const source = nativeHermesMessagingArguments(["slack"])[1];
    for (const failure of ["ImportError", "OSError"]) {
      const result = python(`
import importlib, runpy
def load(name):
    raise ${failure}('private diagnostic must not leave preflight')
importlib.import_module = load
runpy.run_module = lambda *args, **kwargs: print('must not launch')
${source}
`);
      assert.equal(result.status, 78);
      assert.equal(result.stdout + result.stderr, "");
    }
    const result = python(`
import importlib, runpy
importlib.import_module = lambda name: None
def start(*args, **kwargs):
    raise ImportError('gateway initialization failed')
runpy.run_module = start
${source}
`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gateway initialization failed/);
  },
);

test("the generated workload uses the SDK preflight and a specific repair diagnostic", () => {
  const source = interactiveWorkloadSource();
  const tree = ts.createSourceFile(
    "worker.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let declaration = "";
  let failure = "";
  let launch = "";
  function visit(node: ts.Node) {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (item) => item.name.getText(tree) === "nativeHermesMessagingArguments",
      )
    )
      declaration = node.getText(tree);
    if (ts.isIfStatement(node) && node.expression.getText(tree) === "!connected")
      failure = node.getText(tree);
    if (
      ts.isBinaryExpression(node) &&
      node.left.getText(tree) === "messaging" &&
      ts.isCallExpression(node.right)
    )
      launch = node.right.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert(declaration && failure && launch);
  const generated = new Function(`${declaration}; return nativeHermesMessagingArguments;`)();
  assert.deepEqual(
    generated(["telegram", "slack"]),
    nativeHermesMessagingArguments(["telegram", "slack"]),
  );
  assert.match(launch, /^spawn\(python, nativeHermesMessagingArguments\(selectedChannels\),/);
  const check = new Function("messaging", `const connected = false; ${failure}`);
  assert.throws(() => check({ exitCode: 78 }), /Repair Hermes in NemoClaw Setup/);
  for (const exitCode of [null, 1, 0])
    assert.throws(() => check({ exitCode }), /bot key, app permissions, and network/);
});
