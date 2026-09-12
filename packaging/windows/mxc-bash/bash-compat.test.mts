// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  baselineKey,
  aliasPipelineCases,
  fixedEnvironment,
  request,
  parseJsonLines,
  validateDenials,
  validateTracker,
  validateRawPipeDiagnostics,
  validateMxcInspectionBuild,
  validateDerivedMetadata,
  binaryPins,
  originalBinaryPins,
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
  assert(row.process.env.includes("NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD=repair-query"));
  assert(
    !row.process.env.some(
      (v) =>
        /TOKEN|API_KEY|SECRET|NODE_OPTIONS/.test(v) &&
        v !== "NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD=repair-query",
    ),
  );
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
  assert.equal("NEMOCLAW_MSYS_IMAGE_LAYOUT" in env, false);
  assert.equal(env.NEMOCLAW_MSYS_ASLR_METADATA, "1");
});
test("derived DLL and unsigned Bash provenance preserves the wrapper and requires native signature/checksum evidence", () => {
  assert.notEqual(binaryPins["usr/bin/bash.exe"], originalBinaryPins["usr/bin/bash.exe"]);
  assert.equal(binaryPins["bin/bash.exe"], originalBinaryPins["bin/bash.exe"]);
  const receipt = {
    classification: "ci-derived-canonical-msys-dynamic-base",
    sourceRevision: "a".repeat(40),
    adaptation: "msys-dll-and-unsigned-bash-sh-dynamic-base",
    untouchedOfficialBytes: false,
    originalsPreserved: true,
    allOtherFilesUnchanged: true,
    arm64WrapperUnchanged: true,
    arm64ShWrapperUnchanged: true,
    derivedBashExplicitlyUnsigned: true,
    derivedShExplicitlyUnsigned: true,
    nativeChecksumVerified: true,
    derivedBashUnsignedVerified: true,
    derivedShUnsignedVerified: true,
    qualified: false,
    upstream: {
      nousCommit: "2237be355906fbe6065ce1815711eee52b2d646e",
      sha256: "f8e92cd3359fcbb96998cfd606a536ccc6dbfb23c04e12b29042f9ba45b6b0c7",
    },
    files: [
      {
        path: "usr/bin/msys-2.0.dll",
        beforeSha256: originalBinaryPins["usr/bin/msys-2.0.dll"],
        afterSha256: binaryPins["usr/bin/msys-2.0.dll"],
        beforeFlags: 0,
        afterFlags: 0x40,
        onlyMetadataChanged: true,
        certificateDirectoryAbsent: true,
        derivedNotSigned: true,
        certificateTableRemoved: false,
      },
      {
        path: "usr/bin/bash.exe",
        beforeSha256: originalBinaryPins["usr/bin/bash.exe"],
        afterSha256: binaryPins["usr/bin/bash.exe"],
        beforeFlags: 0x8000,
        afterFlags: 0x8040,
        beforeBytes: 2455808,
        bytes: 2442752,
        onlyMetadataChanged: true,
        certificateDirectoryAbsent: true,
        derivedNotSigned: true,
        certificateTableRemoved: true,
        originalCertificate: {
          offset: 2442752,
          bytes: 13056,
          sha256: "ad13eb3d0e085570befdca351ea777c89bce3120f9675b2c5e8ba3df9a674e5d",
          authenticodeStatus: "Valid",
        },
      },
      {
        path: "usr/bin/sh.exe",
        beforeSha256: originalBinaryPins["usr/bin/sh.exe"],
        afterSha256: binaryPins["usr/bin/sh.exe"],
        beforeFlags: 0x8000,
        afterFlags: 0x8040,
        beforeBytes: 2455808,
        bytes: 2442752,
        onlyMetadataChanged: true,
        certificateDirectoryAbsent: true,
        derivedNotSigned: true,
        certificateTableRemoved: true,
        originalCertificate: {
          offset: 2442752,
          bytes: 13056,
          sha256: "ad13eb3d0e085570befdca351ea777c89bce3120f9675b2c5e8ba3df9a674e5d",
          authenticodeStatus: "Valid",
        },
      },
    ],
    // Synthetic status values exercise the receipt contract; real Windows
    // Authenticode results remain required by run-bash-compat.ps1.
    nativeSignatures: [
      {
        file: "original-bash.exe",
        sha256: originalBinaryPins["usr/bin/bash.exe"],
        status: "Valid",
      },
      { file: "derived-bash.exe", sha256: binaryPins["usr/bin/bash.exe"], status: "NotSigned" },
      {
        file: "original-arm64-wrapper.exe",
        sha256: originalBinaryPins["bin/bash.exe"],
        status: "NotSigned",
      },
      { file: "original-sh.exe", sha256: originalBinaryPins["usr/bin/sh.exe"], status: "Valid" },
      { file: "derived-sh.exe", sha256: binaryPins["usr/bin/sh.exe"], status: "NotSigned" },
      {
        file: "original-arm64-sh-wrapper.exe",
        sha256: originalBinaryPins["bin/sh.exe"],
        status: "NotSigned",
      },
    ],
  };
  assert.equal(validateDerivedMetadata(receipt, receipt.sourceRevision), receipt);
  for (const field of [
    "nativeChecksumVerified",
    "derivedBashUnsignedVerified",
    "derivedShUnsignedVerified",
    "arm64WrapperUnchanged",
    "arm64ShWrapperUnchanged",
    "derivedBashExplicitlyUnsigned",
    "derivedShExplicitlyUnsigned",
  ])
    assert.throws(() =>
      validateDerivedMetadata({ ...receipt, [field]: false }, receipt.sourceRevision),
    );
  assert.throws(() =>
    validateDerivedMetadata({ ...receipt, untouchedOfficialBytes: true }, receipt.sourceRevision),
  );
  assert.throws(() =>
    validateDerivedMetadata(
      { ...receipt, files: [{ ...receipt.files[0], afterFlags: 0xc0 }, ...receipt.files.slice(1)] },
      receipt.sourceRevision,
    ),
  );
  for (const derived of ["derived-bash.exe", "derived-sh.exe"])
    assert.throws(() =>
      validateDerivedMetadata(
        {
          ...receipt,
          nativeSignatures: receipt.nativeSignatures.map((row) =>
            row.file === derived ? { ...row, status: "Valid" } : row,
          ),
        },
        receipt.sourceRevision,
      ),
    );
});
test("sh alias pipeline cases cannot run before the unchanged main Bash gate", () => {
  assert.throws(() => aliasPipelineCases(c.nonce, false), /Original Bash pipeline/u);
  assert.throws(() => aliasPipelineCases("invalid", true));
  const cases = aliasPipelineCases(c.nonce, true);
  assert.deepEqual(
    cases.map((entry) => entry.target),
    ["usr/bin/sh.exe", "bin/sh.exe"],
  );
  assert(
    cases.every(
      (entry) =>
        entry.args.slice(0, 3).join(" ") === "--noprofile --norc -c" &&
        entry.args[3]!.startsWith("set -euo pipefail; ") &&
        entry.args[3]!.includes("| cat | grep -F"),
    ),
  );
  assert.notEqual(cases[0]!.expected, cases[1]!.expected);
  assert.equal(binaryPins["usr/bin/sh.exe"], binaryPins["usr/bin/bash.exe"]);
  assert.equal(binaryPins["bin/sh.exe"], originalBinaryPins["bin/sh.exe"]);
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
test("raw pipe diagnostics require inherited-writer I/O and EOF for a successful variant", () => {
  const rows: any[] = [];
  for (const appSidMask of [0x120196, 0x12019f]) {
    rows.push(
      {
        kind: "rawpipe-case",
        nonce: c.nonce,
        appSidMask,
        diagnosticOnly: true,
        roundtripPassed: true,
        error: "",
      },
      {
        kind: "rawpipe-child-write",
        nonce: c.nonce,
        appSidMask,
        pid: 42,
        passed: true,
        writeAttempted: true,
        eventCreated: true,
        completionObserved: true,
        ioStatus: "0x00000000",
        cancelled: false,
        requestedBytes: 33,
        transferredBytes: 33,
      },
      {
        kind: "rawpipe-child-created",
        nonce: c.nonce,
        appSidMask,
        childPid: 42,
        created: true,
        explicitHandleList: true,
        pipeReaderExcluded: true,
      },
      {
        kind: "rawpipe-child-closed",
        nonce: c.nonce,
        appSidMask,
        childPid: 42,
        childClosed: true,
        parentWriterClosed: true,
        forced: false,
        exitCode: 0,
      },
      {
        kind: "rawpipe-roundtrip",
        nonce: c.nonce,
        appSidMask,
        sentinelMatched: true,
        transferBytes: 33,
        parentWriterClosedBeforeRead: true,
        childClosedBeforeEof: true,
        eof: true,
      },
    );
  }
  rows.push({
    kind: "rawpipe-summary",
    nonce: c.nonce,
    diagnosticOnly: true,
    rawProbeUnshimmed: true,
    runtimeGrantsChanged: false,
    casesCompleted: 2,
    casesPassed: 2,
  });
  assert.equal(validateRawPipeDiagnostics(rows, c.nonce).summary.casesPassed, 2);
  for (const kind of [
    "rawpipe-child-created",
    "rawpipe-child-write",
    "rawpipe-child-closed",
    "rawpipe-roundtrip",
  ])
    assert.throws(() =>
      validateRawPipeDiagnostics(
        rows.filter((row) => row.kind !== kind),
        c.nonce,
      ),
    );
  assert.throws(() =>
    validateRawPipeDiagnostics(
      rows.map((row) =>
        row.kind === "rawpipe-child-write"
          ? { ...row, completionObserved: false, ioStatus: null }
          : row,
      ),
      c.nonce,
    ),
  );
});
test("both raw descriptor variants remain diagnostic observations when actual I/O fails", () => {
  const rows = [
    ...[0x120196, 0x12019f].map((appSidMask) => ({
      kind: "rawpipe-case",
      nonce: c.nonce,
      appSidMask,
      diagnosticOnly: true,
      roundtripPassed: false,
      error: "native transfer failed",
    })),
    {
      kind: "rawpipe-summary",
      nonce: c.nonce,
      diagnosticOnly: true,
      rawProbeUnshimmed: true,
      runtimeGrantsChanged: false,
      casesCompleted: 2,
      casesPassed: 0,
    },
  ];
  assert.equal(validateRawPipeDiagnostics(rows, c.nonce).summary.casesPassed, 0);
  assert.throws(() =>
    validateRawPipeDiagnostics(
      rows.map((row) => (row.kind === "rawpipe-case" ? { ...row, appSidMask: 0x120196 } : row)),
      c.nonce,
    ),
  );
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

test("tracker requires actual writer-only inheritance, data, EOF and closed handles", () => {
  const row = {
    kind: "tracker-proof",
    originalSuccess: false,
    originalError: 5,
    adaptedSuccess: true,
    readType: 3,
    writeType: 3,
    initialReadFlags: 0,
    initialWriteFlags: 0,
    finalReadFlags: 0,
    finalWriteFlags: 1,
    transferBytes: 16,
    writerClosedBeforeEof: true,
    eofError: 109,
    handlesClosed: true,
    failedOutputsInspected: false,
  };
  validateTracker(row);
  validateTracker({ ...row, originalSuccess: true, originalError: 0 });
  for (const [key, value] of Object.entries({
    adaptedSuccess: false,
    readType: 1,
    writeType: 1,
    initialReadFlags: 1,
    initialWriteFlags: 1,
    finalReadFlags: 1,
    finalWriteFlags: 0,
    transferBytes: 15,
    writerClosedBeforeEof: false,
    eofError: 0,
    handlesClosed: false,
    failedOutputsInspected: true,
  }))
    assert.throws(() => validateTracker({ ...row, [key]: value }));
});

test("patched MXC receipt requires exact upstream source, patch and sole ARM64 executor", () => {
  const patch = "a".repeat(64);
  const file = { file: "wxc-exec.exe", machine: 0xaa64, bytes: 1024, sha256: "b".repeat(64) };
  const receipt = {
    schemaVersion: 1,
    classification: "mxc-owned-token-inspection-build",
    status: "built",
    tokenQueryRepairSupported: true,
    tokenAccessMode: "owned-child-query-only",
    sourceCommit: "7dac1a952f0c9ad13f0a4cb089c4e0e8b3e0013a",
    sourceSha256: "814659a1db0b4cd06854066705f274bba2b2702f563735d69ba72a407c0ad258",
    patchSha256: patch,
    files: [file],
  };
  assert.equal(validateMxcInspectionBuild(receipt, patch), file);
  for (const [key, value] of Object.entries({
    sourceCommit: "main",
    sourceSha256: "0".repeat(64),
    patchSha256: "0".repeat(64),
    status: "pending",
    tokenQueryRepairSupported: false,
    tokenAccessMode: "unrestricted",
  }))
    assert.throws(() => validateMxcInspectionBuild({ ...receipt, [key]: value }, patch));
  for (const invalid of [
    { ...file, machine: 0x8664 },
    { ...file, file: "other.exe" },
    { ...file, bytes: 0 },
    { ...file, sha256: "missing" },
  ])
    assert.throws(() => validateMxcInspectionBuild({ ...receipt, files: [invalid] }, patch));
  assert.throws(() => validateMxcInspectionBuild({ ...receipt, files: [file, file] }, patch));
  assert.equal(
    "NEMOCLAW_MSYS_TOKEN_INSPECTION" in fixedEnvironment("C:\\Windows", c.share, c.git, c.node),
    false,
  );
  assert(
    !request(
      c,
      "C:\\owned\\control\\worker.mts",
      "C:\\owned\\control\\base.json",
      "C:\\Windows",
    ).process.env.some((entry) => entry.startsWith("NEMOCLAW_MSYS_TOKEN_INSPECTION=")),
  );
});
