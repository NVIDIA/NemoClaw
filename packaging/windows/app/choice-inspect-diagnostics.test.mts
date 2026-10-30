// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  choiceInspectChildDiagnostics,
  privateDirectoryDiagnosticCommand,
  sqliteReadonlyWorkerDiagnostics,
} from "./choice-inspect-diagnostics.mts";

const privateDirectoryCommand = [
  "$ErrorActionPreference = 'Stop'",
  "$nativeLibrary = 'private-library-path'",
  "Add-Type -LiteralPath $nativeLibrary",
  "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$sddl = $security.GetSecurityDescriptorSddlForm($sections)",
  "$errorCode = [OpenClawPrivateDirectory]::Create($path, $sddl)",
  "if ($errorCode -ne 0) { throw 'retained-error' }",
].join("; ");

test("private-directory phase diagnostics retain every original statement and reject unknown scripts", () => {
  const instrumented = privateDirectoryDiagnosticCommand(privateDirectoryCommand);
  assert(instrumented);
  assert.equal(
    instrumented
      .split("; ")
      .filter(
        (statement) =>
          !statement.startsWith("$nemoPrivateDirectoryTimer =") &&
          !statement.startsWith("[Console]::Error.WriteLine('[nemoclaw-private-directory]"),
      )
      .join("; "),
    privateDirectoryCommand,
  );
  for (const changed of [
    "unrelated",
    privateDirectoryCommand.replace(
      "Add-Type -LiteralPath $nativeLibrary",
      "Add-Type -TypeDefinition $nativeSource",
    ),
    privateDirectoryCommand + "; Add-Type -LiteralPath $nativeLibrary",
  ])
    assert.equal(privateDirectoryDiagnosticCommand(changed), null);
});

test("readonly PowerShell instrumentation preserves call ownership and exports only bounded phase records", () => {
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
  const lines: string[] = [];
  const receiver = {},
    options = { env: { SECRET: "private-environment" }, timeout: 60000 };
  const callback = () => {};
  const argv = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(privateDirectoryCommand, "utf16le").toString("base64"),
  ];
  let seen: unknown[] = [];
  const cp = {
    execFile(this: unknown, ...args: unknown[]) {
      assert.equal(this, receiver);
      seen = args;
      return child;
    },
    spawn() {},
    spawnSync() {},
    execFileSync() {},
  };
  runInNewContext(sqliteReadonlyWorkerDiagnostics, {
    Buffer,
    require(name: string) {
      if (name === "node:child_process") return cp;
      if (name === "node:sqlite") return { backup() {} };
      assert.equal(name, "node:module");
      return { syncBuiltinESMExports() {} };
    },
    process: { execPath: "/private/node", stderr: { write: (line: string) => lines.push(line) } },
    performance: { now: () => 10 },
  });
  assert.equal(
    cp.execFile.call(receiver, "C:\\Windows\\powershell.exe", argv, options, callback),
    child,
  );
  assert.equal(seen[0], "C:\\Windows\\powershell.exe");
  assert.equal(seen[2], options);
  assert.equal(seen[3], callback);
  assert.notEqual(seen[1], argv);
  assert.equal(Buffer.from(argv[4], "base64").toString("utf16le"), privateDirectoryCommand);
  assert.equal(
    Buffer.from((seen[1] as string[])[4], "base64").toString("utf16le"),
    privateDirectoryDiagnosticCommand(privateDirectoryCommand),
  );
  const record = '[nemoclaw-private-directory] {"stage":"library-loaded","elapsedMs":123}\r\n';
  child.stderr.emit("data", Buffer.from(record.slice(0, 17)));
  child.stderr.emit(
    "data",
    Buffer.from(
      record.slice(17) +
        "private stderr\n" +
        '[nemoclaw-private-directory] {"stage":"private-secret","elapsedMs":1}\n' +
        record.repeat(10),
    ),
  );
  const phases = lines.filter((line) => line.startsWith("[nemoclaw-private-directory]"));
  assert.equal(phases.length, 5);
  assert(phases.every((line) => line === record.replace("}\r\n", ',"observedAtMs":0}\n')));
  assert.doesNotMatch(
    lines.join(""),
    /private-secret|private stderr|private-environment|private-library-path/,
  );
  const originalArgs = ["-NoProfile", "-Command", "unchanged"];
  cp.execFile.call(receiver, "C:\\Windows\\powershell.exe", originalArgs, options, callback);
  assert.equal(seen[1], originalArgs);
});

function fixture(invoke: (...args: unknown[]) => unknown) {
  const methods = ["spawn", "spawnSync", "execFile", "execFileSync"];
  const cp = Object.fromEntries(methods.map((method) => [method, invoke]));
  const lines: string[] = [];
  let syncs = 0;
  runInNewContext(choiceInspectChildDiagnostics, {
    require(name: string) {
      if (name === "node:child_process") return cp;
      assert.equal(name, "node:module");
      return { syncBuiltinESMExports: () => syncs++ };
    },
    process: { execPath: "/private/node", stderr: { write: (line: string) => lines.push(line) } },
    performance: { now: () => 10 },
  });
  assert.equal(syncs, 1);
  const records = () => lines.map((line) => JSON.parse(line.slice(line.indexOf("{")).trim()));
  return { cp, lines, records };
}

test("inspect diagnostics preserve child calls and disclose only bounded categories", () => {
  const child = new EventEmitter();
  const args = ["--openclaw-sqlite-readonly-child", "secret-database-path"];
  const options = { env: { SECRET: "secret-environment" } };
  const callback = () => {};
  const receiver = {};
  const { cp, lines, records } = fixture(function (this: unknown, ...actual) {
    assert.equal(this, receiver);
    assert.deepEqual(actual, ["/private/node", args, options, callback]);
    assert.equal(actual[1], args);
    assert.equal(actual[2], options);
    assert.equal(actual[3], callback);
    return child;
  });
  assert.equal(cp.execFile.call(receiver, "/private/node", args, options, callback), child);
  assert.equal(records().length, 1);
  child.emit("close", 1, "SIGTERM");
  assert.deepEqual(records(), [
    { id: 1, method: "execFile", category: "node-sqlite-readonly", stage: "start", elapsedMs: 0 },
    { id: 1, method: "execFile", category: "node-sqlite-readonly", stage: "closed", elapsedMs: 0 },
  ]);
  assert.doesNotMatch(lines.join(""), /private|secret|SIGTERM/);
});

test("inspect diagnostics preserve synchronous results and thrown errors", () => {
  const result = { status: 1, stderr: "secret-output" };
  const returned = fixture(() => result);
  assert.equal(returned.cp.spawnSync("C:\\Windows\\powershell.exe", ["secret-script"]), result);
  assert.deepEqual(
    returned.records().map(({ category, stage }) => [category, stage]),
    [
      ["powershell", "start"],
      ["powershell", "returned"],
    ],
  );
  const failure = new Error("secret-failure");
  const thrown = fixture(() => {
    throw failure;
  });
  assert.throws(
    () => thrown.cp.execFileSync("private-executable"),
    (error) => error === failure,
  );
  assert.deepEqual(
    thrown.records().map(({ category, stage }) => [category, stage]),
    [
      ["other", "start"],
      ["other", "threw"],
    ],
  );
  assert.doesNotMatch([...returned.lines, ...thrown.lines].join(""), /secret|private|Windows/);
});

test("inspect diagnostics stop recording without stopping child calls", () => {
  let calls = 0;
  const { cp, records } = fixture(() => {
    calls++;
    return {};
  });
  for (let i = 0; i < 200; i++) cp.spawnSync("/private/node");
  assert.equal(calls, 200);
  assert.equal(records().length, 128);
  assert(records().every(({ category }) => category === "node"));
});

test("inspect diagnostics retain the package-manager trap and real Node callback output", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require("node:assert/strict"), cp = require("node:child_process");
    const original = cp.execFile;
    const refusal = new Error("synthetic package-manager refusal");
    cp.execFile = function(...args) {
      if (args[0] === "npm") throw refusal;
      return original.apply(this, args);
    };
    ${choiceInspectChildDiagnostics}
    assert.throws(() => cp.execFile("npm"), error => error === refusal);
    cp.execFile(process.execPath, ["-e", "process.stdout.write('retained-output')"],
      {encoding:"utf8"}, (error, stdout) => {
        assert.ifError(error);
        assert.equal(stdout, "retained-output");
        process.stdout.write("callback-preserved");
      });
  `,
    ],
    { encoding: "utf8", timeout: 10000, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "callback-preserved");
  assert.match(result.stderr, /"stage":"threw"/);
  assert.match(result.stderr, /"category":"node","stage":"closed"/);
  assert.doesNotMatch(result.stderr, /retained-output|package-manager refusal|process\.stdout/);
});

test("readonly diagnostic preserves backup arguments, receiver, promise and failures without leaking data", async () => {
  for (const outcome of ["success", "reject", "throw"] as const) {
    const secret = new Error("private database failure");
    const args = [{ privateDatabase: true }, "private-destination"];
    const receiver = {};
    const promise =
      outcome === "reject" ? Promise.reject(secret) : Promise.resolve("private-result");
    const lines: string[] = [];
    const sqlite = {
      backup(this: unknown, ...actual: unknown[]) {
        assert.equal(this, receiver);
        assert.equal(actual[0], args[0]);
        assert.equal(actual[1], args[1]);
        if (outcome === "throw") throw secret;
        return promise;
      },
    };
    const cp = Object.fromEntries(
      ["spawn", "spawnSync", "execFile", "execFileSync"].map((name) => [name, () => {}]),
    );
    runInNewContext(sqliteReadonlyWorkerDiagnostics, {
      require(name: string) {
        if (name === "node:child_process") return cp;
        if (name === "node:sqlite") return sqlite;
        assert.equal(name, "node:module");
        return { syncBuiltinESMExports() {} };
      },
      process: { execPath: "/private/node", stderr: { write: (line: string) => lines.push(line) } },
      performance: { now: () => 10 },
    });
    if (outcome === "throw")
      assert.throws(
        () => sqlite.backup.call(receiver, ...args),
        (error) => error === secret,
      );
    else {
      const actual = sqlite.backup.call(receiver, ...args);
      assert.equal(actual, promise);
      if (outcome === "reject") await assert.rejects(actual, (error) => error === secret);
      else assert.equal(await actual, "private-result");
    }
    const records = lines.map((line) => JSON.parse(line.slice(line.indexOf("{"))));
    assert.deepEqual(records, [
      { stage: "preload-started", elapsedMs: 0 },
      { stage: "start", elapsedMs: 0 },
      {
        stage: outcome === "success" ? "finished" : outcome === "reject" ? "rejected" : "threw",
        elapsedMs: 0,
      },
    ]);
    assert.doesNotMatch(lines.join(""), /private|destination|database|result/);
  }
});
