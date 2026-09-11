// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  baselineKey,
  fixedEnvironment,
  request,
  parseJsonLines,
  validateDenials,
  Owned,
  type Config,
} from "./bash-compat.mts";
const c: Config = {
  nonce: "a".repeat(24),
  containerId: "nm-aaaaaaaaaaaa-base",
  mode: "baseline",
  share: "C:\\owned-state-base",
  node: "C:\\owned\\control\\node.exe",
  git: "C:\\owned\\git",
  compat: "C:\\owned\\compat",
  probe: "C:\\owned\\control\\probe.exe",
  key: "0".repeat(16),
  script: "C:\\owned\\control\\proof.sh",
};
test("Personal request grants only fixed inputs and its own share, without profile destruction before explicit cleanup", () => {
  const row = request(
    c,
    "C:\\owned\\control\\worker.mts",
    "C:\\owned\\control\\base.json",
    "C:\\Windows",
  );
  assert.equal(row.processContainer.leastPrivilege, false);
  assert.deepEqual(row.filesystem, {
    readonlyPaths: ["C:\\owned"],
    readwritePaths: [c.share],
  });
  assert.equal(row.process.cwd, c.share);
  assert(!row.filesystem.readonlyPaths.some((root) => c.share.startsWith(root + "\\")));
  assert.equal(row.process.timeout, 120000);
  assert.equal(row.lifecycle.destroyOnExit, false);
  assert.equal(row.ui.disable, false);
  assert(row.process.commandLine.startsWith('"' + c.node + '"'));
  assert(!row.process.env.some((v) => /TOKEN|API_KEY|SECRET|NODE_OPTIONS/.test(v)));
});
test("worker environment has Windows process prerequisites, only pinned tool paths, and no ambient credentials", () => {
  const env = fixedEnvironment("C:\\Windows", c.share, c.git, c.node);
  assert.equal(env.SYSTEMROOT, "C:\\Windows");
  assert.equal(env.WINDIR, env.SYSTEMROOT);
  assert.equal(env.SYSTEMDRIVE, "C:");
  assert.equal(env.TEMP, c.share);
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.PATH.split(";").length, 6);
  assert(env.PATH.includes("C:\\owned\\git\\usr\\bin"));
  assert.equal("GITHUB_TOKEN" in env, false);
});
test("baseline key requires exact known native failure, not a generic denial", () => {
  const error =
    "fatal NtCreateDirectoryObject(\\BaseNamedObjects\\msys-2.0S5-dc460fdc78643717): 0xC0000022\r\n";
  assert.equal(baselineKey(error), "dc460fdc78643717");
  assert.throws(() => baselineKey("Access denied"));
  assert.throws(() => baselineKey(error.replace("0022", "0001")));
  assert.throws(() => baselineKey(error + error.replace("dc460fdc78643717", "ac460fdc78643717")));
});
test("partial pipe record remains unparsed until its newline arrives", () => {
  assert.deepEqual(parseJsonLines('{"kind":"ready"}\n{"kind":'), [{ kind: "ready" }]);
  assert.deepEqual(parseJsonLines('{"kind":"ready"}'), []);
  assert.throws(() => parseJsonLines("{broken}\n"));
});
test("all independent raw denial results must be access denied, including NULL-DACL children", () => {
  const row = {
    kind: "denials",
    rawProbeUnshimmed: true,
    foreignRoot: "other",
    foreignDirectory: "0xc0000022",
    foreignGlobalQuery: "0xc0000022",
    foreignGlobalCreateObject: "0xc0000022",
    foreignGlobalCreateSubdirectory: "0xc0000022",
    foreignSessionQuery: "0xc0000022",
    foreignSessionCreateObject: "0xc0000022",
    foreignSessionCreateSubdirectory: "0xc0000022",
    foreignEventSynchronize: "0xc0000022",
    foreignEventModifyState: "0xc0000022",
    foreignSectionMapWrite: "0xc0000022",
    foreignEvent: "0xc0000022",
    foreignSection: "0xc0000022",
    originalGlobalCreate: "0xc0000022",
    pipeForeignWriter: 5,
    pipeForeignWriteData: 5,
    pipeOwnBefore: true,
    pipeOwnMinimalBefore: true,
    pipeOwnAfter: true,
    pipeOwnMinimalAfter: true,
    pipeServerAvailableAfter: true,
    ordinaryForeignWriter: "0xc0000022",
    ordinaryForeignWriteData: "0xc0000022",
    ordinaryOwnBefore: true,
    ordinaryOwnMinimalBefore: true,
    ordinaryOwnAfter: true,
    ordinaryOwnMinimalAfter: true,
    ordinaryServerAvailableAfter: true,
  };
  validateDenials(row, "other");
  for (const key of [
    "foreignDirectory",
    "foreignGlobalQuery",
    "foreignGlobalCreateObject",
    "foreignGlobalCreateSubdirectory",
    "foreignSessionQuery",
    "foreignSessionCreateObject",
    "foreignSessionCreateSubdirectory",
    "foreignEvent",
    "foreignEventSynchronize",
    "foreignEventModifyState",
    "foreignSection",
    "foreignSectionMapWrite",
    "originalGlobalCreate",
  ])
    assert.throws(() => validateDenials({ ...row, [key]: "0xc0000034" }, "other"));
  assert.throws(() => validateDenials({ ...row, rawProbeUnshimmed: false }, "other"));
  assert.throws(() => validateDenials(row, "another"));
  for (const key of ["ordinaryForeignWriter", "ordinaryForeignWriteData"])
    for (const code of ["0x00000000", "0xc0000034", "0xc00000ae", "0xc00000b0"])
      assert.throws(() => validateDenials({ ...row, [key]: code }, "other"));
  for (const key of [
    "ordinaryOwnBefore",
    "ordinaryOwnMinimalBefore",
    "ordinaryOwnAfter",
    "ordinaryOwnMinimalAfter",
    "ordinaryServerAvailableAfter",
  ])
    assert.throws(() => validateDenials({ ...row, [key]: false }, "other"));
  for (const key of ["pipeForeignWriter", "pipeForeignWriteData"])
    for (const code of [0, 2, 231, 233])
      assert.throws(() => validateDenials({ ...row, [key]: code }, "other"));
  for (const key of [
    "pipeOwnBefore",
    "pipeOwnMinimalBefore",
    "pipeOwnAfter",
    "pipeOwnMinimalAfter",
    "pipeServerAvailableAfter",
  ])
    assert.throws(() => validateDenials({ ...row, [key]: false }, "other"));
});
test("actual child pipes preserve stdout/stderr and nonzero exit without forced cleanup", async () => {
  const child = new Owned(
    process.execPath,
    [
      "-e",
      'process.stdin.resume();process.stdin.on("end",()=>{console.log("out");console.error("err");process.exitCode=7})',
    ],
    process.env,
    process.cwd(),
    5000,
  );
  child.child.stdin!.end();
  const result = await child.finish();
  assert.equal(result.exitCode, 7);
  assert.equal(result.closed, true);
  assert.equal(result.forced, false);
  assert.equal(result.stdout.trim(), "out");
  assert.equal(result.stderr.trim(), "err");
});
test("actual hanging child is terminated within its owned bound and remains a failed result", async () => {
  const started = performance.now();
  const child = new Owned(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    process.env,
    process.cwd(),
    150,
  );
  child.child.stdin!.end();
  const result = await child.finish();
  assert.equal(result.closed, true);
  assert.equal(result.forced, true);
  assert.equal(result.error, "process-deadline");
  assert(performance.now() - started < 7000);
});
test("actual oversized output is bounded and fails instead of retaining arbitrary bytes", async () => {
  const child = new Owned(
    process.execPath,
    ["-e", 'process.stdout.write("x".repeat(1024*1024));setInterval(()=>{},1000)'],
    process.env,
    process.cwd(),
    5000,
  );
  child.child.stdin!.end();
  const result = await child.finish();
  assert.equal(result.forced, true);
  assert.equal(result.error, "output-bound");
  assert(result.stdout.length <= 256 * 1024);
  assert.equal(result.closed, true);
});
