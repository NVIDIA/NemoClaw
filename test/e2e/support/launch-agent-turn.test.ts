// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { expect, it } from "vitest";
import {
  LAUNCH_TURN_SCRIPT,
  OPENCLAW_SESSION_EVIDENCE_SCRIPT,
  runOpenClawLaunchReadinessLeaseTurns,
} from "../live/launch-agent-turn.ts";

type SessionRecords = Record<string, string[]>;
type FixtureMode =
  | "cleanup-failure"
  | "delayed-input-attachment"
  | "delayed-recording"
  | "input-mode-timeout"
  | "invalid-order"
  | "late-extra"
  | "multiple-tui-processes"
  | "nonzero"
  | "nonzero-cleanup-failure"
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

function runEvidenceFixture(input: {
  after: SessionRecords;
  afterFinalNewline?: boolean;
  before?: SessionRecords;
  expectedTurns: number;
}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-evidence-"));
  const baselinePath = join(fixtureRoot, "baseline.json");
  const sessionRoot = join(fixtureRoot, "sessions");
  mkdirSync(sessionRoot);
  try {
    writeSessionRecords(sessionRoot, input.before ?? {}, false);
    const baseline = spawnSync(
      process.execPath,
      ["-e", OPENCLAW_SESSION_EVIDENCE_SCRIPT, "baseline", sessionRoot, baselinePath, ""],
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
      ],
      { encoding: "utf8" },
    );
    return { baseline, baselineMode: statSync(baselinePath).mode & 0o777, qualification };
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

function runBaselineMutationFixture(mutation: "invalid" | "removed" | "rewritten" | "truncated") {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-baseline-"));
  const baselinePath = join(fixtureRoot, "baseline.json");
  const sessionRoot = join(fixtureRoot, "sessions");
  const sessionPath = join(sessionRoot, "session-a.jsonl");
  mkdirSync(sessionRoot);
  writeSessionRecords(sessionRoot, { "session-a": [message("user"), message("assistant")] }, false);
  try {
    const baseline = spawnSync(
      process.execPath,
      ["-e", OPENCLAW_SESSION_EVIDENCE_SCRIPT, "baseline", sessionRoot, baselinePath, ""],
      { encoding: "utf8" },
    );
    const applyMutation: Record<typeof mutation, () => void> = {
      invalid: () => writeFileSync(baselinePath, "{}"),
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
      ["-e", OPENCLAW_SESSION_EVIDENCE_SCRIPT, "qualify", sessionRoot, baselinePath, "1"],
      { encoding: "utf8" },
    );
    return { baseline, qualification };
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

function runLaunchSessionFixture(mode: FixtureMode, terminalCopy: "absent" | "ansi" | "reordered") {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-turn-"));
  const fakeLaunch = join(fixtureRoot, "openclaw");
  const fakeOpenshell = join(fixtureRoot, "openshell");
  const sessionRoot = join(fixtureRoot, "sessions");
  const tuiInputMarkerRoot = join(fixtureRoot, "tui-input");
  const tuiPidsPath = join(fixtureRoot, "tui-pids");
  const ttyMarker = join(fixtureRoot, "tty-observed");
  const runId = basename(fixtureRoot).replaceAll(/[^a-zA-Z0-9]/gu, "");
  const baselinePath = `/tmp/nemoclaw-launch-session-${runId}.json`;
  mkdirSync(sessionRoot);
  mkdirSync(tuiInputMarkerRoot);

  try {
    writeFileSync(
      fakeLaunch,
      String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const childProcess = require("node:child_process");

const mode = process.env.NEMOCLAW_FIXTURE_MODE;
if (process.argv[2] !== "tui") {
  if (mode !== "multiple-tui-processes") {
    const child = childProcess.spawnSync(process.execPath, [__filename, "tui"], { stdio: "inherit" });
    process.exit(child.status ?? 66);
  }
  const children = Array.from({ length: 2 }, () =>
    childProcess.spawn(process.execPath, [__filename, "tui"], { stdio: "inherit" }),
  );
  fs.writeFileSync(
    process.env.NEMOCLAW_FIXTURE_TUI_PIDS,
    children.map((child) => child.pid).join("\n") + "\n",
  );
  const stopChildren = () => {
    for (const child of children) {
      try { child.kill("SIGTERM"); } catch {}
    }
  };
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      stopChildren();
      setTimeout(() => process.exit(0), 100);
    });
  }
  let activeChildren = children.length;
  for (const child of children) {
    child.once("exit", () => {
      activeChildren -= 1;
      if (activeChildren === 0) process.exit(0);
    });
  }
}

if (process.argv[2] === "tui") (async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(64);
  fs.writeFileSync(process.env.NEMOCLAW_FIXTURE_TTY_MARKER, "");
  const sessionFile = process.env.NEMOCLAW_FIXTURE_SESSION_FILE;
  const terminalCopy = process.env.NEMOCLAW_FIXTURE_TERMINAL_COPY;
  const append = (role, content) => fs.appendFileSync(
    sessionFile,
    JSON.stringify({ message: { content: [{ text: content, type: "text" }], role }, type: "message" }) + "\n",
  );
  if (mode === "multiple-tui-processes") {
    let observedPtyInput = "";
    process.stdin.on("data", (chunk) => {
      observedPtyInput += chunk.toString();
      if (observedPtyInput.includes(process.env.NEMOCLAW_LAUNCH_FIRST_INPUT)) {
        fs.writeFileSync(process.env.NEMOCLAW_FIXTURE_TUI_INPUT_MARKER_ROOT + "/" + process.pid, "");
      }
    });
  }
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
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    rl.off("line", recordDelayedInput);
  }
  if (mode === "recording-timeout") {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
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
if [[ "$NEMOCLAW_FIXTURE_MODE" == *"cleanup-failure" && " $* " == *" rm -f -- "* ]]; then
  exit 71
fi
while [[ "$#" -gt 0 && "$1" != "--" ]]; do shift; done
[[ "$#" -gt 0 ]]
shift
exec "$@"
`,
    );
    chmodSync(fakeLaunch, 0o755);
    chmodSync(fakeOpenshell, 0o755);

    const result = spawnSync("bash", ["-c", LAUNCH_TURN_SCRIPT], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        NEMOCLAW_FIXTURE_MODE: mode,
        NEMOCLAW_FIXTURE_SESSION_FILE: join(sessionRoot, "session-a.jsonl"),
        NEMOCLAW_FIXTURE_TERMINAL_COPY: terminalCopy,
        NEMOCLAW_FIXTURE_TUI_INPUT_MARKER_ROOT: tuiInputMarkerRoot,
        NEMOCLAW_FIXTURE_TUI_PIDS: tuiPidsPath,
        NEMOCLAW_FIXTURE_TTY_MARKER: ttyMarker,
        NEMOCLAW_LAUNCH_COMMAND: fakeLaunch,
        NEMOCLAW_LAUNCH_ENTRYPOINT: "",
        NEMOCLAW_LAUNCH_EXIT_COMMAND: "/exit",
        NEMOCLAW_LAUNCH_FIRST_INPUT: "first input",
        NEMOCLAW_LAUNCH_RUN_ID: runId,
        NEMOCLAW_LAUNCH_SANDBOX: "sandbox",
        NEMOCLAW_LAUNCH_SESSION_BUDGET_SECONDS: mode.endsWith("-timeout") ? "2" : "230",
        NEMOCLAW_LAUNCH_SECOND_INPUT: "second input",
        NEMOCLAW_LAUNCH_SESSION_EVIDENCE_SCRIPT: OPENCLAW_SESSION_EVIDENCE_SCRIPT,
        NEMOCLAW_LAUNCH_SESSION_ROOT: sessionRoot,
        NEMOCLAW_OPENSHELL_COMMAND: fakeOpenshell,
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
      spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 25)"], { timeout: 100 });
    }
    return {
      baselineRemoved: !existsSync(baselinePath),
      orphanedTuiProcessIds: tuiProcessIds.filter((pid) => existsSync(`/proc/${pid}`)),
      recordedTuiInputProcessIds: tuiProcessIds.filter((pid) =>
        existsSync(join(tuiInputMarkerRoot, pid)),
      ),
      result,
      tuiProcessIds,
      ttyObserved: existsSync(ttyMarker),
    };
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
    rmSync(baselinePath, { force: true });
  }
}

it("qualifies two ordered structured turns without comparing message content (#9160)", () => {
  const { baseline, baselineMode, qualification } = runEvidenceFixture({
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
  expect(baselineMode).toBe(0o600);
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

it("rejects malformed, empty, duplicated, extra, out-of-order, or cross-session records (#9160)", () => {
  const cases: SessionRecords[] = [
    { "session-a": [message("assistant"), message("user")] },
    { "session-a": [message("user"), message("user"), message("assistant")] },
    { "session-a": [message("user"), message("assistant"), message("assistant")] },
    { "session-a": [message("user"), "not-json", message("assistant")] },
    { "session-a": [emptyMessage("user"), message("assistant")] },
    { "session-a": [message("user"), message("assistant")], "session-b": [message("user")] },
  ];

  for (const after of cases) {
    const { baseline, qualification } = runEvidenceFixture({ after, expectedTurns: 1 });
    expect(baseline.status).toBe(0);
    expect(qualification.status).toBe(2);
  }
});

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

it("rejects an invalid baseline or a removed, rewritten, or truncated session (#9160)", () => {
  for (const mutation of ["invalid", "removed", "rewritten", "truncated"] as const) {
    const { baseline, qualification } = runBaselineMutationFixture(mutation);
    expect(baseline.status).toBe(0);
    expect(qualification.status).toBe(2);
  }
});

it.runIf(process.platform === "linux")(
  "sends two inputs and exit through a real PTY without using terminal copy as evidence (#9160)",
  () => {
    for (const terminalCopy of ["absent", "ansi", "reordered"] as const) {
      const { baselineRemoved, result, ttyObserved } = runLaunchSessionFixture(
        "valid",
        terminalCopy,
      );

      expect(ttyObserved, result.stderr).toBe(true);
      expect(baselineRemoved).toBe(true);
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
    }
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

it.runIf(process.platform === "linux")(
  "rejects multiple OpenClaw TUI processes before submitting PTY input (#9160)",
  () => {
    const {
      baselineRemoved,
      orphanedTuiProcessIds,
      recordedTuiInputProcessIds,
      result,
      tuiProcessIds,
      ttyObserved,
    } = runLaunchSessionFixture("multiple-tui-processes", "absent");

    expect(ttyObserved).toBe(true);
    expect(tuiProcessIds).toHaveLength(2);
    expect(recordedTuiInputProcessIds).toEqual([]);
    expect(orphanedTuiProcessIds).toEqual([]);
    expect(baselineRemoved).toBe(true);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"reason":"multiple_tui_processes"');
  },
);

it.runIf(process.platform === "linux")(
  "submits each PTY turn once while structured recording is delayed (#9160)",
  () => {
    const { baselineRemoved, result, ttyObserved } = runLaunchSessionFixture(
      "delayed-recording",
      "absent",
    );

    expect(ttyObserved).toBe(true);
    expect(baselineRemoved).toBe(true);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  },
);

it.runIf(process.platform === "linux")(
  "reports a missing OpenClaw input mode before the PTY child timeout (#9160)",
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
      "launch PTY did not enter input mode before the session deadline",
    );
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
  "preserves a nonzero PTY exit when structured baseline cleanup also fails (#9160)",
  () => {
    const { baselineRemoved, result, ttyObserved } = runLaunchSessionFixture(
      "nonzero-cleanup-failure",
      "absent",
    );

    expect(ttyObserved).toBe(true);
    expect(baselineRemoved).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(23);
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
      openshellCommandPath: "openshell",
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
      "openshell",
      "openshell",
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
    }
  },
);
