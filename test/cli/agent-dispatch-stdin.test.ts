// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { runAgentDispatch } from "../../src/lib/actions/sandbox/agent/passthrough-dispatch";
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

// OpenShell reads fd 0 before dispatch; OpenClaw then reads the selected message file.
// Observe both the received input and the original command through a real child.
const inputs: Array<{
  name: string;
  args: string[];
  expected: string;
  open: (inputPath: string) => number;
  prepareMessageFile?: (root: string) => string;
}> = [
  {
    name: "an open pipe with a message argument",
    args: ["-m", "ARG_MESSAGE"],
    expected: "",
    open: openPipe,
  },
  {
    name: "an open pipe with delivery and verbosity options before the message",
    args: [
      "--verbose=off",
      "--channel",
      "slack",
      "--reply-to",
      "#reports",
      "--reply-account",
      "work",
      "--local",
      "-m",
      "ARG_MESSAGE",
    ],
    expected: "",
    open: openPipe,
  },
  {
    name: "an ordinary message file and finite stdin",
    args: ["--verbose", "off"],
    expected: "FILE_MESSAGE",
    open: finiteInput,
    prepareMessageFile(root) {
      const file = path.join(root, "message");
      fs.writeFileSync(file, "FILE_MESSAGE");
      return file;
    },
  },
  {
    name: "a message-file symlink to stdin",
    args: [],
    expected: "PIPED_INPUT",
    open: finiteInput,
    prepareMessageFile(root) {
      const file = path.join(root, "message-link");
      fs.symlinkSync("/dev/stdin", file);
      return file;
    },
  },
  {
    name: "a relative symlink chain to stdin",
    args: [],
    expected: "PIPED_INPUT",
    open: finiteInput,
    prepareMessageFile(root) {
      fs.symlinkSync("/dev/stdin", path.join(root, "source"));
      const file = path.join(root, "message-chain");
      fs.symlinkSync("source", file);
      return file;
    },
  },
  {
    name: "finite redirected input without a message argument",
    args: [],
    expected: "PIPED_INPUT",
    open: finiteInput,
  },
  ...["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0", "/proc/thread-self/fd/0"].map((file) => ({
    name: `finite redirected input through message file ${file}`,
    args: ["--message-file", file],
    expected: "PIPED_INPUT",
    open: finiteInput,
  })),
];

describe.skipIf(process.platform === "win32")("agent dispatch stdin", () => {
  it.each([false, true].flatMap((json) => inputs.map((input) => ({ ...input, json }))))(
    "dispatches with $name (JSON: $json) (#11371)",
    async ({ json, args, expected, open, prepareMessageFile }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-stdin-"));
      const inputPath = path.join(root, "input");
      let closeInput = () => {};
      try {
        const messageFile = prepareMessageFile?.(root);
        const inputFd = open(inputPath);
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
          ...args,
          ...(messageFile ? ["--message-file", messageFile] : []),
        ];
        await expect(
          invoke("alpha", command, proc, {
            getOpenshellBinary: () => process.execPath,
            getGatewayName: () => "nemoclaw-8081",
            stdinIsTty: () => false,
            runDispatch: (request) =>
              runAgentDispatch(
                request,
                createCliOpenShellSandboxSessionExecutor({
                  resolveBinary: () => process.execPath,
                  stdinIsTty: () => false,
                  spawnChild: (_binary, args, { stdio }) => {
                    const child = spawn(
                      process.execPath,
                      [
                        "-e",
                        `
              const input = require('node:fs').readFileSync(process.argv[1], 'utf8');
              console.log(JSON.stringify({payloads: [{text: JSON.stringify({input, args: process.argv.slice(2)})}]}));
            `,
                        "--",
                        messageFile ?? "/dev/stdin",
                        ...args,
                      ],
                      {
                        stdio: [
                          Array.isArray(stdio) && stdio[0] === "inherit" ? inputFd : "ignore",
                          "pipe",
                          "pipe",
                        ],
                      },
                    );
                    const deadline = setTimeout(() => child.kill("SIGKILL"), 2_000);
                    child.once("close", () => clearTimeout(deadline));
                    return child;
                  },
                }),
              ),
          }),
        ).rejects.toThrow("exit:0");
        const received = JSON.parse(JSON.parse(stdout.join("")).payloads[0].text);
        expect(received.input).toBe(expected);
        expect(received.args.slice(-command.length)).toEqual(command);
        expect(stderr.join("")).toBe("");
      } finally {
        closeInput();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(
    [
      { signal: "SIGTERM" as const, code: 143 },
      { signal: "SIGINT" as const, code: 130 },
    ].flatMap((signal) => [false, true].map((json) => ({ ...signal, json }))),
  )("releases the lifecycle lock after $signal (JSON: $json)", async ({ json, signal, code }) => {
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
      const invoke = json ? runAgentJsonPassthrough : runAgentNonJsonPassthrough;
      const proc = {
        exit(code: number): never {
          throw new Error(`exit:${code}`);
        },
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      };
      const operation = withMcpLifecycleLock(
        "alpha",
        async () => {
          entered.push("agent");
          return invoke(
            "alpha",
            ["openclaw", "agent", "--agent", "main", "--verbose", "off", "-m", "ping"],
            proc,
            {
              getOpenshellBinary: () => process.execPath,
              getGatewayName: () => "nemoclaw-8081",
              stdinIsTty: () => false,
              runDispatch: (request) =>
                runAgentDispatch(
                  request,
                  createCliOpenShellSandboxSessionExecutor({
                    resolveBinary: () => process.execPath,
                    stdinIsTty: () => false,
                    signalSource: {
                      add: (signal, listener) => signalEvents.on(signal, listener),
                      remove: (signal, listener) => signalEvents.off(signal, listener),
                    },
                    spawnChild: (_binary, _args, { stdio }) => {
                      const child = spawn(
                        process.execPath,
                        [
                          "-e",
                          "const fs = require('node:fs'); fs.writeSync(1, 'started'); fs.readFileSync(0); setInterval(()=>{},1000);",
                        ],
                        {
                          stdio: [
                            Array.isArray(stdio) && stdio[0] === "inherit" ? inputFd : "ignore",
                            "pipe",
                            "pipe",
                          ],
                        },
                      );
                      stopChild = () => {
                        child.kill("SIGKILL");
                      };
                      child.stdout?.once("data", childStarted);
                      const deadline = setTimeout(stopChild, 3_000);
                      child.once("close", () => {
                        clearTimeout(deadline);
                        childStarted();
                      });
                      return child;
                    },
                  }),
                ),
            },
          );
        },
        options,
      ).catch((error: Error) => error.message);
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
      expect(await operation).toBe(`exit:${code}`);
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
