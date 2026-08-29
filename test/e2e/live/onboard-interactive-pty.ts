// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcessProgress } from "../fixtures/observed-child-process.ts";
import { spawnObservedChild } from "../fixtures/observed-child-process.ts";

// Drives an interactive CLI through a real PTY, the same technique
// `test/helpers/installer-express-prompt-pty-harness.ts` uses for the
// installer's express prompt. The real onboard wizard behaves differently
// under a piped, non-TTY stdin than under a real terminal (raw-mode
// keypress selectors, `isTTY`-gated prompts), so a faithful regression test
// for interactive-only behavior must drive a real PTY rather than pipe
// stdin.
//
// Rules fire independently and out of order: a rule whose trigger never
// appears (for example, a first-run license notice already accepted on a
// prior run) must not block a later rule from firing when its own trigger
// appears.
//
// The child process itself is launched through the shared
// `spawnObservedChild` boundary (the suite's single audited asynchronous
// child-process call) so it still tracks a content-free progress activity
// and canonical lifecycle checkpoints; this module attaches its own
// listeners on top to capture output and match rule triggers.

export interface InteractiveCommandRule {
  readonly trigger: string;
  readonly response: string;
}

export interface InteractiveCommandResult {
  readonly exitCode: number;
  readonly output: string;
  readonly visibleOutput: string;
  readonly firedTriggers: readonly string[];
  readonly timedOut: boolean;
}

export interface DriveInteractiveCommandOptions {
  readonly activityLabel: string;
  readonly cmd: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly progress: ChildProcessProgress;
  readonly rules: readonly InteractiveCommandRule[];
  readonly timeoutMs: number;
}

// Runs inside a Python child so it can fork a real pseudo-terminal;
// Node has no built-in PTY primitive and this repo does not depend on
// node-pty. The child's own deadline is generous; the Node-side timer
// below is the enforced hard bound and SIGKILLs the whole process tree.
const PTY_DRIVER_SCRIPT = `
import json, os, pty, select, signal, sys, time

# Read from stdin, not argv: the payload embeds every scripted response,
# including any credential a rule supplies (e.g. an onboard API key), and a
# process argument stays visible to anything that can list the command
# line for as long as the child runs.
payload = json.loads(sys.stdin.read())
cmd = payload["cmd"]
rules = payload["rules"]
timeout_s = payload["timeoutSeconds"]

pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)

# pty.fork() makes the command the leader of a separate session/process
# group. Tell the Node parent which group it must terminate on its hard
# timeout; killing only this Python driver's group cannot reach that child.
sys.stderr.write("PTY_CHILD_PID\\t" + str(pid) + "\\n")
sys.stderr.flush()

def terminate_pty_child():
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

def handle_driver_signal(_signum, _frame):
    terminate_pty_child()
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.exit(124)

signal.signal(signal.SIGTERM, handle_driver_signal)
signal.signal(signal.SIGINT, handle_driver_signal)

output = bytearray()
os.set_blocking(fd, False)
deadline = time.monotonic() + timeout_s
fired = [False] * len(rules)

def strip_terminal_sequences(text):
    visible = []
    index = 0
    while index < len(text):
        if ord(text[index]) != 27:
            visible.append(text[index])
            index += 1
            continue
        index += 1
        if index >= len(text):
            break
        if text[index] == "[":
            index += 1
            while index < len(text) and not ("@" <= text[index] <= "~"):
                index += 1
            index += 1
            continue
        if text[index] == "]":
            index += 1
            while index < len(text):
                if ord(text[index]) == 7:
                    index += 1
                    break
                if ord(text[index]) == 27 and index + 1 < len(text) and ord(text[index + 1]) == 92:
                    index += 2
                    break
                index += 1
            continue
        index += 1
    return "".join(visible)

exit_code = None
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            chunk = b""
        if not chunk:
            # PTY close (EOF, or EIO on Linux) after the child has already
            # exited normally must not fall through to the timeout branch
            # below: reap it here and record its real exit code so a
            # successful run is never misreported as DRIVER_TIMEOUT.
            _, status = os.waitpid(pid, 0)
            exit_code = os.waitstatus_to_exitcode(status)
            break
        output.extend(chunk)
        sys.stdout.buffer.write(chunk)
        sys.stdout.flush()
    text = output.decode("utf-8", errors="ignore")
    visible_text = strip_terminal_sequences(text)
    for i, rule in enumerate(rules):
        if fired[i]:
            continue
        if rule["trigger"] in text or rule["trigger"] in visible_text:
            os.write(fd, rule["response"].encode())
            sys.stderr.write("FIRED\\t" + rule["trigger"] + "\\n")
            fired[i] = True
    waited = os.waitpid(pid, os.WNOHANG)
    if waited[0] == pid:
        exit_code = os.waitstatus_to_exitcode(waited[1])
        break
if exit_code is None:
    terminate_pty_child()
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.stderr.write("DRIVER_TIMEOUT\\n")
    sys.exit(124)
sys.exit(exit_code)
`;

export function stripInteractiveTerminalSequences(value: string): string {
  let visible = "";
  let index = 0;
  while (index < value.length) {
    if (value.charCodeAt(index) !== 27) {
      visible += value[index];
      index += 1;
      continue;
    }
    index += 1;
    if (index >= value.length) break;
    if (value[index] === "[") {
      index += 1;
      while (index < value.length && !(value[index]! >= "@" && value[index]! <= "~")) index += 1;
      index += 1;
      continue;
    }
    if (value[index] === "]") {
      index += 1;
      while (index < value.length) {
        if (value.charCodeAt(index) === 7) {
          index += 1;
          break;
        }
        if (
          value.charCodeAt(index) === 27 &&
          index + 1 < value.length &&
          value.charCodeAt(index + 1) === 92
        ) {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return visible;
}

function resolvePython(): string {
  return process.env.NEMOCLAW_E2E_PYTHON3_BIN || "python3";
}

export function driveInteractiveCommand(
  options: DriveInteractiveCommandOptions,
): Promise<InteractiveCommandResult> {
  const payload = JSON.stringify({
    cmd: options.cmd,
    rules: options.rules.map((rule) => ({ trigger: rule.trigger, response: rule.response })),
    // Comfortably longer than the Node-side hard timeout below so the
    // driver's own bookkeeping never races the enforced bound.
    timeoutSeconds: Math.ceil(options.timeoutMs / 1000) + 30,
  });
  // Kept directly in this function's body, not inside the Promise executor
  // below, so the sole audited async child-process boundary stays attached
  // to a named, reviewed callsite. `detached: true` makes the Python driver
  // its process-group leader, which gives fallback cleanup a stable target.
  // pty.fork() creates a separate child session, whose process-group id is
  // reported over stderr below.
  const child = spawnObservedChild(resolvePython(), ["-c", PTY_DRIVER_SCRIPT], {
    activityLabel: options.activityLabel,
    progress: options.progress,
    spawn: { cwd: options.cwd, env: options.env, detached: true },
  });
  // Written to stdin rather than passed as a process argument: the payload
  // carries every scripted response, including any credential a rule
  // supplies (see PTY_DRIVER_SCRIPT's matching comment).
  child.stdin?.end(payload);

  return new Promise((resolve, reject) => {
    let output = "";
    const firedTriggers: string[] = [];
    let stderrRest = "";
    let timedOut = false;
    let settled = false;
    let ptyChildPid: number | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      // pty.fork() puts the onboard command in its own session. Kill that
      // exact process group, then let the driver reap it through its SIGTERM
      // handler. The delayed driver-group SIGKILL is only a hard fallback.
      try {
        if (ptyChildPid) process.kill(-ptyChildPid, "SIGKILL");
      } catch {
        // The PTY child may already have exited between the deadline and the
        // signal. The driver still receives SIGTERM and reaps its status.
      }
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        try {
          if (ptyChildPid) process.kill(-ptyChildPid, "SIGKILL");
        } catch {
          // Already gone.
        }
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 1_000);
    }, options.timeoutMs);

    // Additional listeners alongside spawnObservedChild's own content-free
    // observer; this module needs the real transcript to match rule
    // triggers and to report ordered step evidence.
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const lines = (stderrRest + chunk.toString("utf-8")).split("\n");
      stderrRest = lines.pop() ?? "";
      for (const line of lines) {
        const childPid = line.match(/^PTY_CHILD_PID\t([1-9]\d*)$/);
        if (childPid) {
          ptyChildPid = Number(childPid[1]);
          continue;
        }
        const fired = line.match(/^FIRED\t(.*)$/);
        if (fired) firedTriggers.push(fired[1]);
      }
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const fired = stderrRest.match(/^FIRED\t(.*)$/);
      if (fired) firedTriggers.push(fired[1]);
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        output,
        visibleOutput: stripInteractiveTerminalSequences(output),
        firedTriggers,
        timedOut,
      });
    });
  });
}
