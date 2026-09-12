// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Explicit CI prototype only. No application/model/runtime installation.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const LIMIT = 256 * 1024;
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const argument = (name: string) => {
  const i = process.argv.indexOf(name);
  assert(i >= 0 && process.argv[i + 1]);
  return process.argv[i + 1]!;
};
export const originalBinaryPins = {
  "bin/bash.exe": "828e6e891cee98d39057c0c193800e564231fdf92b3cefa15944378fc7730095",
  "bin/sh.exe": "828e6e891cee98d39057c0c193800e564231fdf92b3cefa15944378fc7730095",
  "usr/bin/bash.exe": "92cff5f145d42f85b55aa3be8d3ad9827844a21ec4fbeaa1ddfe1dd4d76c6474",
  "usr/bin/sh.exe": "92cff5f145d42f85b55aa3be8d3ad9827844a21ec4fbeaa1ddfe1dd4d76c6474",
  "usr/bin/msys-2.0.dll": "13f0b0dc94588766ecfa1867f1a00061508ba1dc62f5b8e858ac59f01e358aa0",
};
export const binaryPins = {
  ...originalBinaryPins,
  "usr/bin/bash.exe": "1d9ff9b052760c832874bfef619eecaefecef3abda0ffe8f40c726a517315a1c",
  "usr/bin/sh.exe": "1d9ff9b052760c832874bfef619eecaefecef3abda0ffe8f40c726a517315a1c",
  "usr/bin/msys-2.0.dll": "48f8451360bb491f915ddcf0018b20a5938810a4edff74ad3fcd0eaff67ebdb8",
};
const variant = "ci-derived-unsigned-msys-dll-bash-and-sh-dynamic-base";
export function validateDerivedMetadata(receipt: any, revision: string) {
  assert.equal(receipt.classification, "ci-derived-canonical-msys-dynamic-base");
  assert.equal(receipt.sourceRevision, revision);
  assert.equal(receipt.adaptation, "msys-dll-and-unsigned-bash-sh-dynamic-base");
  assert.equal(receipt.untouchedOfficialBytes, false);
  assert.equal(receipt.originalsPreserved, true);
  assert.equal(receipt.allOtherFilesUnchanged, true);
  assert.equal(receipt.arm64WrapperUnchanged, true);
  assert.equal(receipt.arm64ShWrapperUnchanged, true);
  assert.equal(receipt.derivedBashExplicitlyUnsigned, true);
  assert.equal(receipt.derivedShExplicitlyUnsigned, true);
  assert.equal(receipt.nativeChecksumVerified, true);
  assert.equal(receipt.derivedBashUnsignedVerified, true);
  assert.equal(receipt.derivedShUnsignedVerified, true);
  assert.equal(receipt.qualified, false);
  assert.equal(receipt.upstream.nousCommit, "2237be355906fbe6065ce1815711eee52b2d646e");
  assert.equal(
    receipt.upstream.sha256,
    "f8e92cd3359fcbb96998cfd606a536ccc6dbfb23c04e12b29042f9ba45b6b0c7",
  );
  assert.equal(receipt.files.length, 3);
  assert.equal(new Set(receipt.files.map((file: any) => file.path)).size, 3);
  for (const [relative, flags] of [
    ["usr/bin/msys-2.0.dll", 0],
    ["usr/bin/bash.exe", 0x8000],
    ["usr/bin/sh.exe", 0x8000],
  ] as const) {
    const file = receipt.files.find((row: any) => row.path === relative);
    assert.equal(file?.beforeSha256, originalBinaryPins[relative]);
    assert.equal(file.afterSha256, binaryPins[relative]);
    assert.equal(file.beforeFlags, flags);
    assert.equal(file.afterFlags, flags | 0x40);
    assert.equal(file.onlyMetadataChanged, true);
    assert.equal(file.certificateDirectoryAbsent, true);
    assert.equal(file.derivedNotSigned, true);
    assert.equal(file.certificateTableRemoved, relative !== "usr/bin/msys-2.0.dll");
  }
  for (const relative of ["usr/bin/bash.exe", "usr/bin/sh.exe"]) {
    const shell = receipt.files.find((row: any) => row.path === relative);
    assert.equal(shell.beforeBytes, 2455808);
    assert.equal(shell.bytes, 2442752);
    assert.equal(shell.originalCertificate.offset, 2442752);
    assert.equal(shell.originalCertificate.bytes, 13056);
    assert.equal(
      shell.originalCertificate.sha256,
      "ad13eb3d0e085570befdca351ea777c89bce3120f9675b2c5e8ba3df9a674e5d",
    );
  }
  assert.equal(receipt.nativeSignatures.length, 6);
  for (const [file, expected] of [
    ["original-bash.exe", originalBinaryPins["usr/bin/bash.exe"]],
    ["derived-bash.exe", binaryPins["usr/bin/bash.exe"]],
    ["original-arm64-wrapper.exe", originalBinaryPins["bin/bash.exe"]],
    ["original-sh.exe", originalBinaryPins["usr/bin/sh.exe"]],
    ["derived-sh.exe", binaryPins["usr/bin/sh.exe"]],
    ["original-arm64-sh-wrapper.exe", originalBinaryPins["bin/sh.exe"]],
  ]) {
    const matches = receipt.nativeSignatures.filter((row: any) => row.file === file);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].sha256, expected);
    assert.equal(typeof matches[0].status, "string");
    assert(matches[0].status.length > 0);
    if (file === "derived-bash.exe" || file === "derived-sh.exe")
      assert.equal(matches[0].status, "NotSigned");
    if (file === "original-bash.exe" || file === "original-sh.exe") {
      const relative = file === "original-bash.exe" ? "usr/bin/bash.exe" : "usr/bin/sh.exe";
      assert.equal(
        receipt.files.find((row: any) => row.path === relative).originalCertificate
          .authenticodeStatus,
        matches[0].status,
      );
    }
  }
  return receipt;
}
export function aliasPipelineCases(nonce: string, originalBashPassed: boolean) {
  assert.equal(originalBashPassed, true, "Original Bash pipeline must pass before alias cases");
  assert.match(nonce, /^[a-f0-9]{24}$/u);
  return [
    ["usr/bin/sh.exe", "ALIAS_SH_DIRECT_"],
    ["bin/sh.exe", "ALIAS_SH_WRAPPER_"],
  ].map(([target, prefix]) => {
    const marker = prefix + nonce;
    return {
      target: target!,
      expected: marker + "\n",
      args: [
        "--noprofile",
        "--norc",
        "-c",
        "set -euo pipefail; printf '%s\\n' '" + marker + "' | cat | grep -F '" + marker + "'",
      ],
    };
  });
}

export function fixedEnvironment(windows: string, home: string, git: string, node: string) {
  return {
    SYSTEMROOT: windows,
    WINDIR: windows,
    SYSTEMDRIVE: path.win32.parse(windows).root.slice(0, 2),
    COMSPEC: path.win32.join(windows, "System32/cmd.exe"),
    OS: "Windows_NT",
    PROCESSOR_ARCHITECTURE: "ARM64",
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: home,
    APPDATA: home,
    TEMP: home,
    TMP: home,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    NODE_DISABLE_COMPILE_CACHE: "1",
    PATH: [
      path.win32.dirname(node),
      path.win32.join(git, "bin"),
      path.win32.join(git, "usr/bin"),
      path.win32.join(git, "cmd"),
      path.win32.join(windows, "System32"),
      windows,
    ].join(";"),
    GITHUB_ACTIONS: "true",
    NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD: "repair-query",
    NEMOCLAW_MSYS_ASLR_METADATA: "1",
    NEMOCLAW_MSYS_PROBE_NODE: node.replaceAll("\\", "/"),
  };
}
export function request(config: Config, script: string, configFile: string, windows: string) {
  return {
    version: "0.6.0-alpha",
    containerId: config.containerId,
    containment: "processcontainer",
    process: {
      commandLine: [
        config.node,
        "--experimental-strip-types",
        "--no-warnings",
        script,
        "--worker",
        configFile,
      ]
        .map((value) => '"' + value + '"')
        .join(" "),
      cwd: config.share,
      timeout: 120000,
      env: Object.entries(fixedEnvironment(windows, config.share, config.git, config.node)).map(
        ([key, value]) => key + "=" + value,
      ),
    },
    processContainer: {
      leastPrivilege: false,
      capabilities: ["privateNetworkClientServer", "internetClient"],
    },
    ui: { disable: false },
    network: {
      defaultPolicy: "allow",
      allowedHosts: [],
      blockedHosts: [],
      allowLocalNetwork: true,
    },
    filesystem: {
      readonlyPaths: [path.win32.dirname(config.compat)],
      readwritePaths: [config.share],
    },
    lifecycle: { destroyOnExit: false, preservePolicy: false },
  };
}
export function validateMxcInspectionBuild(build: any, patchSha256: string) {
  assert.equal(build.schemaVersion, 1);
  assert.equal(build.classification, "mxc-owned-token-inspection-build");
  assert.equal(build.status, "built");
  assert.equal(build.tokenQueryRepairSupported, true);
  assert.equal(build.tokenAccessMode, "owned-child-query-only");
  assert.equal(build.sourceCommit, "7dac1a952f0c9ad13f0a4cb089c4e0e8b3e0013a");
  assert.equal(
    build.sourceSha256,
    "814659a1db0b4cd06854066705f274bba2b2702f563735d69ba72a407c0ad258",
  );
  assert.match(patchSha256, /^[a-f0-9]{64}$/u);
  assert.equal(build.patchSha256, patchSha256);
  assert(Array.isArray(build.files) && build.files.length === 1);
  const file = build.files[0];
  assert.equal(file.file, "wxc-exec.exe");
  assert.equal(file.machine, 0xaa64);
  assert(Number.isSafeInteger(file.bytes) && file.bytes > 0);
  assert.match(file.sha256, /^[a-f0-9]{64}$/u);
  return file;
}
export function baselineKey(stderr: string) {
  const matches = [
    ...stderr.matchAll(
      /NtCreateDirectoryObject\(\\BaseNamedObjects\\msys-2\.0S5-([a-f0-9]{16})\):\s*0xC0000022/giu,
    ),
  ];
  assert(matches.length > 0, "Original Bash did not report the known global-directory denial.");
  assert.equal(new Set(matches.map((row) => row[1]!.toLowerCase())).size, 1);
  return matches[0]![1]!.toLowerCase();
}
export function parseJsonLines(text: string) {
  const lines = text.split(/\r?\n/u);
  lines.pop();
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}
export function foreignPipeTargets(ready: any, key: string) {
  assert.equal(ready.rawProbeUnshimmed, true);
  assert.equal(ready.key, key);
  assert.match(key, /^[a-f0-9]{16}$/u);
  assert(Number.isSafeInteger(ready.pid) && ready.pid > 0 && ready.pid <= 0xffffffff);
  assert(Number.isSafeInteger(ready.session) && ready.session >= 0 && ready.session <= 0xffffffff);
  assert.match(ready.sid, /^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/u);
  const root = "\\Sessions\\" + ready.session + "\\AppContainerNamedObjects\\" + ready.sid;
  assert.equal(ready.privateRoot, root);
  const signal = `msys-${key}-${ready.pid}-sigwait`;
  const ordinary = `${key}-${ready.pid}-pipe-nt-0x1`;
  assert.equal(ready.pipeName, "\\\\.\\pipe\\" + signal);
  assert.equal(ready.ordinaryPipeName, ordinary);
  assert.equal(ready.pipeKernelName, "\\Device\\NamedPipe" + root + "\\" + signal);
  assert.equal(ready.ordinaryPipeKernelName, "\\Device\\NamedPipe" + root + "\\" + ordinary);
  return {
    otherRoot: root,
    otherPipe: ready.pipeKernelName,
    otherOrdinaryPipe: ready.ordinaryPipeKernelName,
  };
}

export function validateDenials(row: any, other: string) {
  assert.equal(row.kind, "denials");
  assert.equal(row.rawProbeUnshimmed, true);
  assert.equal(row.foreignRoot, other);
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
    assert.equal(row[key], "0xc0000022", key);
  assert.equal(row.pipeForeignWriter, 5, "foreign canonical writer");
  assert.equal(row.pipeForeignWriteData, 5, "foreign minimal write data");
  assert.equal(row.ordinaryForeignWriter, "0xc0000022", "ordinary canonical writer");
  assert.equal(row.ordinaryForeignWriteData, "0xc0000022", "ordinary minimal write data");
  for (const key of [
    "ordinaryOwnBefore",
    "ordinaryOwnMinimalBefore",
    "ordinaryOwnAfter",
    "ordinaryOwnMinimalAfter",
    "ordinaryServerAvailableAfter",
  ])
    assert.equal(row[key], true, key);
  for (const key of [
    "pipeOwnBefore",
    "pipeOwnMinimalBefore",
    "pipeOwnAfter",
    "pipeOwnMinimalAfter",
    "pipeServerAvailableAfter",
  ])
    assert.equal(row[key], true, key);
}
export function validateRawPipeDiagnostics(rows: any[], nonce: string) {
  const summaries = rows.filter((row) => row.kind === "rawpipe-summary");
  assert.equal(summaries.length, 1);
  const summary = summaries[0];
  assert.equal(summary.nonce, nonce);
  assert.equal(summary.diagnosticOnly, true);
  assert.equal(summary.rawProbeUnshimmed, true);
  assert.equal(summary.runtimeGrantsChanged, false);
  assert.equal(summary.casesCompleted, 2);
  const cases = rows.filter((row) => row.kind === "rawpipe-case");
  assert.deepEqual(cases.map((row) => row.appSidMask).sort(), [0x120196, 0x12019f]);
  for (const row of cases) {
    assert.equal(row.nonce, nonce);
    assert.equal(row.diagnosticOnly, true);
    assert.equal(typeof row.roundtripPassed, "boolean");
    assert.equal(typeof row.error, "string");
    if (!row.roundtripPassed) {
      assert(row.error.length > 0);
      continue;
    }
    const select = (kind: string) => {
      const matches = rows.filter(
        (item) => item.kind === kind && item.appSidMask === row.appSidMask && item.nonce === nonce,
      );
      assert.equal(matches.length, 1, kind);
      return matches[0];
    };
    const write = select("rawpipe-child-write");
    assert.equal(write.passed, true);
    assert.equal(write.writeAttempted, true);
    assert.equal(write.eventCreated, true);
    assert.equal(write.completionObserved, true);
    assert.equal(write.ioStatus, "0x00000000");
    assert.equal(write.cancelled, false);
    assert.equal(write.requestedBytes, 9 + nonce.length);
    assert.equal(write.transferredBytes, write.requestedBytes);
    const created = select("rawpipe-child-created");
    assert.equal(created.created, true);
    assert.equal(created.childPid, write.pid);
    assert.equal(created.explicitHandleList, true);
    assert.equal(created.pipeReaderExcluded, true);
    const closed = select("rawpipe-child-closed");
    assert.equal(closed.childPid, write.pid);
    assert.equal(closed.childClosed, true);
    assert.equal(closed.parentWriterClosed, true);
    assert.equal(closed.forced, false);
    assert.equal(closed.exitCode, 0);
    const readback = select("rawpipe-roundtrip");
    assert.equal(readback.sentinelMatched, true);
    assert.equal(readback.transferBytes, write.requestedBytes);
    assert.equal(readback.parentWriterClosedBeforeRead, true);
    assert.equal(readback.childClosedBeforeEof, true);
    assert.equal(readback.eof, true);
  }
  assert.equal(summary.casesPassed, cases.filter((row) => row.roundtripPassed).length);
  return { summary, cases };
}
export function validateTracker(row: any) {
  assert.equal(row.kind, "tracker-proof");
  assert.equal(typeof row.originalSuccess, "boolean");
  assert(Number.isInteger(row.originalError) && row.originalError >= 0);
  assert.equal(row.adaptedSuccess, true);
  assert.equal(row.readType, 3);
  assert.equal(row.writeType, 3);
  assert.equal(row.initialReadFlags, 0);
  assert.equal(row.initialWriteFlags, 0);
  assert.equal(row.finalReadFlags, 0);
  assert.equal(row.finalWriteFlags, 1);
  assert.equal(row.transferBytes, 16);
  assert.equal(row.writerClosedBeforeEof, true);
  assert.equal(row.eofError, 109);
  assert.equal(row.handlesClosed, true);
  assert.equal(row.failedOutputsInspected, false);
}
function write(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
function atomic(file: string, value: unknown) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { flag: "wx" });
  fs.renameSync(tmp, file);
}
function decode(bytes: Buffer) {
  if (bytes[0] === 255 && bytes[1] === 254) return bytes.subarray(2).toString("utf16le");
  return bytes.toString("utf8").replace(/^\uFEFF/u, "");
}
export class Owned {
  child: ChildProcess;
  out: Buffer[] = [];
  err: Buffer[] = [];
  outBytes = 0;
  errBytes = 0;
  closed = false;
  forced = false;
  error: string | null = null;
  completion: Promise<void>;
  settle!: () => void;
  stopping?: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  readonly exe: string;
  readonly args: string[];
  constructor(exe: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeout: number) {
    this.exe = exe;
    this.args = args;
    this.child = spawn(exe, args, { env, cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin!.on("error", () => {});
    this.completion = new Promise((resolve) => {
      this.settle = resolve;
      this.child.once("error", (e) => {
        this.error = e.message;
      });
      this.child.once("close", () => {
        this.closed = true;
        clearTimeout(this.timer);
        resolve();
      });
    });
    for (const channel of ["out", "err"] as const) {
      const stream = channel === "out" ? this.child.stdout! : this.child.stderr!;
      stream.on("data", (chunk: Buffer) => {
        const used = channel === "out" ? this.outBytes : this.errBytes;
        const left = Math.max(0, LIMIT - used);
        this[channel].push(chunk.subarray(0, left));
        if (channel === "out") this.outBytes += chunk.length;
        else this.errBytes += chunk.length;
        if (chunk.length > left) {
          this.error = "output-bound";
          void this.stop();
        }
      });
    }
    this.timer = setTimeout(() => {
      this.error = "process-deadline";
      void this.stop();
    }, timeout);
  }
  stdout() {
    return decode(Buffer.concat(this.out));
  }
  stderr() {
    return decode(Buffer.concat(this.err));
  }
  stop() {
    this.stopping ??= this.stopInner();
    return this.stopping;
  }
  private async stopInner() {
    if (this.closed) return;
    this.forced = true;
    const windows = process.env.SYSTEMROOT ?? process.env.SystemRoot;
    if (process.platform === "win32" && this.child.pid && windows) {
      const killer = spawn(
        path.join(windows, "System32/taskkill.exe"),
        ["/PID", String(this.child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore", env: { SYSTEMROOT: windows, WINDIR: windows } },
      );
      await new Promise<void>((r) => {
        const timer = setTimeout(() => {
          killer.kill();
          r();
        }, 5000);
        killer.once("error", () => {
          clearTimeout(timer);
          r();
        });
        killer.once("close", () => {
          clearTimeout(timer);
          r();
        });
      });
    } else this.child.kill("SIGKILL");
    await Promise.race([this.completion, delay(5000)]);
    if (!this.closed) {
      this.child.stdin?.destroy();
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
      this.child.unref();
    }
    clearTimeout(this.timer);
    this.settle();
  }
  async finish() {
    await this.completion;
    return this.result();
  }
  result() {
    return {
      executable: this.exe,
      args: this.args,
      pid: this.child.pid,
      exitCode: this.child.exitCode,
      signal: this.child.signalCode,
      closed: this.closed,
      forced: this.forced,
      error: this.error,
      stdout: this.stdout(),
      stderr: this.stderr(),
    };
  }
  async line(kind: string, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      for (const row of parseJsonLines(this.stdout())) if (row.kind === kind) return row;
      if (this.closed) throw Error("Owned probe closed before " + kind + ": " + this.stderr());
      await delay(25);
    }
    throw Error("Owned probe did not report " + kind);
  }
}
export type Config = {
  nonce: string;
  containerId: string;
  mode: "baseline" | "startup" | "isolation";
  share: string;
  node: string;
  git: string;
  compat: string;
  probe: string;
  key: string;
  script: string;
};
function validateConfig(c: Config) {
  assert.match(c.nonce, /^[a-f0-9]{24}$/u);
  assert.match(c.containerId, /^nm-[a-f0-9]{12}-(?:base|start|a|b)$/u);
  assert(["baseline", "startup", "isolation"].includes(c.mode));
  for (const value of [c.share, c.node, c.git, c.compat, c.probe, c.script])
    assert(/^[A-Za-z]:\\/u.test(value) && !/["\r\n]/u.test(value));
  assert.match(c.key, /^[a-f0-9]{16}$/u);
}
function checkSuccess(result: ReturnType<Owned["result"]>, expected?: string) {
  assert(result.closed && !result.forced && !result.error);
  assert.equal(result.exitCode, 0, result.stderr);
  if (expected !== undefined) assert.equal(result.stdout.replaceAll("\r\n", "\n"), expected);
  for (const line of result.stderr.split(/\r?\n/u))
    if (line.startsWith("NEMOCLAW_MSYS_FAILED_CHILD="))
      assert.notEqual(
        JSON.parse(line.split("=", 2)[1]!).closed,
        false,
        "An injection failure left its created child unclosed.",
      );
}
async function waitFile(file: string, deadline: number) {
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    await delay(50);
  }
  throw Error("Owned coordination deadline: " + path.basename(file));
}
async function worker(configFile: string) {
  const c = JSON.parse(fs.readFileSync(configFile, "utf8")) as Config;
  validateConfig(c);
  const env = fixedEnvironment(process.env.SYSTEMROOT!, c.share, c.git, c.node);
  const results: any = {
    schemaVersion: 1,
    nonce: c.nonce,
    containerId: c.containerId,
    mode: c.mode,
    phase: "start",
    passed: false,
    imageVariant: variant,
    cases: [],
    cleanup: { childrenClosed: false, forced: false },
  };
  const owned: Owned[] = [];
  const save = () => atomic(path.join(c.share, "progress.json"), results);
  const finite = async (exe: string, args: string[], timeout = 15000) => {
    const child = new Owned(exe, args, env, c.share, timeout);
    owned.push(child);
    child.child.stdin!.end();
    const result = await child.finish();
    results.cases.push(result);
    save();
    return result;
  };
  try {
    for (const [file, pin] of Object.entries(binaryPins))
      assert.equal(sha(path.join(c.git, file)), pin);
    if (c.mode === "baseline") {
      results.phase = "unhooked-derived-bash";
      const keys = [];
      for (const target of ["usr/bin/bash.exe", "bin/bash.exe"]) {
        const r = await finite(path.join(c.git, target), [
          "--noprofile",
          "--norc",
          "-c",
          "printf UNHOOKED_DERIVED_STARTED",
        ]);
        assert(r.closed && !r.forced && !r.error && r.exitCode !== 0);
        // Either failed attempt may omit stderr. Require one exact denial
        // across both attempts and agreement among all present markers.
        if (r.stderr.includes("NtCreateDirectoryObject")) keys.push(baselineKey(r.stderr));
      }
      assert.equal(new Set(keys).size, 1);
      results.key = keys[0];
      results.passed = true;
    } else {
      const launcher = path.join(c.compat, "NemoClawMsysLauncher.exe");
      if (c.mode === "startup") {
        results.phase = "raw-pipe-diagnostics";
        save();
        const host = await waitFile(path.join(c.share, "host.json"), Date.now() + 5000);
        assert.equal(host.nonce, c.nonce);
        assert(Number.isSafeInteger(host.executorPid) && host.executorPid > 0);
        const raw = await finite(
          c.probe,
          ["rawpipe", c.key, c.nonce, String(process.pid), String(host.executorPid)],
          30000,
        );
        results.rawPipeDiagnostics = { diagnosticOnly: true, execution: raw };
        try {
          const rows = parseJsonLines(raw.stdout);
          results.rawPipeDiagnostics.rows = rows;
          results.rawPipeDiagnostics.observation = validateRawPipeDiagnostics(rows, c.nonce);
        } catch (error) {
          results.rawPipeDiagnostics.error = error instanceof Error ? error.message : String(error);
        }
        save();
        // Diagnostic failures remain visible and never substitute for the full
        // Bash pipeline. Only unsafe process closure stops the later workload.
        assert(raw.closed && !raw.forced, "The raw pipe diagnostic did not close normally");
        results.phase = "injected-startup";
        for (const target of ["usr/bin/bash.exe", "bin/bash.exe"]) {
          const marker = "INJECTED_" + c.nonce;
          const r = await finite(launcher, [
            "--",
            path.join(c.git, target),
            "--noprofile",
            "--norc",
            "-c",
            "printf '%s\\n' '" + marker + "'",
          ]);
          checkSuccess(r, marker + "\n");
        }
      }
      results.phase = "pipes-fork-child";
      save();
      const bash = new Owned(
        launcher,
        [
          "--",
          path.join(c.git, "usr/bin/bash.exe"),
          "--noprofile",
          "--norc",
          c.script.replaceAll("\\", "/"),
          c.nonce,
        ],
        env,
        c.share,
        100000,
      );
      owned.push(bash);
      const until = Date.now() + 20000;
      while (
        !bash
          .stdout()
          .replaceAll("\r\n", "\n")
          .includes("BASH_HOLD_" + c.nonce + "\n") &&
        Date.now() < until &&
        !bash.closed
      )
        await delay(25);
      const expected =
        ["PIPE_", "SUBSHELL_", "CHILD_", "NATIVE_", "BASH_HOLD_"]
          .map((prefix) => prefix + c.nonce)
          .join("\n") + "\n";
      assert.equal(bash.stdout().replaceAll("\r\n", "\n"), expected, bash.stderr());
      results.toolsPassed = true;
      save();
      if (c.mode === "startup") {
        results.phase = "sh-alias-pipelines";
        results.aliasPipelines = [];
        for (const test of aliasPipelineCases(c.nonce, results.toolsPassed === true)) {
          const execution = await finite(launcher, [
            "--",
            path.join(c.git, test.target),
            ...test.args,
          ]);
          results.aliasPipelines.push({ target: test.target, execution });
          save();
          checkSuccess(execution, test.expected);
        }
        results.aliasPipelinesPassed = true;
        save();
      }
      if (c.mode === "isolation") {
        results.phase = "namespace-open";
        save();
        const host = await waitFile(path.join(c.share, "host.json"), Date.now() + 5000);
        assert.equal(host.nonce, c.nonce);
        assert(Number.isSafeInteger(host.executorPid) && host.executorPid > 0);
        const probeArgs = [c.key, c.nonce, String(process.pid), String(host.executorPid)];
        const probe = new Owned(c.probe, ["hold", ...probeArgs], env, c.share, 70000);
        owned.push(probe);
        const ready = await probe.line("ready");
        assert.equal(ready.rawProbeUnshimmed, true);
        assert.equal(ready.key, c.key);
        assert.equal(ready.nullDaclChildren, true);
        for (const key of [
          "pipeExactSynchronousPositive",
          "pipeOverlappedFixture",
          "pipeAvailable",
          "pipeDescriptorMatched",
          "ordinaryExactSynchronousPositive",
          "ordinaryOverlappedFixture",
          "ordinaryPipeAvailable",
          "ordinaryDescriptorMatched",
        ])
          assert.equal(ready[key], true, key);
        assert.equal(ready.trackerComplete, true);
        const tracker = parseJsonLines(probe.stdout()).find((row) => row.kind === "tracker-proof");
        validateTracker(tracker);
        results.tracker = tracker;
        results.namespace = ready;
        atomic(path.join(c.share, "ready.json"), ready);
        const cross = await waitFile(path.join(c.share, "cross.json"), Date.now() + 45000);
        assert.equal(cross.nonce, c.nonce);
        assert(
          typeof cross.otherRoot === "string" &&
            cross.otherRoot !== ready.privateRoot &&
            !/[\r\n]/u.test(cross.otherRoot),
        );
        assert(typeof cross.otherPipe === "string" && !/[\r\n ]/u.test(cross.otherPipe));
        assert(
          typeof cross.otherOrdinaryPipe === "string" && !/[\r\n ]/u.test(cross.otherOrdinaryPipe),
        );
        probe.child.stdin!.write(
          "check " + cross.otherRoot + " " + cross.otherPipe + " " + cross.otherOrdinaryPipe + "\n",
        );
        const denied = await probe.line("denials");
        validateDenials(denied, cross.otherRoot);
        results.denials = denied;
        atomic(path.join(c.share, "checked.json"), denied);
        const stop = await waitFile(path.join(c.share, "stop.json"), Date.now() + 30000);
        assert.equal(stop.nonce, c.nonce);
        probe.child.stdin!.end("stop\n");
        checkSuccess(await probe.finish());
        results.cases.push(probe.result());
        bash.child.stdin!.end("stop\n");
        const br = await bash.finish();
        checkSuccess(br, expected + "BASH_STOP_" + c.nonce + "\n");
        results.cases.push(br);
        results.phase = "namespace-release";
        const absent = await finite(c.probe, ["absent", ...probeArgs]);
        checkSuccess(absent);
        results.absence = parseJsonLines(absent.stdout).find((r) => r.kind === "absence");
      } else {
        bash.child.stdin!.end("stop\n");
        const r = await bash.finish();
        checkSuccess(r, expected + "BASH_STOP_" + c.nonce + "\n");
        results.cases.push(r);
      }
      results.passed = true;
    }
  } catch (error) {
    results.error = error instanceof Error ? error.stack : String(error);
  } finally {
    for (const child of owned) if (!child.closed) await child.stop();
    results.cleanup.childrenClosed = owned.every((child) => child.closed);
    results.cleanup.forced = owned.some(
      (child) => child.forced || child.stderr().includes("NEMOCLAW_RAW_PIPE_CLEANUP_FAILED"),
    );
    if (!results.cleanup.childrenClosed || results.cleanup.forced) results.passed = false;
    results.ownedChildren = owned.map((child) => child.result());
    save();
    write(path.join(c.share, "done.json"), results);
  }
}
const scriptBody = `set -euo pipefail
nonce="$1"
printf 'PIPE_%s\\n' "$nonce" | cat | grep -F "PIPE_$nonce"
value="$( (printf 'SUBSHELL_%s' "$nonce") )"
printf '%s\\n' "$value"
bash --noprofile --norc -c 'printf "CHILD_%s\\n" "$1"' _ "$nonce"
"$NEMOCLAW_MSYS_PROBE_NODE" -e 'process.stdout.write("NATIVE_"+process.argv[1]+"\\n")' "$nonce"
printf 'BASH_HOLD_%s\\n' "$nonce"
IFS= read -r action
test "$action" = stop
printf 'BASH_STOP_%s\\n' "$nonce"
`;
async function main() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "arm64");
  assert.equal(process.versions.node, "22.23.2");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  if (process.argv.includes("--worker")) {
    await worker(argument("--worker"));
    return;
  }
  const work = path.resolve(argument("--work-root")),
    output = path.resolve(argument("--output")),
    node = path.join(work, "control/node.exe"),
    git = path.join(work, "git"),
    compat = path.join(work, "compatibility"),
    probe = path.join(work, "control/NemoClawMsysObjectProbe.exe"),
    mxc = path.resolve(argument("--mxc"));
  assert.match(work, /^[A-Za-z]:\\NemoClawMsysProof-[a-f0-9]{12}$/u);
  assert.equal(sha(node), "97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878");
  const mxcBuild = JSON.parse(
    fs.readFileSync(path.join(work, "control/mxc-token-inspection-build.json"), "utf8"),
  );
  const mxcFile = validateMxcInspectionBuild(
    mxcBuild,
    sha(path.join(path.dirname(fileURLToPath(import.meta.url)), "mxc-token-inspection.patch")),
  );
  assert.equal(fs.statSync(mxc).size, mxcFile.bytes);
  assert.equal(sha(mxc), mxcFile.sha256);
  const build = JSON.parse(fs.readFileSync(path.join(compat, "build-receipt.json"), "utf8"));
  assert.equal(build.classification, "mxc-msys-compatibility-prototype-build");
  assert.equal(build.status, "built");
  for (const file of build.files) {
    assert(
      [
        "NemoClawMsysLauncher.exe",
        "NemoClawMsysCompat-arm64.dll",
        "NemoClawMsysCompat-x64.dll",
      ].includes(file.file),
    );
    assert.equal(sha(path.join(compat, file.file)), file.sha256);
    assert.equal(fs.statSync(path.join(compat, file.file)).size, file.bytes);
  }
  assert.equal(build.files.length, 3);
  assert.equal(new Set(build.files.map((file: any) => file.file)).size, 3);
  const nonce = randomBytes(12).toString("hex"),
    windows = process.env.SYSTEMROOT ?? process.env.SystemRoot!;
  const env = { ...fixedEnvironment(windows, work, git, node), GITHUB_ACTIONS: "true" };
  const originalGit = path.join(work, "git-original");
  for (const [name, pin] of Object.entries(originalBinaryPins))
    assert.equal(sha(path.join(originalGit, name)), pin);
  const derivation = validateDerivedMetadata(
    JSON.parse(fs.readFileSync(path.join(work, "control/git-aslr-derivation.json"), "utf8")),
    process.env.GITHUB_SHA!,
  );
  const script = path.join(work, "control/bash-proof.sh");
  write(path.join(output, "compatibility-input.json"), build);
  fs.writeFileSync(script, scriptBody, { flag: "wx" });
  const source = fileURLToPath(import.meta.url),
    copied = path.join(work, "control/bash-compat.mts");
  fs.copyFileSync(source, copied, fs.constants.COPYFILE_EXCL);
  const executions: { c: Config; process: Owned }[] = [];
  const hostExecutions: Owned[] = [];
  const report: any = {
    schemaVersion: 1,
    classification: "small-msys-appcontainer-compatibility-proof",
    sourceRevision: process.env.GITHUB_SHA,
    nonce,
    phase: "baseline",
    imageVariant: variant,
    passed: false,
    startedExecutors: 0,
    inputs: {
      nodeSha256: sha(node),
      mxcSha256: sha(mxc),
      mxcBuild,
      gitDerivation: derivation,
      preservedOriginalGit: originalBinaryPins,
      git: Object.fromEntries(
        Object.keys(binaryPins).map((name) => [name, sha(path.join(git, name))]),
      ),
      compatibility: build,
    },
    stages: [],
    cleanup: {},
  };
  const save = () => atomic(path.join(output, "progress.json"), report);
  const start = (role: "base" | "start" | "a" | "b", mode: Config["mode"], key: string) => {
    // Keep every writable state outside the fully readonly input root so Node
    // can inspect its source ancestors without seeing another container state.
    const share = work + "-state-" + role;
    fs.mkdirSync(share);
    const c: Config = {
      nonce,
      containerId: "nm-" + nonce.slice(0, 12) + "-" + role,
      mode,
      share,
      node,
      git,
      compat,
      probe,
      key,
      script,
    };
    const config = path.join(work, "control/" + role + ".json");
    write(config, c);
    const policy = path.join(output, role + "-request.json");
    write(policy, request(c, copied, config, windows));
    const child = new Owned(
      mxc,
      [policy, "--log-file", path.join(output, role + "-mxc.log")],
      { ...env, NEMOCLAW_MSYS_TOKEN_INSPECTION: "repair-query" },
      share,
      125000,
    );
    const value = { c, process: child };
    executions.push(value);
    if (child.child.pid) report.startedExecutors++;
    child.child.stdin!.end();
    atomic(path.join(share, "host.json"), { nonce, executorPid: child.child.pid });
    return value;
  };
  const completed = async (value: (typeof executions)[number]) => {
    await value.process.finish();
    write(path.join(output, value.c.containerId + "-executor.json"), value.process.result());
    checkSuccess(value.process.result());
    const r = await waitFile(path.join(value.c.share, "done.json"), Date.now() + 1000);
    write(path.join(output, value.c.containerId + "-result.json"), r);
    report.stages.push(r);
    save();
    assert.equal(r.passed, true, r.error);
    return r;
  };
  try {
    save();
    const original = await completed(start("base", "baseline", "0000000000000000"));
    const key = original.key;
    assert.match(key, /^[a-f0-9]{16}$/u);
    report.installationKey = key;
    report.phase = "injected-startup-and-tools";
    save();
    await completed(start("start", "startup", key));
    report.phase = "two-container-isolation";
    save();
    assert(
      fs.existsSync(probe),
      "Native object probe was not built; earlier launch evidence remains.",
    );
    const a = start("a", "isolation", key),
      b = start("b", "isolation", key);
    const end = Date.now() + 50000;
    const ready = async (value: typeof a) => {
      while (Date.now() < end) {
        if (fs.existsSync(path.join(value.c.share, "done.json")))
          throw Error(fs.readFileSync(path.join(value.c.share, "done.json"), "utf8"));
        if (fs.existsSync(path.join(value.c.share, "ready.json")))
          return JSON.parse(fs.readFileSync(path.join(value.c.share, "ready.json"), "utf8"));
        await delay(50);
      }
      throw Error("Two-container readiness deadline");
    };
    const [ar, br] = await Promise.all([ready(a), ready(b)]);
    assert.notEqual(ar.sid, br.sid);
    assert.notEqual(ar.privateRoot, br.privateRoot);
    assert.equal(ar.session, br.session);
    // Keep the foreign endpoint available: each check finishes its own after
    // positives and restores listening before the other side is dispatched.
    atomic(path.join(a.c.share, "cross.json"), {
      nonce,
      ...foreignPipeTargets(br, key),
    });
    await waitFile(path.join(a.c.share, "checked.json"), Date.now() + 20000);
    atomic(path.join(b.c.share, "cross.json"), {
      nonce,
      ...foreignPipeTargets(ar, key),
    });
    await waitFile(path.join(b.c.share, "checked.json"), Date.now() + 20000);
    atomic(path.join(a.c.share, "stop.json"), { nonce });
    atomic(path.join(b.c.share, "stop.json"), { nonce });
    await Promise.all([completed(a), completed(b)]);
    for (const [file, pin] of Object.entries(binaryPins))
      assert.equal(sha(path.join(git, file)), pin);
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error);
  } finally {
    for (const value of executions) {
      if (!value.process.closed) {
        try {
          if (!fs.existsSync(path.join(value.c.share, "stop.json")))
            atomic(path.join(value.c.share, "stop.json"), { nonce });
        } catch {}
        await value.process.stop();
      }
      if (value.process.closed) {
        const deletion = new Owned(
          mxc,
          ["--delete", "--containername", value.c.containerId],
          env,
          work,
          15000,
        );
        deletion.child.stdin!.end();
        await deletion.finish();
        report.cleanup[value.c.containerId] = {
          executor: value.process.result(),
          deletion: deletion.result(),
        };
        if (deletion.child.exitCode !== 0 || !deletion.closed || deletion.forced)
          report.passed = false;
      } else {
        report.cleanup[value.c.containerId] = { executorClosed: false };
        report.passed = false;
      }
    }
    // Retain bounded guest phase/cleanup evidence after executor termination,
    // including failures that never reached the normal completed() path.
    report.retainedWorkerEvidence = [];
    for (const value of executions)
      if (value.process.closed) {
        for (const name of ["progress.json", "done.json", "ready.json", "checked.json"]) {
          const input = path.join(value.c.share, name);
          try {
            const stat = fs.lstatSync(input);
            assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024);
            const target = value.c.containerId + "-" + name;
            fs.copyFileSync(input, path.join(output, target), fs.constants.COPYFILE_EXCL);
            report.retainedWorkerEvidence.push(target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              report.evidenceRetentionError = String(error);
              report.passed = false;
            }
          }
        }
      }
    report.hostBaseline = [];
    const originalBashPassed = report.stages.some(
      (stage: any) => stage.mode === "startup" && stage.toolsPassed === true,
    );
    const aliasTargets = originalBashPassed
      ? aliasPipelineCases(nonce, true).map((test) => test.target)
      : [];
    report.aliasHostComparisonsRequired = originalBashPassed;
    if (
      executions.every((value) => value.process.closed) &&
      Object.values(report.cleanup).every(
        (v: any) => v.deletion?.closed && v.deletion?.exitCode === 0,
      )
    )
      for (const [label, tree] of [
        ["official-original", originalGit],
        [variant, git],
      ]) {
        for (const target of ["usr/bin/bash.exe", "bin/bash.exe", ...aliasTargets]) {
          const marker = "HOST_" + label + "_" + nonce;
          const child = new Owned(
            path.join(tree!, target),
            [
              "--noprofile",
              "--norc",
              "-c",
              "printf '%s\\n' '" + marker + "' | cat | grep -F -x '" + marker + "'",
            ],
            fixedEnvironment(windows, work, tree!, node),
            work,
            15000,
          );
          hostExecutions.push(child);
          child.child.stdin!.end();
          const r = await child.finish();
          report.hostBaseline.push({
            ...r,
            imageVariant: label,
            shell: target,
            pipeline: "printf|cat|grep",
          });
          try {
            checkSuccess(r, marker + "\n");
          } catch (error) {
            report.passed = false;
            report.hostBaselineError = String(error);
          }
        }
      }
    for (const value of executions) {
      const row = report.cleanup[value.c.containerId];
      row.shareRemoved = false;
      if (value.process.closed && row.deletion?.closed && row.deletion?.exitCode === 0) {
        try {
          fs.rmSync(value.c.share, { recursive: true });
          row.shareRemoved = !fs.existsSync(value.c.share);
        } catch (error) {
          row.shareRemovalError = String(error);
          report.passed = false;
        }
      }
    }
    report.startedHostProcesses = hostExecutions.length;
    report.hostProcessesClosed = hostExecutions.every((child) => child.closed);
    report.hostProcessesNormal = hostExecutions.every((child) => child.closed && !child.forced);
    report.normalCleanup =
      report.hostProcessesNormal &&
      executions.length > 0 &&
      report.startedExecutors === executions.length &&
      executions.every((value) => value.process.closed && !value.process.forced) &&
      Object.values(report.cleanup).every(
        (v: any) =>
          v.deletion?.exitCode === 0 && v.deletion?.closed && !v.deletion?.forced && v.shareRemoved,
      );
    if (!report.normalCleanup) report.passed = false;
    save();
    write(path.join(output, "result.json"), report);
  }
  if (!report.passed)
    throw Error("MSYS prototype failed at " + report.phase + "; see bounded stage receipts.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
