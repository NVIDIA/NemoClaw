// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { expect, it } from "vitest";
import { superviseChild } from "../../helpers/process-supervisor.ts";
import { LAUNCH_TURN_SCRIPT, OPENCLAW_SESSION_EVIDENCE_SCRIPT } from "../live/launch-agent-turn.ts";

async function monitorFixture() {
  const runId = randomUUID().replaceAll("-", "");
  const root = `/tmp/nemoclaw-launch-turn-${runId}`;
  const socket = join(root, "pty-input-mode.sock");
  const server = createServer();
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  chmodSync(socket, 0o600);
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }));
  return {
    runId,
    root,
    socket,
    close,
    cleanup: async () => {
      await close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function runWait(
  fixture: Awaited<ReturnType<typeof monitorFixture>>,
  onProbe?: () => void,
  expireWait = false,
) {
  const waitFunction = LAUNCH_TURN_SCRIPT.match(
    /wait_for_pty_monitor_exit\(\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(waitFunction, "Launch monitor wait function is missing");
  // The host path is absent while the sandbox path holds a real Unix socket.
  const child = spawn(
    "bash",
    [
      "-c",
      `
session_evidence() {
  printf 'sandbox-probe\n'
  "$NODE_EXECUTABLE" -e "$EVIDENCE_SCRIPT" "$1" /sandbox/.openclaw/agents/main/sessions \
    "$BASELINE_PATH" '' "$SANDBOX_MONITOR_ROOT" "$RUN_ID"
}
${waitFunction}
pty_monitor_root="$SANDBOX_MONITOR_ROOT/absent-host-path"
wait_for_pty_monitor_exit
`,
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_EXECUTABLE: process.execPath,
        EVIDENCE_SCRIPT: expireWait
          ? `let clockReads = 0;
Object.defineProperty(globalThis, "performance", {
  value: { now: () => clockReads++ === 0 ? 0 : 5_000 },
});
${OPENCLAW_SESSION_EVIDENCE_SCRIPT}`
          : OPENCLAW_SESSION_EVIDENCE_SCRIPT,
        BASELINE_PATH: `/tmp/nemoclaw-launch-session-${fixture.runId}.json`,
        SANDBOX_MONITOR_ROOT: fixture.root,
        RUN_ID: fixture.runId,
      },
    },
  );
  let stderr = "";
  let sawProbe = false;
  child.stdout.once("data", () => onProbe?.());
  const result = await superviseChild(child, {
    timeoutMs: 8_000,
    killGraceMs: 1_000,
    onStdout: () => {
      sawProbe = true;
    },
    onStderr: (chunk) => {
      stderr += chunk;
    },
  });
  return { ...result, stderr, sawProbe };
}

it("waits for the sandbox monitor socket when the host path is absent", async () => {
  const fixture = await monitorFixture();
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let closePromise: Promise<void> | undefined;
  try {
    const result = await runWait(fixture, () => {
      closeTimer = setTimeout(() => {
        closePromise = fixture.close();
      }, 150);
    });
    await closePromise;
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.sawProbe).toBe(true);
    expect(existsSync(fixture.socket)).toBe(false);
    expect(existsSync(fixture.root)).toBe(true);
  } finally {
    clearTimeout(closeTimer);
    await closePromise;
    await fixture.cleanup();
  }
});

it("rejects a persistent sandbox monitor socket without removing it", async () => {
  const fixture = await monitorFixture();
  try {
    const result = await runWait(fixture, undefined, true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('"reason":"pty_monitor_socket_still_present"');
    expect(existsSync(fixture.socket)).toBe(true);
  } finally {
    await fixture.cleanup();
  }
});

it("accepts an already absent sandbox monitor socket", async () => {
  const fixture = await monitorFixture();
  try {
    await fixture.close();
    const result = await runWait(fixture);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.sawProbe).toBe(true);
  } finally {
    await fixture.cleanup();
  }
});

it("rejects a non-socket entry at the sandbox monitor path", async () => {
  const fixture = await monitorFixture();
  try {
    await fixture.close();
    writeFileSync(fixture.socket, "unexpected", { mode: 0o600 });
    const result = await runWait(fixture);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('"reason":"pty_socket_invalid"');
    expect(existsSync(fixture.socket)).toBe(true);
  } finally {
    await fixture.cleanup();
  }
});

it("preserves a failed monitor wait when later cleanup succeeds", async () => {
  const fixture = await monitorFixture();
  try {
    await fixture.close();
    const cleanup = LAUNCH_TURN_SCRIPT.match(/\ncleanup\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(cleanup, "Launch cleanup function is missing");
    const sessionDir = join(fixture.root, "host-session");
    mkdirSync(sessionDir);
    const child = spawn(
      "bash",
      [
        "-c",
        `
session_dir="$1"
evidence_error="$session_dir/evidence.err"
session_pid=''
last_evidence_status=3
provider_unavailable_candidate=1
NEMOCLAW_LAUNCH_RUN_ID=fixture
remove_session_baseline() { return 0; }
wait_for_pty_monitor_exit() { return 2; }
remove_pty_monitor() { return 0; }
${cleanup}
trap cleanup EXIT
exit 1
`,
        "monitor-cleanup",
        sessionDir,
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    const result = await superviseChild(child, {
      timeoutMs: 3_000,
      killGraceMs: 1_000,
      onStderr: (chunk) => {
        stderr += chunk;
      },
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("launch PTY monitor wait failed");
    expect(stderr).toContain("launch-cleanup=completed status=1");
    expect(stderr).not.toContain("launch-failure=provider-unavailable");
    expect(existsSync(sessionDir)).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});
