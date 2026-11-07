// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { preflightNativeGatewayConfig } from "./native-gateway-preflight.mts";
import { NativeGatewaySession } from "./native-gateway-session.mts";
import { writeNativeGatewayConfig } from "./native-security.mts";

test("preflight uses installed bytes, explicit TLS paths and a bounded credential-free process", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preflight-"));
  const executable = path.join(root, "bin", "openshell-gateway.exe");
  fs.mkdirSync(path.dirname(executable));
  fs.writeFileSync(executable, "fixture");
  const privateRoot = path.join(root, "private");
  const config = path.join(root, "config.toml");
  fs.writeFileSync(config, "fixture configuration");
  const secret = "never-expose-validator-detail";
  let calls = 0;
  let result: Record<string, unknown> = { status: 0, signal: null };
  t.mock.method(childProcess, "spawnSync", (file, args, options) => {
    calls++;
    assert.equal(file, executable);
    assert.deepEqual(args, [
      "--compute-driver",
      "mxc",
      "--tls-cert",
      path.join(privateRoot, "tls/server/tls.crt"),
      "--tls-key",
      path.join(privateRoot, "tls/server/tls.key"),
      "--tls-client-ca",
      path.join(privateRoot, "tls/ca.crt"),
      "config",
      "preflight",
      "--path",
      config,
    ]);
    assert.equal(options.timeout, 15_000);
    assert.equal(options.maxBuffer, 64 * 1024);
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, undefined);
    assert.equal(options.env.NEMOCLAW_PREFLIGHT_SECRET, undefined);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    return { stdout: secret, stderr: secret, ...result };
  });
  syncBuiltinESMExports();
  const original = process.env.NEMOCLAW_PREFLIGHT_SECRET;
  process.env.NEMOCLAW_PREFLIGHT_SECRET = secret;
  try {
    preflightNativeGatewayConfig(root, config, privateRoot);
    assert.equal(calls, 1);
    for (result of [
      { status: 1, signal: null },
      { status: null, signal: "SIGTERM" },
      { status: 0, signal: "SIGTERM" },
      { status: 0, error: new Error(secret) },
      { status: null, error: Object.assign(new Error(secret), { code: "ETIMEDOUT" }) },
      { status: null, error: Object.assign(new Error(secret), { code: "ENOBUFS" }) },
      { status: null, error: Object.assign(new Error(secret), { code: "ENOENT" }) },
    ]) {
      const before = calls;
      assert.throws(
        () => preflightNativeGatewayConfig(root, config, privateRoot),
        (error) => {
          assert.match(String(error), /could not validate/u);
          assert(!String(error).includes(secret));
          assert(!String(error).includes(root));
          return true;
        },
      );
      assert.equal(
        calls,
        before + 1,
        "Rejected configuration is not retried with weakened settings",
      );
    }
    assert.equal(fs.readFileSync(config, "utf8"), "fixture configuration");
    assert(!fs.existsSync(privateRoot));
  } finally {
    if (original === undefined) delete process.env.NEMOCLAW_PREFLIGHT_SECRET;
    else process.env.NEMOCLAW_PREFLIGHT_SECRET = original;
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writer propagates runtime rejection without publishing a successful configuration path", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preflight-writer-"));
  const install = path.join(root, "install");
  const run = path.join(root, "run");
  fs.mkdirSync(path.join(install, "config"), { recursive: true });
  fs.mkdirSync(run);
  fs.writeFileSync(
    path.join(install, "config", "mxc-gateway.toml"),
    '[openshell]\nversion = 2\n[openshell.drivers.mxc]\nwxc_exec_path = "stock.exe"\n',
  );
  const session = new NativeGatewaySession(install, run);
  let calls = 0;
  t.mock.method(session, "preflightConfiguration", (file) => {
    calls++;
    const contents = fs.readFileSync(file, "utf8");
    assert.match(contents, /allow_unauthenticated_users = false/u);
    assert.match(contents, /pc_network_allow = false/u);
    throw new Error("fixture runtime configuration rejection");
  });
  try {
    await assert.rejects(
      writeNativeGatewayConfig(install, run, undefined, {}, session),
      /fixture runtime configuration rejection/u,
    );
    assert.equal(calls, 1);
    assert(!fs.existsSync(session.root));
    assert(
      fs.existsSync(path.join(run, "mxc-gateway.toml")),
      "Retain the rejected configuration for caller-owned cleanup",
    );
  } finally {
    await session.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
