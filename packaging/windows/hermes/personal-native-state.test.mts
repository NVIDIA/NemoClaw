// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  acquirePersonalNativeState,
  personalNativeStateReceipt,
  readPersonalStateOwnerBuild,
  readRequestedPersonalStateOwnerBuild,
  finishPersonalStateOwnership,
} from "./personal-native-state.mts";
import { personalRequest } from "./probe-personal-candidate.mts";
import { fileIdentity } from "./probe-component-workload.mts";
import { verifyNativeEdgeIdentityLauncher } from "../runtime/native-edge-browser.mts";

const root = "C:\\NemoClawState-S-1-5-21-100-200-300-1001-hermes";

test("native state build selection rejects every historical diagnostic mode before reading inputs", () => {
  assert.equal(readRequestedPersonalStateOwnerBuild(null, {}, []), null);
  for (let index = 0; index < 5; index++) {
    const modes = Array.from({ length: 5 }, (_, item) => item === index);
    assert.throws(
      () => readRequestedPersonalStateOwnerBuild("must-not-read", {}, modes),
      /not historical/u,
    );
  }
});

test("Personal final cleanup propagates native state custody to the outer runtime removal gate", async () => {
  for (const scenario of [
    "disabled",
    "not-acquired",
    "acquisition-unknown",
    "prepare-cleaned",
    "before-executor",
    "closed-executor",
    "unclosed-executor",
    "release-failed",
  ] as const) {
    const receipt = personalNativeStateReceipt();
    receipt.sessionAttempted = !["disabled", "not-acquired"].includes(scenario);
    receipt.complete = scenario === "prepare-cleaned";
    const calls: boolean[] = [];
    const acquired = [
      "before-executor",
      "closed-executor",
      "unclosed-executor",
      "release-failed",
    ].includes(scenario);
    const result = await finishPersonalStateOwnership({
      enabled: scenario !== "disabled",
      receipt,
      state: acquired
        ? {
            stateRoot: root,
            assertHeld() {},
            finish: async (closed: boolean) => {
              calls.push(closed);
              if (scenario === "release-failed") throw new Error("release failed");
              return closed;
            },
          }
        : undefined,
      resourceOwnerAttempted: ["closed-executor", "unclosed-executor", "release-failed"].includes(
        scenario,
      ),
      allClosed: ["closed-executor", "release-failed"].includes(scenario),
    });
    const safe = !["acquisition-unknown", "unclosed-executor", "release-failed"].includes(scenario);
    assert.equal(result.complete, safe, scenario);
    assert.equal(result.allClosed, safe && scenario !== "disabled", scenario);
    assert.equal(result.resourceOwnerAttempted, receipt.sessionAttempted, scenario);
    assert.deepEqual(calls, acquired ? [scenario !== "unclosed-executor"] : [], scenario);
    assert.equal(result.errors.length, scenario === "release-failed" ? 1 : 0, scenario);
  }
});

function fixture() {
  const events: string[] = [];
  const receipt = personalNativeStateReceipt();
  const inspection = {
    stateRoot: root,
    present: false,
    assertHeld: () => events.push("inspect-held"),
    release: async () => {
      events.push("inspect-release");
    },
  };
  const session = {
    stateRoot: root,
    created: true,
    unrefWithoutRelease: () => {
      events.push("session-unref");
    },
    assertHeld: () => events.push("session-held"),
    release: async () => {
      events.push("session-release");
    },
  };
  const removal = {
    stateRoot: root,
    removed: true,
    assertHeld: () => events.push("remove-held"),
    release: async () => {
      events.push("remove-release");
    },
  };
  const bind = (launcher: string, agent: string) => {
    assert.equal(launcher, "owned-launcher");
    assert.equal(agent, "hermes");
  };
  const owner = {
    inspect: async (launcher: string, agent: string) => {
      bind(launcher, agent);
      events.push("inspect");
      return inspection;
    },
    session: async (launcher: string, agent: string) => {
      bind(launcher, agent);
      events.push("session");
      return session;
    },
    remove: async (launcher: string, agent: string) => {
      bind(launcher, agent);
      events.push("remove");
      return removal;
    },
    mkdir: (directory: string) => {
      events.push("mkdir:" + directory);
    },
  };
  const open = () => acquirePersonalNativeState("owned-launcher", "C:\\", receipt, owner);
  return { events, receipt, inspection, session, removal, owner, open };
}

test("Personal owns a fresh native state lease through child shutdown and removes only afterward", async () => {
  const f = fixture();
  const state = await f.open();
  assert.equal(state.stateRoot, root);
  assert.deepEqual(f.events, [
    "inspect",
    "inspect-held",
    "inspect-release",
    "session",
    "session-held",
    "mkdir:" + root + "\\home",
    "mkdir:" + root + "\\temp",
  ]);
  assert.equal(f.receipt.created, true);
  assert.equal(f.receipt.retained, true);
  assert.equal(await state.finish(false), false);
  assert.equal(f.receipt.ownerUnreferenced, true);
  assert.equal(f.events.filter((event) => event === "session-unref").length, 1);
  assert.equal(await state.finish(false), false);
  assert.equal(f.events.filter((event) => event === "session-unref").length, 1);
  assert(!f.events.includes("session-release"));
  assert(!f.events.includes("remove"));
  state.assertHeld();
  assert.equal(await state.finish(true), true);
  assert.equal(await state.finish(true), true);
  assert.deepEqual(f.events.slice(-5), [
    "session-held",
    "session-release",
    "remove",
    "remove-held",
    "remove-release",
  ]);
  assert.equal(f.events.filter((event) => event === "remove").length, 1);
  assert.equal(f.receipt.complete, true);
  assert.equal(f.receipt.retained, false);
});

test("Personal refuses existing Hermes state without acquiring a mutating session", async () => {
  const f = fixture();
  f.inspection.present = true;
  await assert.rejects(f.open, /refuses existing/u);
  assert.deepEqual(f.events, ["inspect", "inspect-held", "inspect-release"]);
  assert.equal(f.receipt.sessionAttempted, false);
});

for (const stateRoot of [
  "C:\\NemoClawMsysProof-1234567890ab-state-start",
  root.replace("C:", "D:"),
  root + "\\child",
]) {
  test(`Personal refuses a noncanonical or wrong-drive inspection root: ${stateRoot}`, async () => {
    const f = fixture();
    f.inspection.stateRoot = stateRoot;
    await assert.rejects(f.open, /different native state identity/u);
    assert.deepEqual(f.events, ["inspect", "inspect-held", "inspect-release"]);
  });
}

test("Personal never creates state after uncertain inspection closure", async () => {
  const f = fixture();
  f.inspection.release = async () => {
    throw new Error("inspection close failed");
  };
  await assert.rejects(f.open, /inspection close failed/u);
  assert.equal(f.receipt.inspectionClosed, false);
  assert.equal(f.receipt.sessionAttempted, false);
});

for (const changed of ["existing", "different-root"] as const) {
  test(`Personal refuses an acquisition race without deleting state: ${changed}`, async () => {
    const f = fixture();
    if (changed === "existing") f.session.created = false;
    else f.session.stateRoot = root.replace("1001-hermes", "1002-hermes");
    await assert.rejects(f.open, /did not exclusively create/u);
    assert.equal(f.receipt.sessionReleased, true);
    assert.equal(f.receipt.created, false);
    assert.equal(f.receipt.retained, true);
    assert(!f.events.includes("remove"));
    assert(!f.events.some((event) => event.startsWith("mkdir:")));
  });
}

test("Personal retains uncertain state after a failed native session acquisition", async () => {
  const f = fixture();
  f.owner.session = async () => {
    throw new Error("readiness lost");
  };
  await assert.rejects(f.open, /readiness lost/u);
  assert.equal(f.receipt.sessionAttempted, true);
  assert.equal(f.receipt.retained, true);
  assert.equal(f.receipt.created, false);
  assert(!f.events.includes("remove"));
});

test("Personal cleans a confirmed new root when child-directory creation fails before execution", async () => {
  const f = fixture();
  f.owner.mkdir = () => {
    throw new Error("mkdir failed");
  };
  await assert.rejects(f.open, /mkdir failed/u);
  assert.equal(f.receipt.complete, true);
  assert.deepEqual(f.events.slice(-4), [
    "session-release",
    "remove",
    "remove-held",
    "remove-release",
  ]);
});

test("Personal preserves both preparation and cleanup failures", async () => {
  const f = fixture();
  f.owner.mkdir = () => {
    throw new Error("mkdir failed");
  };
  f.session.release = async () => {
    throw new Error("lease close failed");
  };
  await assert.rejects(f.open, (error: unknown) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((item: Error) => item.message),
      ["mkdir failed", "lease close failed"],
    );
    return true;
  });
  assert(!f.events.includes("remove"));
  assert.equal(f.receipt.retained, true);
});

test("Personal never attempts removal after a failed session release", async () => {
  const f = fixture();
  const state = await f.open();
  f.session.release = async () => {
    throw new Error("ACL restoration failed");
  };
  await assert.rejects(() => state.finish(true), /ACL restoration failed/u);
  await assert.rejects(() => state.finish(true), /ACL restoration failed/u);
  assert.equal(f.receipt.sessionReleased, false);
  assert.equal(f.receipt.removalAttempted, false);
  assert.equal(f.receipt.complete, false);
});

for (const changed of ["different-root", "not-removed", "release-failed"] as const) {
  test(`Personal cannot report cleanup success for an invalid removal receipt: ${changed}`, async () => {
    const f = fixture();
    const state = await f.open();
    if (changed === "different-root")
      f.removal.stateRoot = root.replace("1001-hermes", "1002-hermes");
    if (changed === "not-removed") f.removal.removed = false;
    if (changed === "release-failed")
      f.removal.release = async () => {
        throw new Error("removal close failed");
      };
    await assert.rejects(() => state.finish(true), /removal|remove/u);
    assert.equal(f.receipt.complete, false);
    assert.equal(f.receipt.retained, true);
    assert.equal(f.receipt.removalReleased, changed !== "release-failed");
  });
}

test("Personal request carries the native owner's authority accepted by the actual Python adapter", async () => {
  const f = fixture();
  const state = await f.open();
  try {
    const request = personalRequest(
      "C:\\node\\node.exe",
      "C:\\node\\worker.mts",
      "C:\\runtime",
      "C:\\NemoClawMsysProof-1234567890ab-state-start",
      "1234567890abcdef12345678",
      "C:\\Windows",
      "C:\\runtime\\mxc-compat",
      state.stateRoot,
    );
    const env = Object.fromEntries(
      request.process.env.map((item) => [
        item.slice(0, item.indexOf("=")),
        item.slice(item.indexOf("=") + 1),
      ]),
    );
    assert.equal(env.NEMOCLAW_AGENT_HOME, root);
    assert.equal(env.HERMES_HOME, root + "\\home");
    assert.equal(env.TEMP, root + "\\temp");
    assert.equal(request.process.cwd, root);
    assert.deepEqual(request.filesystem.readwritePaths, [root]);
    assert(request.process.commandLine.includes(`"${root}\\result.json"`));
    assert(!request.process.commandLine.includes("NemoClawMsysProof-"));
    assert.equal(env.NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD, "hermes-query");
    assert.equal(env.NEMOCLAW_MSYS_TOKEN_INSPECTION, undefined);
    assert.equal(env.NEMOCLAW_HERMES_PRIVATE_DESKTOP, undefined);
    assert.deepEqual(request.processContainer.capabilities, []);
    assert.deepEqual(request.network, {
      egress: { default: "deny" },
      ingress: { default: "deny", hostLoopback: "deny" },
    });
    assert.equal(request.fallback.allowDaclMutation, false);
    const source = fileURLToPath(new URL("./nemoclaw_native_windows.py", import.meta.url));
    const script = `import importlib.util,json,sys
from pathlib import PureWindowsPath
s=importlib.util.spec_from_file_location('adapter',sys.argv[1])
m=importlib.util.module_from_spec(s)
s.loader.exec_module(m)
env=json.loads(sys.argv[2])
print(json.dumps([str(p) for p in m._owned_state_walk(PureWindowsPath(env['HERMES_HOME']),env['NEMOCLAW_AGENT_HOME'])]))
`;
    const result = spawnSync(
      process.env.NEMOCLAW_TEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
      ["-I", "-B", "-c", script, source, JSON.stringify(env)],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.deepEqual(JSON.parse(result.stdout), [root, root + "\\home"]);
  } finally {
    await state.finish(true);
  }
});

test("current Personal request satisfies the actual Python same-run packaging admission", () => {
  const request = personalRequest(
    "C:\\node\\node.exe",
    "C:\\node\\worker.mts",
    "C:\\NemoClawHermesProbe-001122334455",
    "C:\\NemoClawMsysProof-001122334455-state-start",
    "00112233445566778899aabb",
    "C:\\Windows",
    undefined,
    "C:\\NemoClawState-S-1-5-21-111-222-333-1001-hermes",
  );
  const fixture = fileURLToPath(
    new URL("../installer/test_prepare_finished_hermes.py", import.meta.url),
  );
  const script = `import importlib.util,json,sys,tempfile
from pathlib import Path
s=importlib.util.spec_from_file_location('intake_fixture',sys.argv[1])
m=importlib.util.module_from_spec(s)
s.loader.exec_module(m)
fixture=m.FinishedHermesIntake()
fixture.setUp()
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory)
    _,personal,_=fixture.state_owner_fixture(root)
    raw=m.owner.validate_same_run_state_owner(root,personal,json.loads(sys.argv[2]),fixture.pin['sourceRevision'],'123','2')
    assert raw==(root/'state-owner-build.json').read_bytes()
print('request admitted')
`;
  const result = spawnSync(
    process.env.NEMOCLAW_TEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
    ["-I", "-B", "-c", script, fixture, JSON.stringify(request)],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stdout.trim(), "request admitted");
});

test("Personal state-owner admission binds source files, same run, exact path and ARM64 executable bytes", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "personal-owner-build-"));
  let launcherDescriptor: number | undefined;
  try {
    const source = path.join(temporary, "source");
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    for (const name of ["Cargo.toml", "Cargo.lock", "src/main.rs", "src/state_session.rs"])
      fs.writeFileSync(path.join(source, name), "explicit unit fixture: " + name);
    const launcher = path.join(
      temporary,
      "official-hermes-runtime-build",
      "state-owner-helper",
      "NemoClaw.exe",
    );
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    // A non-executable parser fixture, never launched or admitted as CI evidence.
    const bytes = Buffer.alloc(128);
    bytes.write("MZ");
    bytes.writeUInt32LE(64, 60);
    bytes.write("PE\0\0", 64);
    bytes.writeUInt16LE(0xaa64, 68);
    const compiled = path.join(temporary, "cargo", "NemoClaw.exe");
    fs.mkdirSync(path.dirname(compiled));
    fs.writeFileSync(compiled, bytes);
    fs.linkSync(compiled, path.join(temporary, "cargo-output-alias.exe"));
    assert.throws(
      () => verifyNativeEdgeIdentityLauncher(fileIdentity(compiled)),
      /traverse a link/u,
    );
    const materialize = spawnSync(
      process.env.NEMOCLAW_TEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
      [
        "-I",
        "-B",
        fileURLToPath(new URL("../installer/materialize-compiled-executable.py", import.meta.url)),
        "--source",
        compiled,
        "--output",
        launcher,
        "--receipt",
        path.join(path.dirname(launcher), "materialization.json"),
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(materialize.status, 0, materialize.stderr || String(materialize.error));
    assert.equal(fs.statSync(compiled).nlink, 2);
    launcherDescriptor = fs.openSync(launcher, "r+");
    assert.equal(fs.fstatSync(launcherDescriptor).nlink, 1);
    assert.deepEqual(fs.readFileSync(launcherDescriptor), bytes);
    assert.equal(verifyNativeEdgeIdentityLauncher(fileIdentity(launcher)), launcher);
    const build = {
      schemaVersion: 1,
      classification: "personal-native-state-owner-build",
      sourceRevision: "a".repeat(40),
      workflowRunId: "123",
      workflowRunAttempt: "1",
      target: "aarch64-pc-windows-msvc",
      immutableRuntime: false,
      buildProcessesClosed: true,
      file: launcher,
      bytes: bytes.length,
      sha256: fileIdentity(launcher).sha256,
      sources: ["Cargo.toml", "Cargo.lock", "src/main.rs", "src/state_session.rs"].map((file) => ({
        file,
        bytes: fileIdentity(path.join(source, file)).bytes,
        sha256: fileIdentity(path.join(source, file)).sha256,
      })),
    };
    const receipt = path.join(temporary, "state-owner-build.json");
    const read = (value: unknown) => {
      fs.writeFileSync(receipt, JSON.stringify(value));
      return readPersonalStateOwnerBuild(receipt, "a".repeat(40), "123", "1", source);
    };
    const readFile = fs.readFileSync;
    t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
      assert.notEqual(args[0], receipt, "The receipt pathname must not be reopened.");
      return readFile(...args);
    });
    const admitted = read(build);
    assert.equal(admitted.launcher, launcher);
    assert.deepEqual(admitted.receipt, {
      path: receipt,
      bytes: Buffer.byteLength(JSON.stringify(build)),
      sha256: createHash("sha256").update(JSON.stringify(build)).digest("hex"),
      peMachine: null,
      architecture: "non-PE-or-unknown",
    });
    for (const [key, value] of Object.entries({
      schemaVersion: "1",
      classification: "other",
      sourceRevision: "b".repeat(40),
      workflowRunId: "124",
      workflowRunAttempt: "2",
      target: "x86_64-pc-windows-msvc",
      immutableRuntime: true,
      buildProcessesClosed: "true",
      file: launcher + ".other",
      bytes: 1,
      sha256: "b".repeat(64),
      sources: build.sources.slice(1),
    }))
      assert.throws(() => read({ ...build, [key]: value }), undefined, key);
    assert.throws(() => read({ ...build, sources: [...build.sources, build.sources[0]] }));
    fs.appendFileSync(path.join(source, "src/state_session.rs"), "changed");
    assert.throws(() => read(build));
    fs.writeFileSync(
      path.join(source, "src/state_session.rs"),
      "explicit unit fixture: src/state_session.rs",
    );
    bytes.writeUInt16LE(0x8664, 68);
    fs.writeSync(launcherDescriptor, bytes, 0, bytes.length, 0);
    assert.throws(() => read({ ...build, sha256: fileIdentity(launcher).sha256 }));
  } finally {
    if (launcherDescriptor !== undefined) fs.closeSync(launcherDescriptor);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

for (const scenario of [
  "redirected",
  "different-file",
  "oversized",
  "growth",
  "truncated",
  "path-replaced",
  "invalid-json",
] as const) {
  test(`Personal receipt admission rejects ${scenario} and closes its held descriptor`, (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "personal-owner-receipt-"));
    const receipt = path.join(temporary, "receipt.json");
    fs.writeFileSync(receipt, scenario === "invalid-json" ? "{" : "{}");
    const open = fs.openSync;
    const close = fs.closeSync;
    const lstat = fs.lstatSync;
    const read = fs.readSync;
    let held: number | undefined;
    let closed = false;
    let readBytes = 0;
    let changed = false;
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      const descriptor = open(...args);
      if (args[0] === receipt && args[1] === "r") held = descriptor;
      return descriptor;
    });
    t.mock.method(fs, "closeSync", (descriptor: number) => {
      if (descriptor === held) closed = true;
      return close(descriptor);
    });
    t.mock.method(fs, "lstatSync", (...args: Parameters<typeof lstat>) => {
      const info = Reflect.apply(lstat, fs, args);
      if (args[0] !== receipt) return info;
      if (scenario === "redirected") info.isSymbolicLink = () => true;
      if (scenario === "different-file") info.ino += typeof info.ino === "bigint" ? 1n : 1;
      return info;
    });
    t.mock.method(
      fs,
      "readSync",
      (descriptor: number, buffer: Buffer, offset: number, length: number, position: number) => {
        if (descriptor === held && !changed) {
          changed = true;
          if (scenario === "growth") fs.appendFileSync(receipt, Buffer.alloc(1024 * 1024 + 1));
          if (scenario === "truncated") fs.truncateSync(receipt, 0);
        }
        const count = read(descriptor, buffer, offset, length, position);
        if (descriptor === held && scenario === "path-replaced" && readBytes === 0) {
          fs.renameSync(receipt, receipt + ".previous");
          fs.writeFileSync(receipt, "{}");
        }
        if (descriptor === held) readBytes += count;
        return count;
      },
    );
    try {
      if (scenario === "oversized") fs.appendFileSync(receipt, Buffer.alloc(1024 * 1024));
      assert.throws(
        () => readPersonalStateOwnerBuild(receipt, "a".repeat(40), "123", "1"),
        scenario === "invalid-json"
          ? SyntaxError
          : /ordinary bounded file|size limit|changed while/u,
      );
      assert.notEqual(held, undefined);
      assert.equal(closed, true);
      assert(readBytes <= 1024 * 1024 + 1);
      if (["redirected", "different-file", "oversized"].includes(scenario))
        assert.equal(readBytes, 0);
    } finally {
      t.mock.restoreAll();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}

for (const field of ["dev", "ino"] as const) {
  test(`Personal receipt admission distinguishes adjacent 64-bit ${field} values`, (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "personal-owner-identity-"));
    const receipt = path.join(temporary, "receipt.json");
    fs.writeFileSync(receipt, "{}");
    const identity = 2n ** 60n;
    let descriptor: number | undefined;
    const fstat = fs.fstatSync;
    const lstat = fs.lstatSync;
    for (const [method, original, value] of [
      ["fstatSync", fstat, identity],
      ["lstatSync", lstat, identity + 1n],
    ] as const) {
      t.mock.method(fs, method, (...args: Parameters<typeof original>) => {
        if (method === "fstatSync") descriptor = args[0] as number;
        const actual = Reflect.apply(original, fs, args);
        return new Proxy(actual, {
          get(target, property) {
            if (property === field)
              return typeof target[field] === "bigint" ? value : Number(value);
            return Reflect.get(target, property);
          },
        });
      });
    }
    try {
      assert.throws(
        () => readPersonalStateOwnerBuild(receipt, "a".repeat(40), "123", "1"),
        /ordinary bounded file/u,
      );
      assert.notEqual(descriptor, undefined);
      assert.throws(() => fstat(descriptor!), { code: "EBADF" });
    } finally {
      t.mock.restoreAll();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}

for (const field of ["mtime", "ctime"] as const) {
  test(`Personal receipt admission rejects a same-millisecond ${field} change`, (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "personal-owner-time-"));
    const receipt = path.join(temporary, "receipt.json");
    fs.writeFileSync(receipt, "{}");
    const fstat = fs.fstatSync;
    let observations = 0;
    let descriptor: number | undefined;
    t.mock.method(fs, "fstatSync", (...args: Parameters<typeof fstat>) => {
      descriptor = args[0];
      const actual = Reflect.apply(fstat, fs, args);
      const changed = observations++ > 0;
      return new Proxy(actual, {
        get(target, property) {
          if (property === `${field}Ms`) return typeof target.size === "bigint" ? 1000n : 1000;
          if (property === `${field}Ns`) return changed ? 1000000001n : 1000000000n;
          return Reflect.get(target, property);
        },
      });
    });
    try {
      assert.throws(
        () => readPersonalStateOwnerBuild(receipt, "a".repeat(40), "123", "1"),
        /changed while being read/u,
      );
      assert.equal(observations, 2);
      assert.notEqual(descriptor, undefined);
      assert.throws(() => fstat(descriptor!), { code: "EBADF" });
    } finally {
      t.mock.restoreAll();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}
