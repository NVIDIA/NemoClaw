// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";
import { LAUNCH_TURN_SCRIPT, runLaunchReadinessLeaseTurns } from "../live/launch-agent-turn.ts";

interface LaunchTurnFixtureOptions {
  closeAfterReply?: boolean;
  exitStatus: number;
  initialOutput?: string;
  postReplyOutput?: string;
  postReplyReadyState?: string;
  readyState?: string;
  reply?: string;
}

function runLaunchTurnFixture(options: LaunchTurnFixtureOptions) {
  const {
    closeAfterReply = false,
    exitStatus,
    initialOutput = "",
    postReplyOutput = "",
    postReplyReadyState = "",
    readyState = "",
    reply = "PONG",
  } = options;
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-turn-"));
  const scriptStub = join(fixtureRoot, "script");
  const sleepStub = join(fixtureRoot, "sleep");
  const timeoutStub = join(fixtureRoot, "timeout");

  try {
    writeFileSync(
      scriptStub,
      String.raw`#!/usr/bin/env bash
set -euo pipefail
capture=""
for argument in "$@"; do
  capture="$argument"
done
: >"$capture"
if [[ -n "$NEMOCLAW_FIXTURE_INITIAL_OUTPUT" ]]; then
  printf '%s\n' "$NEMOCLAW_FIXTURE_INITIAL_OUTPUT" | tee -a "$capture"
fi
IFS= read -r -d $'\r' _
printf '%s\n' "$NEMOCLAW_FIXTURE_REPLY" | tee -a "$capture"
if [[ -n "$NEMOCLAW_FIXTURE_POST_REPLY_OUTPUT" ]]; then
  printf '%s\n' "$NEMOCLAW_FIXTURE_POST_REPLY_OUTPUT" | tee -a "$capture"
fi
${
  closeAfterReply
    ? ""
    : String.raw`IFS= read -r -d $'\r' exit_command
[[ "$exit_command" == "/exit" ]]`
}
exit ${exitStatus}
`,
    );
    writeFileSync(sleepStub, '#!/bin/sh\nif [ "${1:-}" = "0.1" ]; then /bin/sleep 0.01; fi\n');
    writeFileSync(timeoutStub, '#!/bin/sh\nshift 2\nexec "$@"\n');
    chmodSync(scriptStub, 0o755);
    chmodSync(sleepStub, 0o755);
    chmodSync(timeoutStub, 0o755);

    return spawnSync("bash", ["-c", LAUNCH_TURN_SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_LAUNCH_COMMAND: "ignored",
        NEMOCLAW_LAUNCH_ENTRYPOINT: "",
        NEMOCLAW_LAUNCH_EXIT_COMMAND: closeAfterReply ? "" : "/exit",
        NEMOCLAW_LAUNCH_EXPECTED_REPLY: "PONG",
        NEMOCLAW_FIXTURE_INITIAL_OUTPUT: initialOutput,
        NEMOCLAW_FIXTURE_POST_REPLY_OUTPUT: postReplyOutput,
        NEMOCLAW_FIXTURE_REPLY: reply,
        NEMOCLAW_LAUNCH_POST_REPLY_READY_STATE: postReplyReadyState,
        NEMOCLAW_LAUNCH_PROMPT: "prompt",
        NEMOCLAW_LAUNCH_READY_STATE: readyState,
        NEMOCLAW_LAUNCH_SANDBOX: "sandbox",
        PATH: `${fixtureRoot}:${process.env.PATH ?? ""}`,
      },
      timeout: 10_000,
    });
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

it.runIf(process.platform === "linux")(
  "runs producer then two distinct PTY launch turns under one lease (#8942)",
  async () => {
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    let launchPhaseStartedAtCallCount = -1;
    const host = {
      command: async (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ command, args, env: options.env });
        return {
          exitCode: 0,
          signal: null,
          stdout: args.includes("--probe-only") ? "Probe complete" : "NEMOCLAW_LAUNCH_TURN_OK",
          stderr: "",
        };
      },
    };

    await runLaunchReadinessLeaseTurns({
      artifactName: "lease-turn",
      cliCommand: "node",
      cliEntrypoint: "/repo/bin/nemoclaw.js",
      env: {},
      exitCommand: "/exit",
      host: host as never,
      postReplyReadyState: "idle",
      readyState: "idle",
      redactionValues: [],
      sandboxName: "alpha",
      beforeLaunchTurns: () => {
        launchPhaseStartedAtCallCount = calls.length;
      },
    });

    expect(calls).toHaveLength(3);
    expect(launchPhaseStartedAtCallCount).toBe(1);
    expect(calls[0]).toMatchObject({
      command: "node",
      args: ["/repo/bin/nemoclaw.js", "alpha", "connect", "--probe-only"],
    });
    expect(calls[1]?.env?.NEMOCLAW_LAUNCH_EXPECTED_REPLY).not.toBe(
      calls[2]?.env?.NEMOCLAW_LAUNCH_EXPECTED_REPLY,
    );
    expect(calls.slice(1).map((call) => call.env?.NEMOCLAW_LAUNCH_EXIT_COMMAND)).toEqual([
      "/exit",
      "/exit",
    ]);
    expect(calls.slice(1).map((call) => call.env?.NEMOCLAW_LAUNCH_READY_STATE)).toEqual([
      "idle",
      "idle",
    ]);
    expect(
      calls.slice(1).map((call) => call.env?.NEMOCLAW_LAUNCH_POST_REPLY_READY_STATE),
    ).toEqual(["idle", "idle"]);
  },
);

it.runIf(process.platform !== "win32")(
  "requires the exact reply before a post-reply idle state (#9023, #9160)",
  () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-turn-ready-"));
    const scriptStub = join(fixtureRoot, "script");
    const sleepStub = join(fixtureRoot, "sleep");
    const timeoutStub = join(fixtureRoot, "timeout");

    try {
      writeFileSync(
        scriptStub,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
capture=""
for argument in "$@"; do
  capture="$argument"
done
: >"$capture"
if IFS= read -r -t 1 -d $'\r' _; then
  echo "prompt arrived before gateway readiness" >&2
  exit 1
fi
printf 'connected | idle\n' | tee -a "$capture"
IFS= read -r -d $'\r' _
printf 'gateway connected | idle\n' | tee -a "$capture"
if IFS= read -r -t 1 -d $'\r' _; then
  echo "exit command arrived before the exact reply" >&2
  exit 1
fi
printf 'PONG\n' | tee -a "$capture"
printf 'runtime status | busy\n' | tee -a "$capture"
if IFS= read -r -t 1 -d $'\r' _; then
  echo "exit command arrived while the TUI reported a busy state" >&2
  exit 1
fi
printf 'runtime status | idle\n' | tee -a "$capture"
IFS= read -r -d $'\r' exit_command
[[ "$exit_command" == "/exit" ]]
exit 0
`,
      );
      writeFileSync(sleepStub, "#!/bin/sh\n/bin/sleep 0.1\n");
      writeFileSync(timeoutStub, '#!/bin/sh\nshift 2\nexec "$@"\n');
      chmodSync(scriptStub, 0o755);
      chmodSync(sleepStub, 0o755);
      chmodSync(timeoutStub, 0o755);

      const result = spawnSync("bash", ["-c", LAUNCH_TURN_SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_LAUNCH_COMMAND: "ignored",
          NEMOCLAW_LAUNCH_ENTRYPOINT: "",
          NEMOCLAW_LAUNCH_EXIT_COMMAND: "/exit",
          NEMOCLAW_LAUNCH_EXPECTED_REPLY: "PONG",
          NEMOCLAW_LAUNCH_PROMPT: "prompt",
          NEMOCLAW_LAUNCH_POST_REPLY_READY_STATE: "idle",
          NEMOCLAW_LAUNCH_READY_STATE: "idle",
          NEMOCLAW_LAUNCH_SANDBOX: "sandbox",
          PATH: `${fixtureRoot}:${process.env.PATH ?? ""}`,
        },
        timeout: 10_000,
      });

      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("NEMOCLAW_LAUNCH_TURN_OK");
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  },
);

it.runIf(process.platform !== "win32")(
  "records a successful reply and exit status 0 after the TUI exit command (#8584)",
  () => {
    const result = runLaunchTurnFixture({ exitStatus: 0 });

    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("NEMOCLAW_LAUNCH_TURN_OK");
  },
);

it.runIf(process.platform !== "win32")(
  "accepts an exact reply wrapped in a terminated OSC-8 hyperlink (#9023)",
  () => {
    for (const terminator of ["\u0007", "\u001b\\"]) {
      const reply =
        `\u001b]8;;https://example.invalid/reply${terminator}` +
        `PONG\u001b]8;;${terminator}`;
      const result = runLaunchTurnFixture({ exitStatus: 0, reply });

      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("NEMOCLAW_LAUNCH_TURN_OK");
    }
  },
);

it.runIf(process.platform !== "win32")(
  "accepts an exact reply after a CSI erase-in-line sequence (#9160)",
  () => {
    const result = runLaunchTurnFixture({ exitStatus: 0, reply: "\u001b[2KPONG" });

    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("NEMOCLAW_LAUNCH_TURN_OK");
  },
);

it.runIf(process.platform !== "win32")(
  "preserves an exact visible reply through supported redraw controls (#9160)",
  () => {
    for (const reply of ["WAIT\rPONG", "PONX\bG", "\u0001PONG\u0002"]) {
      const result = runLaunchTurnFixture({ exitStatus: 0, reply });

      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("NEMOCLAW_LAUNCH_TURN_OK");
    }
  },
);

it.runIf(process.platform !== "win32")(
  "rejects busy readiness after an exact reply (#9160)",
  () => {
    const result = runLaunchTurnFixture({
      closeAfterReply: true,
      exitStatus: 0,
      initialOutput: "connected | idle",
      postReplyOutput: "gateway connected | busy",
      postReplyReadyState: "idle",
      readyState: "idle",
    });

    expect(result.signal, result.stderr).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "launch did not return to the expected TUI state after the reply",
    );
    expect(result.stdout).not.toContain("NEMOCLAW_LAUNCH_TURN_OK");
  },
);

it.runIf(process.platform !== "win32")(
  "rejects a reply token embedded in extra prose (#8942)",
  () => {
    for (const reply of [
      "The answer is PONG, with extra prose.",
      "The answer is \u001b[31mPONG\u001b[0m, with extra prose.",
      "\u001b]8;;https://example.invalid/reply\u0007PONG with extra prose\u001b]8;;\u0007",
    ]) {
      const result = runLaunchTurnFixture({ closeAfterReply: true, exitStatus: 0, reply });

      expect(result.signal, result.stderr).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("launch did not produce the expected agent reply");
      expect(result.stdout).not.toContain("NEMOCLAW_LAUNCH_TURN_OK");
    }
  },
);

it.runIf(process.platform !== "win32")(
  "rejects stale or partial visible reply text (#9160)",
  () => {
    for (const reply of ["PON", "PONGX", "PONG\rWAIT"]) {
      const result = runLaunchTurnFixture({ closeAfterReply: true, exitStatus: 0, reply });

      expect(result.signal, result.stderr).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("launch did not produce the expected agent reply");
      expect(result.stdout).not.toContain("NEMOCLAW_LAUNCH_TURN_OK");
    }
  },
);

it.runIf(process.platform !== "win32")(
  "preserves an unrecognized terminal sequence in failed output (#9160)",
  () => {
    const result = runLaunchTurnFixture({
      closeAfterReply: true,
      exitStatus: 0,
      reply: "\u001b]8;;https://example.invalid/replyPONG",
    });

    expect(result.signal, result.stderr).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("https://example.invalid/replyPONG");
    expect(result.stderr).toContain("launch did not produce the expected agent reply");
  },
);

it.runIf(process.platform !== "win32")(
  "reports a nonzero TUI exit after recording a successful reply (#8584)",
  () => {
    const result = runLaunchTurnFixture({ exitStatus: 23 });

    expect(result.signal, result.stderr).toBeNull();
    expect(result.status).toBe(23);
    expect(result.stderr).toContain("launch exited with status 23");
    expect(result.stdout).not.toContain("NEMOCLAW_LAUNCH_TURN_OK");
  },
);
