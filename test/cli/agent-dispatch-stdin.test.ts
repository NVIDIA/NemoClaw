// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runAgentDispatch } from "../../src/lib/actions/sandbox/agent/passthrough-dispatch";
import { runAgentNonJsonPassthrough } from "../../src/lib/actions/sandbox/agent/passthrough";
import { runAgentJsonPassthrough } from "../../src/lib/actions/sandbox/agent/passthrough-json";

// OpenShell 0.0.106 reads non-terminal stdin to EOF before sending ExecSandbox.
// Exercise that process boundary with an open FIFO and with finite redirected input.
const inputs = [
  {
    name: "an open pipe with a message argument",
    args: ["-m", "ARG_MESSAGE"],
    expected: "ARG_MESSAGE",
    open(inputPath: string) {
      expect(spawnSync("mkfifo", [inputPath]).status).toBe(0);
      // Keep the writer open throughout dispatch, as automation can do with fd 0.
      return fs.openSync(inputPath, fs.constants.O_RDWR);
    },
  },
  {
    name: "finite redirected input without a message argument",
    args: [],
    expected: "PIPED_INPUT",
    open(inputPath: string) {
      fs.writeFileSync(inputPath, "PIPED_INPUT");
      return fs.openSync(inputPath, "r");
    },
  },
];

describe.skipIf(process.platform === "win32")("agent dispatch stdin", () => {
  it.each([false, true].flatMap((json) => inputs.map((input) => ({ ...input, json }))))(
    "dispatches with $name (JSON: $json) (#11371)",
    async ({ json, args, expected, open }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-stdin-"));
      const inputPath = path.join(root, "input");
      let closeInput = () => {};
      try {
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
        ];
        await expect(
          invoke("alpha", command, proc, {
            getOpenshellBinary: () => process.execPath,
            getGatewayName: () => "nemoclaw-8081",
            stdinIsTty: () => false,
            runDispatch: (binary, args, options) =>
              runAgentDispatch(binary, args, options, {
                spawnChild: (_binary, _args, stdio) => {
                  const child = spawn(
                    process.execPath,
                    [
                      "-e",
                      `
              const input = require('node:fs').readFileSync(0, 'utf8');
              console.log(JSON.stringify({payloads: [{text: input || 'ARG_MESSAGE'}]}));
            `,
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
          }),
        ).rejects.toThrow("exit:0");
        expect(JSON.parse(stdout.join(""))).toEqual({
          payloads: [{ text: expected }],
        });
        expect(stderr.join("")).toBe("");
      } finally {
        closeInput();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
