// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it, vi } from "vitest";
import {
  isSubprocessEnvNameAllowed,
  SUBPROCESS_ENV_ALLOWED_NAMES,
  SUBPROCESS_ENV_ALLOWED_PREFIXES,
} from "../../../src/lib/subprocess-env";
import {
  LAUNCH_TURN_SCRIPT,
  OPENCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT,
  OPENCLAW_LAUNCH_RUNTIME_ENV_SCRIPT,
  OPENCLAW_PTY_RECORD_WRITER_SCRIPT,
  OPENCLAW_SESSION_EVIDENCE_SCRIPT,
  runOpenClawLaunchSession,
  runOpenClawLaunchReadinessLeaseTurns,
} from "../live/launch-agent-turn.ts";

const PROCESS_EXIT_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

type SessionRecords = Record<string, string[]>;
type FixtureMode =
  | "cleanup-failure"
  | "delayed-input-attachment"
  | "delayed-recording"
  | "input-mode-timeout"
  | "invalid-order"
  | "late-extra"
  | "nonzero"
  | "nonzero-pty-cleanup-failure"
  | "pty-cleanup-failure"
  | "pty-cleanup-unknown-entry"
  | "pty-record-identity"
  | "pty-record-invalid"
  | "pty-record-permission"
  | "pty-record-timeout"
  | "pty-termios-unavailable"
  | "recording-timeout"
  | "valid";

function message(role: "assistant" | "user", content = "nonempty"): string {
  return JSON.stringify({
    message: { content: [{ text: content, type: "text" }], role },
    type: "message",
  });
}

function emptyMessage(role: "assistant" | "user"): string {
  return JSON.stringify({ message: { content: [], role }, type: "message" });
}

function writeSessionRecords(
  root: string,
  sessions: SessionRecords,
  append: boolean,
  finalNewline = true,
): void {
  for (const [sessionId, records] of Object.entries(sessions)) {
    const filePath = join(root, `${sessionId}.jsonl`);
    const body = records.length > 0 ? `${records.join("\n")}${finalNewline ? "\n" : ""}` : "";
    const writeRecords = append ? appendFileSync : writeFileSync;
    writeRecords(filePath, body);
  }
}

function withOwnedFixtureFile<T>(
  filePath: string,
  flags: number,
  action: (descriptor: number, stats: Stats) => T,
): T {
  const descriptor = openSync(filePath, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const stats = fstatSync(descriptor);
    expect([stats.isFile(), stats.uid, stats.mode & 0o777, stats.nlink]).toEqual([
      true,
      process.getuid?.(),
      0o600,
      1,
    ]);
    return action(descriptor, stats);
  } finally {
    closeSync(descriptor);
  }
}

function runEvidenceFixture(input: {
  after: SessionRecords;
  afterFinalNewline?: boolean;
  before?: SessionRecords;
  expectedTurns: number;
}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-evidence-"));
  const runId = randomUUID().replaceAll("-", "");
  const baselinePath = `/tmp/nemoclaw-launch-session-${runId}.json`;
  const ptyRecordRoot = `/tmp/nemoclaw-launch-turn-${runId}`;
  const sessionRoot = join(fixtureRoot, "sessions");
  mkdirSync(sessionRoot);
  try {
    writeSessionRecords(sessionRoot, input.before ?? {}, false);
    const baseline = spawnSync(
      process.execPath,
      [
        "-e",
        OPENCLAW_SESSION_EVIDENCE_SCRIPT,
        "baseline",
        sessionRoot,
        baselinePath,
        "",
        ptyRecordRoot,
        runId,
      ],
      { encoding: "utf8" },
    );
    writeSessionRecords(sessionRoot, input.after, true, input.afterFinalNewline ?? true);
    const qualification = spawnSync(
      process.execPath,
      [
        "-e",
        OPENCLAW_SESSION_EVIDENCE_SCRIPT,
        "qualify",
        sessionRoot,
        baselinePath,
        String(input.expectedTurns),
        ptyRecordRoot,
        runId,
      ],
      { encoding: "utf8" },
    );
    const baselineFile = withOwnedFixtureFile(
      baselinePath,
      constants.O_RDONLY,
      (descriptor, stats) => ({ body: readFileSync(descriptor, "utf8"), stats }),
    );
    return {
      baseline,
      baselineKeys: Object.keys(JSON.parse(baselineFile.body)).sort(),
      baselineMode: baselineFile.stats.mode & 0o777,
      baselineNlink: baselineFile.stats.nlink,
      baselineUid: baselineFile.stats.uid,
      qualification,
    };
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
    rmSync(baselinePath, { force: true });
    rmSync(`${baselinePath}.tmp`, { force: true });
    rmSync(ptyRecordRoot, { force: true, recursive: true });
  }
}

function runBaselineMutationFixture(mutation: "invalid" | "removed" | "rewritten" | "truncated") {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-baseline-"));
  const runId = randomUUID().replaceAll("-", "");
  const baselinePath = `/tmp/nemoclaw-launch-session-${runId}.json`;
  const ptyRecordRoot = `/tmp/nemoclaw-launch-turn-${runId}`;
  const sessionRoot = join(fixtureRoot, "sessions");
  const sessionPath = join(sessionRoot, "session-a.jsonl");
  mkdirSync(sessionRoot);
  writeSessionRecords(sessionRoot, { "session-a": [message("user"), message("assistant")] }, false);
  try {
    const baseline = spawnSync(
      process.execPath,
      [
        "-e",
        OPENCLAW_SESSION_EVIDENCE_SCRIPT,
        "baseline",
        sessionRoot,
        baselinePath,
        "",
        ptyRecordRoot,
        runId,
      ],
      { encoding: "utf8" },
    );
    const applyMutation: Record<typeof mutation, () => void> = {
      invalid: () =>
        withOwnedFixtureFile(baselinePath, constants.O_WRONLY, (descriptor) => {
          ftruncateSync(descriptor, 0);
          writeFileSync(descriptor, "{}");
          fsyncSync(descriptor);
        }),
      removed: () => rmSync(sessionPath),
      rewritten: () =>
        writeFileSync(
          sessionPath,
          readFileSync(sessionPath, "utf8").replace("nonempty", "changed!"),
        ),
      truncated: () => writeFileSync(sessionPath, ""),
    };
    applyMutation[mutation]();
    const qualification = spawnSync(
      process.execPath,
      [
        "-e",
        OPENCLAW_SESSION_EVIDENCE_SCRIPT,
        "qualify",
        sessionRoot,
        baselinePath,
        "1",
        ptyRecordRoot,
        runId,
      ],
      { encoding: "utf8" },
    );
    return { baseline, qualification };
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
    rmSync(baselinePath, { force: true });
    rmSync(`${baselinePath}.tmp`, { force: true });
    rmSync(ptyRecordRoot, { force: true, recursive: true });
  }
}

function runLaunchSessionFixture(mode: FixtureMode, terminalCopy: "absent" | "ansi" | "reordered") {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-turn-"));
  const fakeLaunch = join(fixtureRoot, "openclaw");
  const fakeOpenshell = join(fixtureRoot, "openshell");
  const fakeStty = join(fixtureRoot, "stty");
  const sessionRoot = join(fixtureRoot, "sessions");
  const tuiPidsPath = join(fixtureRoot, "tui-pids");
  const ttyMarker = join(fixtureRoot, "tty-observed");
  const openshellCallsRoot = join(fixtureRoot, "openshell-calls");
  const pendingQualificationMarker = join(fixtureRoot, "pending-qualification-observed");
  const ptyRecordReceiptPath = join(fixtureRoot, "pty-record-receipt.json");
  const runId = randomUUID().replaceAll("-", "");
  const baselinePath = `/tmp/nemoclaw-launch-session-${runId}.json`;
  const ptyRecordRoot = `/tmp/nemoclaw-launch-turn-${runId}`;
  mkdirSync(sessionRoot);
  mkdirSync(openshellCallsRoot, { mode: 0o700 });
  writeFileSync(
    join(fixtureRoot, ".bash_profile"),
    'export PATH="$NEMOCLAW_FIXTURE_BIN_ROOT:$PATH"\n',
  );

  try {
    writeFileSync(
      fakeStty,
      String.raw`#!/usr/bin/env bash
if [[ "$NEMOCLAW_FIXTURE_MODE" == "pty-termios-unavailable" ]]; then
  for _ in {1..200}; do
    [[ ! -e "$NEMOCLAW_FIXTURE_TTY_MARKER" ]] || exit 1
    sleep 0.01
  done
  exit 72
fi
exec /usr/bin/stty "$@"
`,
    );
    writeFileSync(
      fakeLaunch,
      String.raw`#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const readline = require("node:readline");

const mode = process.env.NEMOCLAW_FIXTURE_MODE;
if (process.argv[2] !== "tui") {
  const allowedNames = new Set(${JSON.stringify(SUBPROCESS_ENV_ALLOWED_NAMES)});
  const allowedPrefixes = ${JSON.stringify(SUBPROCESS_ENV_ALLOWED_PREFIXES)};
  const subprocessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        value !== undefined &&
        (allowedNames.has(name) ||
          allowedPrefixes.some((prefix) => name.startsWith(prefix)) ||
          name.startsWith("NEMOCLAW_FIXTURE_")),
    ),
  );
  const args = [
    "sandbox",
    "exec",
    "--name",
    process.argv[3],
    "-g",
    "fixture-gateway",
    "--tty",
    "--timeout",
    "0",
    "--",
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-p",
    "-c",
    process.env.NEMOCLAW_LAUNCH_RUNTIME_ENV_SCRIPT,
    "nemoclaw-runtime-env",
    "bash",
    "-lc",
    "openclaw tui",
  ];
  const result = childProcess.spawnSync(process.env.NEMOCLAW_OPENSHELL_BIN, args, {
    env: subprocessEnv,
    stdio: "inherit",
    timeout: 14_000,
    killSignal: "SIGKILL",
  });
  process.exit(result.status ?? 66);
}

(async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(64);
  fs.appendFileSync(process.env.NEMOCLAW_FIXTURE_TUI_PIDS, process.pid + "\n");
  const recordPath = process.env.NEMOCLAW_FIXTURE_PTY_RECORD_ROOT + "/pty-record.json";
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const recordStats = fs.lstatSync(recordPath);
  const rootStats = fs.lstatSync(process.env.NEMOCLAW_FIXTURE_PTY_RECORD_ROOT);
  fs.writeFileSync(process.env.NEMOCLAW_FIXTURE_PTY_RECORD_RECEIPT, JSON.stringify({
    record,
    recordMode: recordStats.mode & 0o777,
    recordNlink: recordStats.nlink,
    recordUid: recordStats.uid,
    rootMode: rootStats.mode & 0o777,
    rootUid: rootStats.uid,
    temporaryExists: fs.existsSync(process.env.NEMOCLAW_FIXTURE_PTY_RECORD_ROOT + "/pty-record.json.tmp"),
  }));
  if (mode === "pty-record-invalid") fs.writeFileSync(recordPath, "{}\n");
  if (mode === "pty-record-identity") {
    record.rdev = record.rdev === "0" ? "1" : "0";
    fs.writeFileSync(recordPath, JSON.stringify(record) + "\n");
  }
  if (mode === "pty-record-permission") fs.chmodSync(recordPath, 0);
  if (mode === "pty-cleanup-unknown-entry") {
    fs.writeFileSync(process.env.NEMOCLAW_FIXTURE_PTY_RECORD_ROOT + "/unexpected", "owned test residue");
  }
  fs.writeFileSync(process.env.NEMOCLAW_FIXTURE_TTY_MARKER, "");
  const sessionFile = process.env.NEMOCLAW_FIXTURE_SESSION_FILE;
  const terminalCopy = process.env.NEMOCLAW_FIXTURE_TERMINAL_COPY;
  const append = (role, content) => fs.appendFileSync(
    sessionFile,
    JSON.stringify({ message: { content: [{ text: content, type: "text" }], role }, type: "message" }) + "\n",
  );
  if (mode === "delayed-input-attachment" || mode === "input-mode-timeout") {
    let inputBeforeAttachment = false;
    const recordEarlyInput = () => { inputBeforeAttachment = true; };
    process.stdin.on("data", recordEarlyInput);
    await new Promise((resolve) => setTimeout(resolve, mode === "input-mode-timeout" ? 10_000 : 1_500));
    process.stdin.off("data", recordEarlyInput);
    if (inputBeforeAttachment) process.exit(67);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = () => new Promise((resolve) => rl.question("", resolve));
  if (terminalCopy === "ansi") process.stdout.write("\u001b[2Kgateway connected | idle\r");
  if (terminalCopy === "reordered") process.stdout.write("idle | gateway connected\n");

  const first = await ask();
  const delayedInputs = [];
  if (mode === "delayed-recording") {
    const recordDelayedInput = (line) => delayedInputs.push(line);
    rl.on("line", recordDelayedInput);
    const publicationDeadline = Date.now() + 2_000;
    while (!fs.existsSync(process.env.NEMOCLAW_FIXTURE_PENDING_QUALIFICATION_MARKER)) {
      if (Date.now() >= publicationDeadline) process.exit(68);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    rl.off("line", recordDelayedInput);
  }
  if (mode === "recording-timeout") await new Promise((resolve) => setTimeout(resolve, 10_000));
  if (mode === "invalid-order") {
    append("assistant", "response before input");
    append("user", first);
  } else {
    append("user", first);
    append("assistant", "first response");
  }
  for (const duplicate of delayedInputs) {
    append("user", duplicate);
    append("assistant", "duplicate response");
  }

  const second = await ask();
  append("user", second);
  append("assistant", "second response");
  const exitCommand = await ask();
  if (mode === "late-extra") append("user", first);
  rl.close();
  if (exitCommand !== "/exit") process.exit(65);
  process.exit(mode.includes("nonzero") ? 23 : 0);
})().catch(() => process.exit(66));
`,
    );
    writeFileSync(
      fakeOpenshell,
      String.raw`#!/usr/bin/env bash
set -euo pipefail
node -e '
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const authorityNames = Object.keys(process.env)
  .filter(
    (name) =>
      name === "NEMOCLAW_OPENSHELL_BIN" ||
      name === "NEMOCLAW_OPENSHELL_COMMAND" ||
      name.startsWith("NEMOCLAW_LAUNCH_") ||
      name.startsWith("OPENSHELL_NEMOCLAW_LAUNCH_"),
  )
  .sort();
fs.writeFileSync(
  path.join(
    process.env.NEMOCLAW_FIXTURE_OPENSHELL_CALLS,
    process.pid + "-" + crypto.randomUUID() + ".json",
  ),
  JSON.stringify({ argv: process.argv.slice(1), authorityNames }),
  { flag: "wx", mode: 0o600 },
);
' "$@"
while [[ "$#" -gt 0 && "$1" != "--" ]]; do shift; done
[[ "$#" -gt 0 ]]
shift
case "$NEMOCLAW_FIXTURE_MODE:$4" in
  pty-record-invalid:input-mode|pty-record-permission:input-mode|pty-record-identity:input-mode)
    [[ -e "$NEMOCLAW_FIXTURE_TTY_MARKER" ]] || exit 1
    ;;
esac
if [[ "$NEMOCLAW_FIXTURE_MODE" == "cleanup-failure" && "$4" == "cleanup-baseline" ]]; then
  exit 71
fi
if [[ ( "$NEMOCLAW_FIXTURE_MODE" == "pty-cleanup-failure" || "$NEMOCLAW_FIXTURE_MODE" == "nonzero-pty-cleanup-failure" ) && "$4" == "cleanup-pty" ]]; then
  exit 71
fi
if [[ "$NEMOCLAW_FIXTURE_MODE" == "pty-record-timeout" && "$4" == "$NEMOCLAW_FIXTURE_RUN_ID" ]]; then
  exec node -e 'setTimeout(() => process.exit(0), 10_000)'
fi
if [[ "$NEMOCLAW_FIXTURE_MODE" == "delayed-recording" && "$4" == "qualify" && "$7" == "1" ]]; then
  set +e
  "$@"
  status=$?
  set -e
  [[ "$status" != "1" ]] || : > "$NEMOCLAW_FIXTURE_PENDING_QUALIFICATION_MARKER"
  exit "$status"
fi
exec "$@"
`,
    );
    chmodSync(fakeLaunch, 0o755);
    chmodSync(fakeOpenshell, 0o755);
    chmodSync(fakeStty, 0o755);

    const result = spawnSync("bash", ["-c", LAUNCH_TURN_SCRIPT], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        HOME: fixtureRoot,
        NEMOCLAW_FIXTURE_BIN_ROOT: fixtureRoot,
        NEMOCLAW_FIXTURE_MODE: mode,
        NEMOCLAW_FIXTURE_OPENSHELL_CALLS: openshellCallsRoot,
        NEMOCLAW_FIXTURE_PENDING_QUALIFICATION_MARKER: pendingQualificationMarker,
        NEMOCLAW_FIXTURE_PTY_RECORD_ROOT: ptyRecordRoot,
        NEMOCLAW_FIXTURE_SESSION_FILE: join(sessionRoot, "session-a.jsonl"),
        NEMOCLAW_FIXTURE_TERMINAL_COPY: terminalCopy,
        NEMOCLAW_FIXTURE_PTY_RECORD_RECEIPT: ptyRecordReceiptPath,
        NEMOCLAW_FIXTURE_RUN_ID: runId,
        NEMOCLAW_FIXTURE_TUI_PIDS: tuiPidsPath,
        NEMOCLAW_FIXTURE_TTY_MARKER: ttyMarker,
        NEMOCLAW_LAUNCH_COMMAND: fakeLaunch,
        NEMOCLAW_LAUNCH_ENTRYPOINT: "",
        NEMOCLAW_LAUNCH_EXIT_COMMAND: "/exit",
        NEMOCLAW_LAUNCH_FIRST_INPUT: "first input",
        NEMOCLAW_LAUNCH_HOST_TMP_ROOT: fixtureRoot,
        NEMOCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT: OPENCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT,
        NEMOCLAW_LAUNCH_PTY_RECORD_WRITER_SCRIPT: OPENCLAW_PTY_RECORD_WRITER_SCRIPT,
        NEMOCLAW_LAUNCH_RUN_ID: runId,
        NEMOCLAW_LAUNCH_RUNTIME_ENV_SCRIPT: OPENCLAW_LAUNCH_RUNTIME_ENV_SCRIPT,
        NEMOCLAW_LAUNCH_SANDBOX: "sandbox",
        NEMOCLAW_LAUNCH_SESSION_BUDGET_SECONDS: mode.endsWith("-timeout") ? "2" : "230",
        NEMOCLAW_LAUNCH_SECOND_INPUT: "second input",
        NEMOCLAW_LAUNCH_SESSION_EVIDENCE_SCRIPT: OPENCLAW_SESSION_EVIDENCE_SCRIPT,
        NEMOCLAW_LAUNCH_SESSION_ROOT: sessionRoot,
        NEMOCLAW_OPENSHELL_COMMAND: fakeOpenshell,
        PATH: `${fixtureRoot}:${process.env.PATH ?? ""}`,
        TERM: "xterm-256color",
      },
      timeout: 15_000,
    });

    const tuiProcessIds = existsSync(tuiPidsPath)
      ? readFileSync(tuiPidsPath, "utf8").trim().split("\n").filter(Boolean)
      : [];
    const processExitDeadline = Date.now() + 1_000;
    while (
      tuiProcessIds.some((pid) => existsSync(`/proc/${pid}`)) &&
      Date.now() < processExitDeadline
    ) {
      Atomics.wait(PROCESS_EXIT_WAIT, 0, 0, 25);
    }
    return {
      baselineRemoved: !existsSync(baselinePath),
      hostSessionResidue: readdirSync(fixtureRoot).filter((name) =>
        name.startsWith("nemoclaw-launch-host."),
      ),
      orphanedTuiProcessIds: tuiProcessIds.filter((pid) => existsSync(`/proc/${pid}`)),
      openshellCalls: readdirSync(openshellCallsRoot)
        .sort()
        .map(
          (name) =>
            JSON.parse(readFileSync(join(openshellCallsRoot, name), "utf8")) as {
              argv: string[];
              authorityNames: string[];
            },
        ),
      pendingQualificationObserved: existsSync(pendingQualificationMarker),
      ptyRecordRemoved: !existsSync(ptyRecordRoot),
      ptyRecordReceipt: existsSync(ptyRecordReceiptPath)
        ? JSON.parse(readFileSync(ptyRecordReceiptPath, "utf8"))
        : null,
      result,
      tuiProcessIds,
      ttyObserved: existsSync(ttyMarker),
    };
  } finally {
    const ptyRecordPath = join(ptyRecordRoot, "pty-record.json");
    existsSync(ptyRecordRoot) ? chmodSync(ptyRecordRoot, 0o700) : undefined;
    existsSync(ptyRecordPath) ? chmodSync(ptyRecordPath, 0o600) : undefined;
    rmSync(fixtureRoot, { force: true, recursive: true });
    rmSync(baselinePath, { force: true });
    rmSync(`${baselinePath}.tmp`, { force: true });
    rmSync(ptyRecordRoot, { force: true, recursive: true });
  }
}

function openShellLaunchArgv(sandboxName: string, gatewayArgs: string[]): string[] {
  return [
    "sandbox",
    "exec",
    "--name",
    sandboxName,
    ...gatewayArgs,
    "--tty",
    "--timeout",
    "0",
    "--",
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-p",
    "-c",
    OPENCLAW_LAUNCH_RUNTIME_ENV_SCRIPT,
    "nemoclaw-runtime-env",
    "bash",
    "-lc",
    "openclaw tui",
  ];
}

function runOpenShellShimFixture(gatewayArgs: string[]) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-shim-"));
  const realOpenShell = join(fixtureRoot, "openshell-real");
  const shim = join(fixtureRoot, "openshell-shim");
  const callsPath = join(fixtureRoot, "calls.jsonl");
  const interceptPath = join(fixtureRoot, "intercept.json");
  const runId = randomUUID().replaceAll("-", "");
  const sandboxName = "sandbox";
  writeFileSync(
    realOpenShell,
    String.raw`#!/usr/bin/env node
require("node:fs").appendFileSync(
  ${JSON.stringify(callsPath)},
  JSON.stringify({
    argv: process.argv.slice(2),
    authorityNames: Object.keys(process.env)
      .filter(
        (name) =>
          name === "NEMOCLAW_OPENSHELL_BIN" ||
          name === "NEMOCLAW_OPENSHELL_COMMAND" ||
          name.startsWith("NEMOCLAW_LAUNCH_") ||
          name.startsWith("OPENSHELL_NEMOCLAW_LAUNCH_"),
      )
      .sort(),
  }) + "\n",
);
`,
  );
  writeFileSync(shim, OPENCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT);
  chmodSync(realOpenShell, 0o755);
  chmodSync(shim, 0o755);
  const hostEnv = {
    ...process.env,
    NEMOCLAW_LAUNCH_COMMAND: "nemoclaw",
    NEMOCLAW_LAUNCH_FIRST_INPUT: "fixture input",
    NEMOCLAW_LAUNCH_INTERCEPT_PATH: interceptPath,
    NEMOCLAW_LAUNCH_PTY_RECORD_WRITER_SCRIPT: OPENCLAW_PTY_RECORD_WRITER_SCRIPT,
    NEMOCLAW_LAUNCH_RUN_ID: runId,
    NEMOCLAW_LAUNCH_RUNTIME_ENV_SCRIPT: OPENCLAW_LAUNCH_RUNTIME_ENV_SCRIPT,
    NEMOCLAW_LAUNCH_SANDBOX: sandboxName,
    NEMOCLAW_LAUNCH_SESSION_EVIDENCE_SCRIPT: OPENCLAW_SESSION_EVIDENCE_SCRIPT,
    NEMOCLAW_OPENSHELL_BIN: shim,
    NEMOCLAW_OPENSHELL_COMMAND: realOpenShell,
    OPENSHELL_NEMOCLAW_LAUNCH_INTERCEPT_PATH: interceptPath,
    OPENSHELL_NEMOCLAW_LAUNCH_PTY_RECORD_WRITER_SCRIPT: OPENCLAW_PTY_RECORD_WRITER_SCRIPT,
    OPENSHELL_NEMOCLAW_LAUNCH_REAL_COMMAND: realOpenShell,
    OPENSHELL_NEMOCLAW_LAUNCH_RUN_ID: runId,
    OPENSHELL_NEMOCLAW_LAUNCH_RUNTIME_ENV_SCRIPT: OPENCLAW_LAUNCH_RUNTIME_ENV_SCRIPT,
    OPENSHELL_NEMOCLAW_LAUNCH_SANDBOX: sandboxName,
  };
  const env = Object.fromEntries(
    Object.entries(hostEnv).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && isSubprocessEnvNameAllowed(entry[0]),
    ),
  );
  const runShim = (args: string[], childEnv: NodeJS.ProcessEnv = env) =>
    spawnSync(process.execPath, [shim, ...args], {
      encoding: "utf8",
      env: childEnv,
      timeout: 2_000,
      killSignal: "SIGKILL",
    });
  const passThroughArgv = ["sandbox", "exec", "--name", sandboxName, "--", "true"];
  const ttyPassThroughArgv = [
    "sandbox",
    "exec",
    "--name",
    sandboxName,
    "--tty",
    "--timeout",
    "0",
    "--",
    "bash",
    "-lc",
    "printf '%s\\n' --tty",
  ];
  const exactArgv = openShellLaunchArgv(sandboxName, gatewayArgs);
  const malformedArgv = [...exactArgv];
  const ttyIndex = malformedArgv.indexOf("--tty");
  malformedArgv.splice(ttyIndex, 3, "--timeout", "0", "--tty");
  try {
    const passThrough = runShim(passThroughArgv, hostEnv);
    const ttyPassThrough = runShim(ttyPassThroughArgv);
    const malformed = runShim(malformedArgv);
    const intercepted = runShim(exactArgv);
    const duplicate = runShim(exactArgv);
    const records = readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[]; authorityNames: string[] });
    return {
      authorityNames: records.map((record) => record.authorityNames),
      calls: records.map((record) => record.argv),
      duplicate,
      exactArgv,
      interceptMode: statSync(interceptPath).mode & 0o777,
      intercepted,
      malformed,
      passThrough,
      passThroughArgv,
      ttyPassThrough,
      ttyPassThroughArgv,
      recordRoot: `/tmp/nemoclaw-launch-turn-${runId}`,
      runId,
    };
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

it("qualifies two ordered structured turns without comparing message content (#9160)", () => {
  const { baseline, baselineKeys, baselineMode, baselineNlink, baselineUid, qualification } =
    runEvidenceFixture({
      after: {
        "session-a": [
          message("user", "first arbitrary input"),
          message("assistant", "first arbitrary response"),
          message("user", "different second input"),
          message("assistant", "different second response"),
        ],
      },
      expectedTurns: 2,
    });

  expect(baseline.status).toBe(0);
  expect(baselineKeys).toEqual(["schemaVersion", "sessions"]);
  expect(baselineMode).toBe(0o600);
  expect(baselineNlink).toBe(1);
  expect(baselineUid).toBe(process.getuid?.());
  expect(qualification.status).toBe(0);
});

it("keeps a partial structured turn pending (#9160)", () => {
  const { baseline, qualification } = runEvidenceFixture({
    after: { "session-a": [message("user")] },
    expectedTurns: 1,
  });

  expect(baseline.status).toBe(0);
  expect(qualification.status).toBe(1);
});

it("does not qualify structured turns recorded before the baseline (#9160)", () => {
  const { baseline, qualification } = runEvidenceFixture({
    before: { "session-a": [message("user"), message("assistant")] },
    after: {},
    expectedTurns: 1,
  });

  expect(baseline.status).toBe(0);
  expect(qualification.status).toBe(1);
});

it.each([
  { "session-a": [message("assistant"), message("user")] },
  { "session-a": [message("user"), message("user"), message("assistant")] },
  { "session-a": [message("user"), message("assistant"), message("assistant")] },
  { "session-a": [message("user"), "not-json", message("assistant")] },
  { "session-a": [emptyMessage("user"), message("assistant")] },
  { "session-a": [message("user"), message("assistant")], "session-b": [message("user")] },
] as SessionRecords[])(
  "rejects malformed, empty, duplicated, extra, out-of-order, or cross-session records [case %#] (#9160)",
  (after) => {
    const { baseline, qualification } = runEvidenceFixture({ after, expectedTurns: 1 });
    expect(baseline.status).toBe(0);
    expect(qualification.status).toBe(2);
  },
);

it("rejects an unterminated appended session record (#9160)", () => {
  const { baseline, qualification } = runEvidenceFixture({
    after: {
      "session-a": [
        message("user"),
        message("assistant"),
        message("user"),
        message("assistant"),
        message("user"),
      ],
    },
    afterFinalNewline: false,
    expectedTurns: 2,
  });

  expect(baseline.status).toBe(0);
  expect(qualification.status).toBe(2);
});

it.each(["invalid", "removed", "rewritten", "truncated"] as const)(
  "rejects an invalid baseline or a removed, rewritten, or truncated session [case %#] (#9160)",
  (mutation) => {
    const { baseline, qualification } = runBaselineMutationFixture(mutation);
    expect(baseline.status).toBe(0);
    expect(qualification.status).toBe(2);
  },
);

it.each([[], ["-g", "fixture-gateway"]].map((gatewayArgs) => [gatewayArgs] as const))(
  "intercepts one OpenClaw launch, preserves pass-through argv, and strips launch authority from filtered and inherited environments [case %#] (#9160)",
  (gatewayArgs) => {
    const fixture = runOpenShellShimFixture(gatewayArgs);
    const separator = fixture.exactArgv.indexOf("--");
    const expectedRemote = fixture.exactArgv.slice(separator + 1);

    expect(fixture.passThrough.status, fixture.passThrough.stderr).toBe(0);
    expect(fixture.ttyPassThrough.status, fixture.ttyPassThrough.stderr).toBe(0);
    expect(fixture.malformed.status).toBe(73);
    expect(fixture.malformed.stderr).toContain('"reason":"openshell_launch_invocation_invalid"');
    expect(fixture.intercepted.status, fixture.intercepted.stderr).toBe(0);
    expect(fixture.duplicate.status).toBe(73);
    expect(fixture.duplicate.stderr).toContain('"reason":"openshell_launch_intercept_duplicate"');
    expect(fixture.interceptMode).toBe(0o600);
    expect(fixture.calls).toHaveLength(3);
    expect(fixture.authorityNames).toEqual([[], [], []]);
    expect(fixture.calls[0]).toEqual(fixture.passThroughArgv);
    expect(fixture.calls[1]).toEqual(fixture.ttyPassThroughArgv);
    expect(fixture.calls[2]?.slice(0, separator + 1)).toEqual(
      fixture.exactArgv.slice(0, separator + 1),
    );
    expect(fixture.calls[2]?.slice(separator + 1)).toEqual([
      "node",
      "-e",
      OPENCLAW_PTY_RECORD_WRITER_SCRIPT,
      fixture.runId,
      fixture.recordRoot,
      ...expectedRemote,
    ]);
  },
);

it.runIf(process.platform === "linux")(
  "rejects a record writer whose standard input is not a PTY (#9160)",
  () => {
    const runId = randomUUID().replaceAll("-", "");
    const recordRoot = `/tmp/nemoclaw-launch-turn-${runId}`;
    try {
      const result = spawnSync(
        process.execPath,
        ["-e", OPENCLAW_PTY_RECORD_WRITER_SCRIPT, runId, recordRoot, "/usr/bin/env", "true"],
        { encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL" },
      );

      expect(result.status).toBe(72);
      expect(result.stderr).toContain('"reason":"pty_stdin_not_pty"');
      expect(statSync(recordRoot).mode & 0o777).toBe(0o700);
      expect(existsSync(join(recordRoot, "pty-record.json"))).toBe(false);
    } finally {
      rmSync(recordRoot, { force: true, recursive: true });
    }
  },
);

it.runIf(process.platform === "linux").each(["absent", "ansi", "reordered"] as const)(
  "sends two inputs and /exit through a real PTY, strips launch authority from OpenShell calls, and ignores terminal copy evidence [%s] (#9160)",
  (terminalCopy) => {
    const {
      baselineRemoved,
      hostSessionResidue,
      openshellCalls,
      orphanedTuiProcessIds,
      ptyRecordReceipt,
      ptyRecordRemoved,
      result,
      tuiProcessIds,
      ttyObserved,
    } = runLaunchSessionFixture("valid", terminalCopy);

    expect(ttyObserved, result.stderr).toBe(true);
    expect(baselineRemoved).toBe(true);
    expect(ptyRecordRemoved).toBe(true);
    expect(hostSessionResidue).toEqual([]);
    expect(openshellCalls.length).toBeGreaterThan(3);
    expect(openshellCalls.every((call) => call.authorityNames.length === 0)).toBe(true);
    expect(openshellCalls.some((call) => call.argv.includes("baseline"))).toBe(true);
    expect(
      openshellCalls.some((call) => call.argv.includes(OPENCLAW_PTY_RECORD_WRITER_SCRIPT)),
    ).toBe(true);
    expect(tuiProcessIds).toHaveLength(1);
    expect(orphanedTuiProcessIds).toEqual([]);
    expect(ptyRecordReceipt).toMatchObject({
      recordMode: 0o600,
      recordNlink: 1,
      recordUid: process.getuid?.(),
      rootMode: 0o700,
      rootUid: process.getuid?.(),
      temporaryExists: false,
    });
    expect(Object.keys(ptyRecordReceipt.record).sort()).toEqual([
      "dev",
      "ino",
      "rdev",
      "runId",
      "schemaVersion",
      "ttyPath",
    ]);
    expect(ptyRecordReceipt.record.ttyPath).toMatch(/^\/dev\/pts\/\d+$/);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  },
);

it.runIf(process.platform === "linux")(
  "waits for the OpenClaw TUI input mode before submitting PTY input (#9160)",
  () => {
    const { baselineRemoved, result, ttyObserved } = runLaunchSessionFixture(
      "delayed-input-attachment",
      "absent",
    );

    expect(ttyObserved).toBe(true);
    expect(baselineRemoved).toBe(true);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  },
);

it.runIf(process.platform === "linux").each([
  {
    mode: "pty-record-invalid",
    reason: "pty_record_invalid",
    behavior: "invalid PTY record",
  },
  {
    mode: "pty-record-permission",
    reason: "pty_record_unavailable",
    behavior: "unreadable PTY record",
  },
  {
    mode: "pty-record-identity",
    reason: "pty_identity_changed",
    behavior: "changed PTY device identity",
  },
  {
    mode: "pty-termios-unavailable",
    reason: "pty_termios_unavailable",
    behavior: "unavailable PTY terminal state",
  },
] as const)("rejects $behavior before PTY input (#9160)", ({ mode, reason }) => {
  const { baselineRemoved, orphanedTuiProcessIds, result, ttyObserved } = runLaunchSessionFixture(
    mode,
    "absent",
  );
  const failureEvidence = `${mode}: ${result.stderr}`;

  expect(ttyObserved, failureEvidence).toBe(true);
  expect(orphanedTuiProcessIds, failureEvidence).toEqual([]);
  expect(baselineRemoved, failureEvidence).toBe(true);
  expect(result.signal, failureEvidence).toBeNull();
  expect(result.status, failureEvidence).toBe(1);
  expect(result.stderr, failureEvidence).toContain(`"reason":"${reason}"`);
});

it.runIf(process.platform === "linux")(
  "submits each PTY turn once while structured recording is delayed (#9160)",
  () => {
    const { baselineRemoved, pendingQualificationObserved, result, ttyObserved } =
      runLaunchSessionFixture("delayed-recording", "absent");

    expect(ttyObserved).toBe(true);
    expect(pendingQualificationObserved).toBe(true);
    expect(baselineRemoved).toBe(true);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  },
);

it.runIf(process.platform === "linux")(
  "fails when the PTY remains in canonical input mode until the session deadline (#9160)",
  () => {
    const { baselineRemoved, result, ttyObserved } = runLaunchSessionFixture(
      "input-mode-timeout",
      "absent",
    );

    expect(ttyObserved).toBe(true);
    expect(baselineRemoved).toBe(true);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "launch did not provide a recorded PTY in noncanonical input mode before the session deadline or PTY child exit",
    );
    expect(result.stderr).toContain('"reason":"pty_input_canonical"');
  },
);

it.runIf(process.platform === "linux")(
  "fails when the PTY record remains missing until the session deadline (#9160)",
  () => {
    const { baselineRemoved, ptyRecordRemoved, result, ttyObserved } = runLaunchSessionFixture(
      "pty-record-timeout",
      "absent",
    );

    expect(ttyObserved).toBe(false);
    expect(baselineRemoved).toBe(true);
    expect(ptyRecordRemoved).toBe(true);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"reason":"pty_record_missing"');
  },
);

it.runIf(process.platform === "linux")(
  "reports missing structured turns before the PTY child timeout (#9160)",
  () => {
    const { baselineRemoved, result, ttyObserved } = runLaunchSessionFixture(
      "recording-timeout",
      "absent",
    );

    expect(ttyObserved).toBe(true);
    expect(baselineRemoved).toBe(true);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("launch did not record the required structured session turns");
  },
);

it.runIf(process.platform === "linux")(
  "rejects out-of-order structured records even when the PTY process remains active (#9160)",
  () => {
    const { baselineRemoved, result, ttyObserved } = runLaunchSessionFixture(
      "invalid-order",
      "absent",
    );

    expect(ttyObserved).toBe(true);
    expect(baselineRemoved).toBe(true);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
  },
);

it.runIf(process.platform === "linux")(
  "rejects a late extra structured record before baseline cleanup (#9160)",
  () => {
    const { baselineRemoved, result, ttyObserved } = runLaunchSessionFixture(
      "late-extra",
      "absent",
    );

    expect(ttyObserved).toBe(true);
    expect(baselineRemoved).toBe(true);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "launch final structured session evidence did not qualify (status 2)",
    );
    expect(result.stderr).toContain('"reason":"extra_message"');
  },
);

it.runIf(process.platform === "linux")(
  "propagates a nonzero TUI exit after two structured turns (#9160)",
  () => {
    const { baselineRemoved, result, ttyObserved } = runLaunchSessionFixture("nonzero", "absent");

    expect(ttyObserved).toBe(true);
    expect(baselineRemoved).toBe(true);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(23);
  },
);

it.runIf(process.platform === "linux")(
  "fails when an accepted PTY session cannot run PTY record cleanup (#9160)",
  () => {
    const { hostSessionResidue, orphanedTuiProcessIds, ptyRecordRemoved, result } =
      runLaunchSessionFixture("pty-cleanup-failure", "absent");

    expect(ptyRecordRemoved).toBe(false);
    expect(hostSessionResidue).toEqual([]);
    expect(orphanedTuiProcessIds).toEqual([]);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("launch could not remove the PTY record");
  },
);

it.runIf(process.platform === "linux")(
  "refuses to remove an unknown entry from the private PTY record directory (#9160)",
  () => {
    const { orphanedTuiProcessIds, ptyRecordRemoved, result } = runLaunchSessionFixture(
      "pty-cleanup-unknown-entry",
      "absent",
    );

    expect(ptyRecordRemoved).toBe(false);
    expect(orphanedTuiProcessIds).toEqual([]);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"reason":"pty_record_cleanup_unknown_entry"');
  },
);

it.runIf(process.platform === "linux")(
  "fails when a successful PTY session cannot remove its structured baseline (#9160)",
  () => {
    const { baselineRemoved, result, ttyObserved } = runLaunchSessionFixture(
      "cleanup-failure",
      "absent",
    );

    expect(ttyObserved).toBe(true);
    expect(baselineRemoved).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
  },
);

it.runIf(process.platform === "linux")(
  "preserves a nonzero PTY exit when PTY record cleanup also fails (#9160)",
  () => {
    const { baselineRemoved, ptyRecordRemoved, result, ttyObserved } = runLaunchSessionFixture(
      "nonzero-pty-cleanup-failure",
      "absent",
    );

    expect(ttyObserved).toBe(true);
    expect(baselineRemoved).toBe(true);
    expect(ptyRecordRemoved).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(23);
  },
);

it.runIf(process.platform === "linux")(
  "rejects a relative OpenShell command before launching a host command (#9160)",
  async () => {
    let commandCallCount = 0;
    const host = {
      command: async () => {
        commandCallCount += 1;
        return { exitCode: 0, signal: null, stderr: "", stdout: "" };
      },
      openshellCommandPath: "openshell",
    };

    await expect(
      runOpenClawLaunchSession({
        artifactName: "relative-openshell-command",
        cliCommand: "node",
        env: {},
        host: host as never,
        redactionValues: [],
        sandboxName: "alpha",
      }),
    ).rejects.toThrow("launch session coverage requires an absolute OpenShell command path");
    expect(commandCallCount).toBe(0);
  },
);

it.each(["", "relative-tmp", "/tmp/absolute-tmp"])(
  "passes an absolute host temporary root for empty, relative, or absolute TMPDIR input [%s] (#9160)",
  async (root) => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const roots: Array<string | undefined> = [];
    const host = {
      command: async (_command: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        roots.push(options?.env?.NEMOCLAW_LAUNCH_HOST_TMP_ROOT);
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      },
      openshellCommandPath: "/usr/bin/openshell",
    };

    try {
      await runOpenClawLaunchSession({
        artifactName: "host-temporary-root",
        cliCommand: "node",
        env: { TMPDIR: root },
        host: host as never,
        redactionValues: [],
        sandboxName: "alpha",
      });

      expect(roots).toEqual([root === "" ? resolve("/tmp") : resolve(root)]);
    } finally {
      platform.mockRestore();
    }
  },
);

it.runIf(process.platform === "linux")(
  "runs the producer then two PTY launch sessions under one lease (#8942, #9023, #9160)",
  async () => {
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    let launchPhaseStartedAtCallCount = -1;
    const host = {
      command: async (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ command, args, env: options?.env });
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      },
      openshellCommandPath: "/usr/bin/openshell",
    };

    await runOpenClawLaunchReadinessLeaseTurns({
      artifactName: "lease-turn",
      cliCommand: "node",
      cliEntrypoint: "/repo/bin/nemoclaw.js",
      env: {},
      exitCommand: "/exit",
      host: host as never,
      redactionValues: [],
      sandboxName: "alpha",
      beforeLaunchTurns: () => {
        launchPhaseStartedAtCallCount = calls.length;
      },
    });

    expect(launchPhaseStartedAtCallCount).toBe(1);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      command: "node",
      args: ["/repo/bin/nemoclaw.js", "alpha", "connect", "--probe-only"],
    });
    expect(calls.slice(1).map((call) => call.command)).toEqual(["bash", "bash"]);
    expect(calls.slice(1).map((call) => call.args)).toEqual([
      ["-lc", LAUNCH_TURN_SCRIPT],
      ["-lc", LAUNCH_TURN_SCRIPT],
    ]);
    expect(calls.slice(1).map((call) => call.env?.NEMOCLAW_LAUNCH_EXIT_COMMAND)).toEqual([
      "/exit",
      "/exit",
    ]);
    expect(calls.slice(1).map((call) => call.env?.NEMOCLAW_OPENSHELL_COMMAND)).toEqual([
      "/usr/bin/openshell",
      "/usr/bin/openshell",
    ]);
    for (const call of calls.slice(1)) {
      expect(call.env).not.toHaveProperty("NEMOCLAW_LAUNCH_EXPECTED_REPLY");
      expect(call.env).not.toHaveProperty("NEMOCLAW_LAUNCH_POST_REPLY_READY_TEXT");
      expect(call.env).not.toHaveProperty("NEMOCLAW_LAUNCH_PROMPT");
      expect(call.env).not.toHaveProperty("NEMOCLAW_LAUNCH_READY_TEXT");
      expect(typeof call.env?.NEMOCLAW_LAUNCH_FIRST_INPUT).toBe("string");
      expect(typeof call.env?.NEMOCLAW_LAUNCH_SECOND_INPUT).toBe("string");
      expect(call.env?.NEMOCLAW_LAUNCH_FIRST_INPUT).not.toBe(
        call.env?.NEMOCLAW_LAUNCH_SECOND_INPUT,
      );
      expect(call.env?.NEMOCLAW_LAUNCH_SESSION_EVIDENCE_SCRIPT).toBe(
        OPENCLAW_SESSION_EVIDENCE_SCRIPT,
      );
      expect(call.env?.NEMOCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT).toBe(
        OPENCLAW_LAUNCH_OPENSHELL_SHIM_SCRIPT,
      );
      expect(call.env?.NEMOCLAW_LAUNCH_PTY_RECORD_WRITER_SCRIPT).toBe(
        OPENCLAW_PTY_RECORD_WRITER_SCRIPT,
      );
      expect(call.env?.NEMOCLAW_LAUNCH_RUNTIME_ENV_SCRIPT).toBe(OPENCLAW_LAUNCH_RUNTIME_ENV_SCRIPT);
    }
  },
);
