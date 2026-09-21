// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  runAgentDispatch,
  runOpenClawAgentDispatch,
  type AgentDispatchRunner,
} from "../../src/lib/actions/sandbox/agent/passthrough-dispatch";
import { createCliOpenShellSandboxSessionExecutor } from "../../src/lib/adapters/openshell/sandbox-command-cli";
import { runAgentNonJsonPassthrough } from "../../src/lib/actions/sandbox/agent/passthrough";
import { runAgentJsonPassthrough } from "../../src/lib/actions/sandbox/agent/passthrough-json";
import { withMcpLifecycleLock } from "../../src/lib/state/mcp-lifecycle-lock-acquisition";

function openPipe(inputPath: string): number {
  expect(spawnSync("mkfifo", [inputPath]).status).toBe(0);
  return fs.openSync(inputPath, fs.constants.O_RDWR);
}

function finiteInput(inputPath: string): number {
  fs.writeFileSync(inputPath, "PIPED_INPUT");
  return fs.openSync(inputPath, "r");
}

// Keep one real child transport for both byte forwarding and cancellation.
function childDispatch(
  inputFd: number,
  script: string,
  options: {
    messageFile?: string;
    signals?: EventEmitter;
    spawned?: (child: ChildProcess) => void;
  } = {},
): AgentDispatchRunner {
  const signals = options.signals ?? new EventEmitter();
  const executor = createCliOpenShellSandboxSessionExecutor({
    resolveBinary: () => process.execPath,
    stdinIsTty: () => false,
    signalSource: {
      add: (signal, listener) => signals.on(signal, listener),
      remove: (signal, listener) => signals.off(signal, listener),
    },
    spawnChild: (_binary, args, { stdio }) => {
      const child = spawn(
        process.execPath,
        ["-e", script, "--", options.messageFile ?? "/dev/stdin", ...args],
        {
          stdio: [
            Array.isArray(stdio) && stdio[0] === "inherit" ? inputFd : "ignore",
            "pipe",
            "pipe",
          ],
        },
      );
      const deadline = setTimeout(() => child.kill("SIGKILL"), 3_000);
      child.once("close", () => clearTimeout(deadline));
      options.spawned?.(child);
      return child;
    },
  });
  return (request) => runAgentDispatch(request, executor);
}

describe.skipIf(process.platform === "win32")("agent dispatch stdin", () => {
  it.each(
    (["inline", "redirected", "symlink"] as const).flatMap((input) =>
      [false, true].map((json) => ({ input, json })),
    ),
  )("dispatches $input input (JSON: $json) (#11371)", async ({ input, json }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-stdin-"));
    const inputPath = path.join(root, "input");
    let closeInput = () => {};
    try {
      const messageFile = input === "symlink" ? path.join(root, "message-chain") : undefined;
      fs.symlinkSync("/dev/stdin", path.join(root, "source"));
      fs.symlinkSync("source", path.join(root, "message-chain"));
      const inputFd = input === "inline" ? openPipe(inputPath) : finiteInput(inputPath);
      closeInput = () => fs.closeSync(inputFd);
      const stdout: string[] = [];
      const stderr: string[] = [];
      const proc = {
        exit(code: number): never {
          throw new Error(`exit:${code}`);
        },
        stdout: { write: (value: string) => stdout.push(value) },
        stderr: { write: (value: string) => stderr.push(value) },
      };
      const invoke = json ? runAgentJsonPassthrough : runAgentNonJsonPassthrough;
      const command = [
        "openclaw",
        "agent",
        "--agent",
        "main",
        ...(json ? ["--json"] : []),
        ...(input === "inline" ? ["-m", "ARG_MESSAGE"] : []),
        ...(messageFile ? ["--message-file", messageFile] : []),
      ];
      await expect(
        invoke("alpha", command, proc, {
          getGatewayName: () => "nemoclaw-8081",
          runDispatch: childDispatch(
            inputFd,
            `const input = require('node:fs').readFileSync(process.argv[1], 'utf8');
console.log(JSON.stringify({payloads: [{text: JSON.stringify({input, args: process.argv.slice(2)})}]}));`,
            { messageFile },
          ),
        }),
      ).rejects.toThrow("exit:0");
      const received = JSON.parse(JSON.parse(stdout.join("")).payloads[0].text);
      expect(received.input).toBe(input === "inline" ? "" : "PIPED_INPUT");
      expect(received.args.slice(-command.length)).toEqual(command);
      expect(stderr.join("")).toBe("");
    } finally {
      closeInput();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { signal: "SIGTERM" as const, code: 143 },
    { signal: "SIGINT" as const, code: 130 },
  ])("releases the lifecycle lock after $signal", async ({ signal, code }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-cancel-"));
    const signalEvents = new EventEmitter();
    const entered: string[] = [];
    const pending: Promise<unknown>[] = [];
    const options = { stateDir: root, pollIntervalMs: 5, timeoutMs: 5_000 };
    let closeInput = () => {};
    let stopChild = () => {};
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    try {
      const inputFd = openPipe(path.join(root, "input"));
      closeInput = () => fs.closeSync(inputFd);
      const operation = withMcpLifecycleLock(
        "alpha",
        async () => {
          entered.push("agent");
          return runOpenClawAgentDispatch(
            "alpha",
            ["openclaw", "agent", "--agent", "main", "--verbose", "off", "-m", "ping"],
            {
              getGatewayName: () => "nemoclaw-8081",
              runDispatch: childDispatch(
                inputFd,
                "const fs = require('node:fs'); fs.writeSync(1, 'started'); fs.readFileSync(0); setInterval(()=>{},1000);",
                {
                  signals: signalEvents,
                  spawned: (child) => {
                    stopChild = () => {
                      child.kill("SIGKILL");
                    };
                    child.stdout?.once("data", childStarted);
                    child.once("close", childStarted);
                  },
                },
              ),
            },
          );
        },
        options,
      );
      pending.push(operation);
      await started;
      await expect(
        withMcpLifecycleLock(
          "alpha",
          () => {
            entered.push("overlap");
          },
          {
            ...options,
            timeoutMs: 100,
          },
        ),
      ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
      const queued = withMcpLifecycleLock(
        "alpha",
        () => {
          entered.push("next");
        },
        options,
      );
      pending.push(queued);
      expect(entered).toEqual(["agent"]);
      signalEvents.emit(signal);
      expect((await operation).outcome.exitCode).toBe(code);
      await queued;
      expect(entered).toEqual(["agent", "next"]);
      expect(signalEvents.listenerCount("SIGTERM")).toBe(0);
      expect(signalEvents.listenerCount("SIGINT")).toBe(0);
    } finally {
      stopChild();
      await Promise.allSettled(pending);
      closeInput();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
