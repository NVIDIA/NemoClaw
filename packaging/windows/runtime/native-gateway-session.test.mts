// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { NativeGatewaySession } from "./native-gateway-session.mts";
import { writeNativeGatewayConfig } from "./native-security.mts";
import { run } from "./run-installed-native-turn.mts";

const helper = process.env.NEMOCLAW_GATEWAY_TLS_CONTROL;
const options = { skip: !helper || process.platform !== "win32", timeout: 30_000 };
const template = '[openshell.drivers.mxc]\nwxc_exec_path = "fixture.exe"\n';

test("installed provider imports without qualification entry points", () => {
  const provider = new URL("./installed-runtime-provider.mts", import.meta.url).href;
  const script = [
    'import { registerHooks } from "node:module";',
    "registerHooks({",
    "  resolve(specifier, context, nextResolve) {",
    '    if (specifier.includes("/run-installed-") && specifier.endsWith(".mts"))',
    '      throw new Error("blocked qualification entry: " + specifier);',
    "    return nextResolve(specifier, context);",
    "  },",
    "});",
    "const provider = await import(" + JSON.stringify(provider) + ");",
    'if (typeof provider.openInstalledRuntimeSession !== "function")',
    '  throw new Error("installed provider factory is missing");',
    'process.stdout.write("provider-import-without-qualification\\n");',
  ].join("\n");
  const output = childProcess.execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  assert.equal(output, "provider-import-without-qualification\n");
});

test("gateway command refuses to spawn without a process owner", async (t) => {
  t.mock.method(childProcess, "spawn", () => {
    throw new Error("must not spawn");
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(run("fixture", [], {}, "owned command"), /requires an owner/u);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("gateway command refuses an already cancelled request without spawning", async (t) => {
  const controller = new AbortController();
  controller.abort();
  let owned = false;
  t.mock.method(childProcess, "spawn", () => {
    throw new Error("must not spawn");
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      run(
        "fixture",
        [],
        {},
        "owned command",
        100,
        undefined,
        () => {
          owned = true;
        },
        {
          signal: controller.signal,
        },
      ),
      /cancelled/u,
    );
    assert.equal(owned, false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

for (const fault of [
  "timeout",
  "unconfirmed",
  "abort",
  "abort-unconfirmed",
  "overflow",
  "unicode-overflow",
  "owner",
  "diagnostic",
  "success",
] as const) {
  test(`gateway command keeps process custody through ${fault}`, async (t) => {
    const controller = new AbortController();
    const primary = new Error("owned callback failure");
    const owned: unknown[] = [];
    let kills = 0;
    let progressMessages = 0;
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
    t.mock.method(childProcess, "spawn", () => child);
    t.mock.method(console, "log", () => {
      progressMessages++;
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    syncBuiltinESMExports();
    let outcome: { error?: unknown; value?: unknown } | undefined;
    try {
      const completion = run(
        "fixture",
        [],
        {},
        "owned command",
        100,
        {
          capture() {
            if (fault === "diagnostic") throw primary;
          },
        },
        (process) => {
          owned.push(process);
          if (fault === "owner") throw primary;
        },
        { signal: controller.signal, quiet: true },
      ).then(
        (value) => {
          outcome = { value };
        },
        (error) => {
          outcome = { error };
        },
      );
      assert.deepEqual(owned, [child]);
      assert.equal(progressMessages, 0, "Background probes do not emit progress messages.");
      if (fault === "timeout" || fault === "unconfirmed") t.mock.timers.tick(100);
      else if (fault === "abort" || fault === "abort-unconfirmed") controller.abort();
      else if (fault === "overflow") child.stdout.emit("data", Buffer.alloc(1024 * 1024 + 1, 65));
      else if (fault === "unicode-overflow")
        child.stdout.emit("data", Buffer.from("é".repeat(512 * 1024 + 1)));
      else if (fault === "diagnostic") child.stdout.emit("data", Buffer.from("fixture"));
      else if (fault === "success") {
        const output = Buffer.from("completed 🌍");
        child.stdout.emit("data", output.subarray(0, output.length - 2));
        child.stdout.emit("data", output.subarray(output.length - 2));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(outcome, undefined, "Do not settle while the process is unconfirmed.");
      assert.equal(kills, fault === "success" ? 0 : 1);
      if (fault === "unconfirmed" || fault === "abort-unconfirmed") {
        t.mock.timers.tick(5000);
        await completion;
        assert.match(String(outcome?.error), /owned process did not close/u);
        assert.equal(child.exitCode, null);
        assert.match(
          String((outcome?.error as Error).cause),
          fault === "unconfirmed" ? /timed out/u : /cancelled/u,
        );
      } else {
        child.exitCode = 0;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
        await completion;
        if (fault === "success")
          assert.deepEqual(outcome?.value, { exitCode: 0, stdout: "completed 🌍", stderr: "" });
        else if (fault === "owner" || fault === "diagnostic") assert.equal(outcome?.error, primary);
        else
          assert.match(
            String(outcome?.error),
            fault === "timeout" ? /timed out/u : fault === "abort" ? /cancelled/u : /output limit/u,
          );
      }
      assert.equal(kills, fault === "success" ? 0 : 1);
    } finally {
      t.mock.timers.reset();
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}

test("gateway command owner retains the session until its command pipes close", async (t) => {
  const session = new NativeGatewaySession(
    path.resolve("owned-install"),
    path.resolve("owned-run"),
  );
  const child = Object.assign(new EventEmitter(), {
    pid: 987654,
    exitCode: null as number | null,
    signalCode: null,
    kill: () => false,
  });
  t.mock.method(fs, "existsSync", () => false);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    session.ownCommandProcess(child as unknown as childProcess.ChildProcess);
    const disposal = assert.rejects(session.dispose(), /owned process did not stop/u);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(5000);
    await disposal;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await assert.rejects(session.dispose(), /command pipes did not close/u);
    assert.doesNotThrow(() => session.ownCommandProcess);
    child.emit("close", 0, null);
    await session.dispose();
    assert.throws(() => session.ownCommandProcess, /disposed/u);
  } finally {
    t.mock.timers.reset();
    t.mock.restoreAll();
  }
});

test("gateway command owner retires completed polling children only after close", () => {
  const session = new NativeGatewaySession(
    path.resolve("owned-install"),
    path.resolve("owned-run"),
  );
  // The registry is the memory owner for long-running polling sessions.
  const children = (session as unknown as { children: Set<childProcess.ChildProcess> }).children;
  for (let index = 0; index < 100; index++) {
    const child = new EventEmitter() as childProcess.ChildProcess;
    session.ownCommandProcess(child);
    assert.equal(children.size, 1);
    child.emit("exit", 0, null);
    assert.equal(children.size, 1, "Process exit does not establish pipe closure.");
    child.emit("close", 0, null);
    assert.equal(children.size, 0);
  }
});

test("gateway writer rejects authentication overrides before probing and writes owned paths", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-control-"));
  const install = path.join(root, "install");
  const run = path.join(root, "run");
  const session = new NativeGatewaySession(install, run);
  const validated: string[] = [];
  t.mock.method(session, "preflightConfiguration", (file: string) => {
    validated.push(file);
  });
  let probes = 0;
  const profile = async () => {
    probes++;
    return {};
  };
  try {
    fs.mkdirSync(path.join(install, "config"), { recursive: true });
    fs.mkdirSync(run);
    const input = path.join(install, "config", "mxc-gateway.toml");
    fs.writeFileSync(
      input,
      template + "[openshell.gateway.auth]\nallow_unauthenticated_users = true\n",
    );
    await assert.rejects(
      writeNativeGatewayConfig(install, run, undefined, profile, session),
      /cannot override/u,
    );
    assert.equal(probes, 0);
    assert.deepEqual(validated, []);
    assert.deepEqual(fs.readdirSync(run), []);
    fs.writeFileSync(input, template);
    const output = await writeNativeGatewayConfig(install, run, undefined, profile, session);
    const rendered = fs.readFileSync(output, "utf8");
    assert.deepEqual(validated, [output]);
    assert.equal(probes, 1);
    assert(rendered.includes(`state_dir = ${JSON.stringify(path.join(session.root, "mxc"))}`));
    assert(rendered.includes("allow_unauthenticated_users = false"));
    assert(!fs.existsSync(session.root), "Configuration validation does not create credentials.");
    await assert.rejects(writeNativeGatewayConfig(install, run, undefined, {}, session), /EEXIST/u);
    assert.equal(fs.readFileSync(output, "utf8"), rendered);
  } finally {
    await session.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "gateway session removes partial credentials after a file write failure",
  options,
  async (t) => {
    const { root, session } = fixture();
    const write = fs.writeFileSync;
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
      if (String(args[0]) === path.join(session.root, "tls", "client", "tls.key"))
        throw new Error("fixture credential write failure");
      return write(...args);
    });
    try {
      await assert.rejects(session.prepare(), /fixture credential write failure/u);
      assert(fs.existsSync(path.join(session.root, "tls", "server", "tls.key")));
      assert.throws(() => session.environment, /not ready/u);
      await session.dispose();
      assert(!fs.existsSync(session.root));
    } finally {
      t.mock.restoreAll();
      await session.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-session-control-"));
  const install = path.join(root, "install-$&");
  const ui = path.join(install, "native-ui");
  const bin = path.join(install, "bin");
  fs.mkdirSync(ui, { recursive: true });
  fs.mkdirSync(bin);
  const directory = path.dirname(helper!);
  for (const name of fs.readdirSync(directory)) {
    const source = path.join(directory, name);
    if (fs.statSync(source).isFile()) {
      fs.copyFileSync(source, path.join(ui, name));
      fs.copyFileSync(source, path.join(bin, name));
    }
  }
  fs.copyFileSync(helper!, path.join(ui, "NemoClaw.Bootstrapper.exe"));
  fs.copyFileSync(helper!, path.join(bin, "openshell-gateway.exe"));
  const session = new NativeGatewaySession(install, path.join(root, "run"));
  return { root, install, session };
}

test("gateway session admits its authenticated workload configuration and owns supervisor paths", () => {
  const session = new NativeGatewaySession(path.resolve("install-$&"), path.resolve("run"));
  const config = session.configuration(template);
  assert(
    config.includes(
      JSON.stringify(path.join(path.resolve("install-$&"), "bin", "openshell-supervisor.exe")),
    ),
  );
  assert(config.includes(`state_dir = ${JSON.stringify(path.join(session.root, "mxc"))}`));
  assert(config.includes("disable_tls = false"));
  assert(config.includes("allow_unauthenticated_users = false"));
  assert(config.includes("[openshell.gateway.mtls_auth]\nenabled = true"));
  assert(config.includes("[openshell.drivers.mxc]\nallow_driver_config = true\n"));
  for (const override of [
    "[openshell.gateway]",
    "allow_driver_config = true",
    "allow_driver_config = false",
    "state_dir = 'other'",
    "supervisor_binary_path = 'other'",
    "sandbox_binary_path = 'other'",
  ])
    assert.throws(() => session.configuration(template + override), /cannot override/u);
  assert.throws(() => session.configuration("[other]\n"), /MXC driver section/u);
  assert.throws(() => session.environment, /not ready/u);
});

test(
  "gateway session keeps keys private and removes them after its owned child stops",
  options,
  async (t) => {
    const { root, install, session } = fixture();
    try {
      await session.prepare();
      const environment = session.environment;
      assert.deepEqual(Object.keys(environment).sort(), [
        "OPENSHELL_LOCAL_TLS_DIR",
        "XDG_CONFIG_HOME",
        "XDG_STATE_HOME",
      ]);
      for (const directory of Object.values(environment)) {
        assert(directory?.startsWith(session.root + path.sep));
        assert(fs.statSync(directory!).isDirectory());
      }
      const jwt = path.join(session.root, "tls", "jwt");
      const privateKey = createPrivateKey(fs.readFileSync(path.join(jwt, "signing.pem")));
      const publicKey = createPublicKey(fs.readFileSync(path.join(jwt, "public.pem")));
      assert.equal(privateKey.asymmetricKeyType, "ed25519");
      const message = Buffer.from("gateway-session-control");
      assert(verify(null, message, publicKey, sign(null, message, privateKey)));
      assert.match(fs.readFileSync(path.join(jwt, "kid"), "utf8"), /^[a-f0-9]{32}\n$/u);
      assert(fs.statSync(path.join(session.root, "mxc")).isDirectory());
      await assert.rejects(session.prepare(), /cannot be reused/u);
      assert.throws(
        () => session.spawnGateway(process.execPath, [], {}),
        /not the installed gateway/u,
      );
      assert.throws(
        () =>
          session.spawnGateway(path.join(install, "bin", "openshell-gateway.exe"), [], {
            shell: true,
          }),
        /cannot use a shell/u,
      );
      const child = session.spawnGateway(
        path.join(install, "bin", "openshell-gateway.exe"),
        ["--fixture-wait"],
        {
          env: process.env,
          windowsHide: true,
          stdio: "ignore",
        },
      );
      assert.throws(
        () => session.spawnGateway(path.join(install, "bin", "openshell-gateway.exe"), [], {}),
        /already owns/u,
      );
      const deadline = Date.now() + 5000;
      while (
        !fs.existsSync(path.join(session.root, "gateway-stopped.json.started")) &&
        Date.now() < deadline
      )
        await delay(20);
      const gatewayPid = session.gatewayProcessId;
      assert.notEqual(gatewayPid, child.pid, "The recorded gateway is not its owner wrapper.");
      assert.doesNotThrow(() => process.kill(gatewayPid, 0));
      const stop = path.join(session.root, "gateway.stop");
      const write = fs.writeFileSync;
      let partialWriteObserved = false;
      t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
        if (String(args[0]) !== stop && String(args[0]) !== stop + ".pending")
          return write(...args);
        const nonce = String(args[1]);
        const fd = fs.openSync(String(args[0]), "wx", 0o600);
        try {
          fs.writeSync(fd, nonce.slice(0, 24));
          // The native reader continues while this test thread holds half a write.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
          assert(!fs.existsSync(stop), "A partial nonce must not be published.");
          assert.doesNotThrow(() => process.kill(gatewayPid, 0));
          fs.writeSync(fd, nonce.slice(24));
          partialWriteObserved = true;
        } finally {
          fs.closeSync(fd);
        }
      });
      await session.dispose();
      assert.equal(partialWriteObserved, true);
      assert(child.exitCode !== null || child.signalCode !== null);
      assert(!fs.existsSync(session.root));
      assert.throws(() => session.environment, /not ready/u);
      assert.throws(() => process.kill(gatewayPid, 0), { code: "ESRCH" });
      assert.equal(
        await session.stopGateway(),
        true,
        "Verified cleanup remains idempotent after private state removal.",
      );
      await session.dispose();
    } finally {
      t.mock.restoreAll();
      await session.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("gateway session refuses an existing directory and preserves its data", options, async () => {
  const { root, session } = fixture();
  fs.mkdirSync(session.root);
  const retained = path.join(session.root, "retained.txt");
  fs.writeFileSync(retained, "existing-content", { flag: "wx" });
  try {
    await assert.rejects(session.prepare(), /already exists/u);
    await assert.rejects(session.dispose(), /unowned and was retained/u);
    assert.equal(fs.readFileSync(retained, "utf8"), "existing-content");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const fault of ["malformed", "oversized", "stderr", "timeout"] as const)
  test(`gateway session rejects ${fault} helper output without exposing it`, options, async (t) => {
    const { root, session } = fixture();
    const spawn = childProcess.spawn;
    const secret = "PRIVATE_TEST_MATERIAL_MUST_NOT_ESCAPE";
    const child = Object.assign(new EventEmitter(), {
      pid: 987654,
      exitCode: null as number | null,
      signalCode: null as string | null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => {
        child.signalCode = "SIGTERM";
        setImmediate(() => {
          child.emit("exit", null, "SIGTERM");
          child.emit("close", null, "SIGTERM");
        });
        return true;
      },
    });
    t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
      if (!String(args[0]).endsWith("NemoClaw.Bootstrapper.exe")) return spawn(...args);
      if (fault === "timeout") {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        setImmediate(() => t.mock.timers.tick(15_000));
        return child;
      }
      setImmediate(() => {
        if (fault === "stderr") child.stderr.emit("data", Buffer.from(secret));
        else
          child.stdout.emit(
            "data",
            Buffer.from(fault === "oversized" ? secret.repeat(1000) : secret),
          );
        child.exitCode = 0;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(session.prepare(), (error: unknown) => {
        assert(error instanceof Error);
        assert(!error.message.includes(secret));
        assert.match(error.message, /certificate helper/u);
        return true;
      });
      assert(fs.existsSync(session.root), "Failure remains owned until explicit cleanup.");
      await session.dispose();
      assert(!fs.existsSync(session.root));
    } finally {
      t.mock.restoreAll();
      t.mock.timers.reset();
      syncBuiltinESMExports();
      await session.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test(
  "gateway session retains credentials until an owned process has stopped",
  options,
  async (t) => {
    const { root, install, session } = fixture();
    const child = Object.assign(new EventEmitter(), {
      pid: 987654,
      exitCode: null as number | null,
      signalCode: null,
      kill: () => false,
    });
    let ownerArguments: string[] = [];
    try {
      await session.prepare();
      t.mock.method(childProcess, "spawn", (_file: string, args: string[]) => {
        ownerArguments = args;
        return child;
      });
      syncBuiltinESMExports();
      session.spawnGateway(path.join(install, "bin", "openshell-gateway.exe"), [], {});
      const stop = ownerArguments[1]!;
      fs.writeFileSync(stop, "existing-stop-content", { flag: "wx" });
      await assert.rejects(session.dispose(), /process did not stop/u);
      assert.equal(fs.readFileSync(stop, "utf8"), "existing-stop-content");
      assert(fs.existsSync(path.join(session.root, "tls", "client", "tls.key")));
      // Remove only this fixture's conflict before checking the separate timeout.
      fs.unlinkSync(stop);
      fs.unlinkSync(stop + ".pending");
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const completion = assert.rejects(session.dispose(), /process did not stop/u);
      // Completed preparation children need no timers; the owned live child does.
      await new Promise<void>((resolve) => setImmediate(resolve));
      t.mock.timers.tick(5000);
      await completion;
      assert(fs.existsSync(path.join(session.root, "tls", "client", "tls.key")));
      child.exitCode = 0;
      t.mock.timers.reset();
      await assert.rejects(session.dispose(), /process did not stop/u);
      fs.writeFileSync(
        ownerArguments[2]!,
        JSON.stringify({
          schemaVersion: 1,
          nonce: ownerArguments[3],
          activeProcesses: 0,
          stopped: true,
          requested: true,
          gatewayExitCode: 0,
        }),
        { flag: "wx" },
      );
      await session.dispose();
      assert(!fs.existsSync(session.root));
      fs.mkdirSync(session.root);
      fs.writeFileSync(path.join(session.root, "replacement.txt"), "not-owned", { flag: "wx" });
      await session.dispose();
      assert.equal(
        fs.readFileSync(path.join(session.root, "replacement.txt"), "utf8"),
        "not-owned",
      );
    } finally {
      child.exitCode = 0;
      t.mock.timers.reset();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await session.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
