// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

import {
  patchAgentMessageInput,
  patchOpenClawAgentMessageInput,
} from "../../../scripts/lib/patch-openclaw-agent-message-input.mts";

const legacy = fs.readFileSync(
  path.join(import.meta.dirname, "fixtures/agent-message-input.js.txt"),
  "utf8",
);

function parserForSource(
  source: string,
  options: { tty?: boolean; denied?: boolean; same?: boolean; input?: Buffer } = {},
) {
  const input = options.input ?? Buffer.from("ping\n");
  const stat = {
    dev: 1,
    ino: 2,
    size: input.length,
    isDirectory: () => false,
    isFile: () => false,
  };
  const close = vi.fn(async () => {});
  const open = options.denied
    ? vi.fn().mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }))
    : vi.fn().mockResolvedValue({ fd: 8, stat: async () => ({ ...stat, ino: 3 }), close });
  const read = vi.fn(async () => input);
  const resolve = vm.runInNewContext(
    `${source.replace(/^import .*;\n/u, "")}; resolveAgentMessageOpts`,
    {
      fs: { open, stat: async () => ({ ...stat, ino: options.same === false ? 3 : 2 }) },
      nemoclawStdinStat: () => stat,
      process: {
        stdin: {
          isTTY: options.tty ?? false,
          async *[Symbol.asyncIterator]() {
            yield input;
          },
        },
      },
      Buffer,
      setTimeout,
      clearTimeout,
      readFileDescriptorBounded: read,
      MESSAGE_FILE_DECODER: new TextDecoder("utf-8", { fatal: true }),
      formatCliCommand: (value: string) => value,
    },
  );
  return { resolve, read, open, close };
}

describe.each(["2026.9.5", "2026.10.5"])("OpenClaw %s agent message input", (version) => {
  const native =
    version === "2026.10.5"
      ? fs.readFileSync(
          path.join(import.meta.dirname, "fixtures/agent-message-input-10.5.js.txt"),
          "utf8",
        )
      : legacy;
  const parser = (
    source = patchAgentMessageInput(native),
    options?: Parameters<typeof parserForSource>[1],
  ) => parserForSource(source, options);
  it("waits for a slow pipe producer without failing on nonblocking stdin", async () => {
    const source = patchAgentMessageInput(native).replace(/^import .*;\n/u, "");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
const nemoclawStdinStat = () => require('node:fs').fstatSync(0);
const MESSAGE_FILE_DECODER = new TextDecoder('utf-8', {fatal: true});
const formatCliCommand = (value) => value;
${source}
console.log('ready');
resolveAgentMessageOpts({}).then(({message}) => console.log(message)).catch((error) => { console.error(error); process.exitCode = 1; });
`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    const deadline = setTimeout(() => child.kill("SIGKILL"), 3000);
    let producer: ReturnType<typeof setTimeout> | undefined;
    child.stdout.once("data", () => {
      producer = setTimeout(() => child.stdin.end("ping"), 30);
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code).toBe(0);
      expect(Buffer.concat(output).toString()).toBe("ready\nping\n");
      expect(Buffer.concat(errors).toString()).toBe("");
    } finally {
      clearTimeout(deadline);
      clearTimeout(producer);
      child.kill("SIGKILL");
    }
  });
  it.each([
    [undefined, false, false],
    ["0", false, false],
    ["1", false, false],
    ["-1", false, false],
    ["invalid", false, false],
    ["1", true, false],
    ["1", true, true],
  ] as const)(
    "exits when stdin stays open (timeout: %s, explicit file: %s, reopens: %s)",
    async (timeout, explicit, reopens) => {
      const source = patchAgentMessageInput(native).replace(/^import .*;\n/u, "");
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
const nemoclawStdinStat = () => require('node:fs').fstatSync(0);
const MESSAGE_FILE_DECODER = new TextDecoder('utf-8', {fatal: true});
const formatCliCommand = (value) => value;
const fs = { open: ${reopens ? "async () => ({ fd: 8, stat: async () => nemoclawStdinStat(), close: async () => {} })" : "async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }"}, stat: async () => nemoclawStdinStat() };
const readFileDescriptorBounded = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
};
const schedule = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay) => {
  console.log('budget:' + delay);
  return schedule(callback, 50);
};
${source}
console.log('ready');
resolveAgentMessageOpts(${JSON.stringify({ timeout, ...(explicit ? { messageFile: "/dev/stdin" } : {}) })}).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
`,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout.on("data", (chunk) => output.push(chunk));
      child.stderr.on("data", (chunk) => errors.push(chunk));
      child.stdout.once("data", () => child.stdin.write("ping"));
      const deadline = setTimeout(() => child.kill("SIGKILL"), 1500);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        expect(code).toBe(1);
        expect(Buffer.concat(output).toString()).toBe(
          `ready\nbudget:${timeout === "1" ? 1000 : 30000}\n`,
        );
        expect(Buffer.concat(errors).toString()).toContain("Timed out waiting for stdin");
        expect(Buffer.concat(errors).toString()).toContain("close the producer");
        expect(Buffer.concat(errors).toString()).toContain("--message");
        expect(Buffer.concat(errors).toString()).toContain("--timeout");
      } finally {
        clearTimeout(deadline);
        child.kill("SIGKILL");
      }
    },
  );

  it.each([false, true])("accepts implicit stdin (JSON: %s) (#13130)", async (json) => {
    const { resolve } = parser();
    await expect(resolve({ agent: "main", json })).resolves.toEqual({
      agent: "main",
      json,
      message: "ping\n",
    });
  });

  it("reads inherited stdin when reopening its path is denied (#13130)", async () => {
    const { resolve, read, close } = parser(undefined, { denied: true });
    await expect(resolve({ messageFile: "/dev/stdin" })).resolves.toEqual({ message: "ping\n" });
    expect(read).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("preserves inline message precedence without reading stdin", async () => {
    const { resolve, read, open } = parser();
    await expect(resolve({ message: "inline ; $literal\n", json: true })).resolves.toEqual({
      message: "inline ; $literal\n",
      json: true,
    });
    expect(read).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await expect(resolve({ message: "" })).rejects.toThrow("Missing message");
    await expect(resolve({ message: "inline", messageFile: "file" })).rejects.toThrow("Use either");
    await expect(resolve({ messageFile: " " })).rejects.toThrow("must not be empty");
    expect(read).not.toHaveBeenCalled();
  });

  it("does not wait for input from a terminal", async () => {
    const { resolve, read } = parser(undefined, { tty: true });
    await expect(resolve({})).rejects.toThrow("Missing message");
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["", " \n\t"])("rejects empty piped input: %j", async (input) => {
    const { resolve } = parser(undefined, { input: Buffer.from(input) });
    await expect(resolve({})).rejects.toThrow("Missing message");
  });

  it("retains native decoding and size limits for stdin", async () => {
    await expect(parser(undefined, { input: Buffer.from([255]) }).resolve({})).rejects.toThrow(
      "must be valid UTF-8",
    );
    await expect(parser(undefined, { input: Buffer.alloc(4194305) }).resolve({})).rejects.toThrow(
      "exceeds 4194304 bytes",
    );
    await expect(
      parser(undefined, { input: Buffer.from("\uFEFFping") }).resolve({}),
    ).resolves.toEqual({ message: "ping" });
  });

  it("retains denial for a file that does not identify stdin", async () => {
    const { resolve, read } = parser(undefined, { denied: true, same: false });
    await expect(resolve({ messageFile: "private-file" })).rejects.toThrow(
      "Unable to read message file private-file",
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("closes native file handles after reading explicit files", async () => {
    const { resolve, open, read, close } = parser();
    await expect(resolve({ messageFile: "message with spaces" })).resolves.toEqual({
      message: "ping\n",
    });
    expect(open).toHaveBeenCalledWith("message with spaces", "r");
    expect(read).toHaveBeenCalledWith(8, 4194304);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects native drift and incomplete patches", () => {
    const patched = patchAgentMessageInput(native);
    expect(patchAgentMessageInput(patched)).toBe(patched);
    expect(() => patchAgentMessageInput(native.replace("4194304", "8388608"))).toThrow(
      "Unrecognized",
    );
    expect(() => patchAgentMessageInput(patched.replace("input.dev === file.dev", "true"))).toThrow(
      "Unrecognized",
    );
    expect(() =>
      patchAgentMessageInput(
        patched.replace('import { fstatSync as nemoclawStdinStat } from "node:fs";\n', ""),
      ),
    ).toThrow("Incomplete");
  });

  it("audits the installed native parser and rejects unsupported versions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-message-patch-"));
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    const target = path.join(dist, "agent-via-gateway-fixture.js");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
    fs.writeFileSync(target, native);
    try {
      expect(() => patchOpenClawAgentMessageInput(dist, true)).toThrow("patch is missing");
      patchOpenClawAgentMessageInput(dist);
      expect(() => patchOpenClawAgentMessageInput(dist, true)).not.toThrow();
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.3" }));
      expect(() => patchOpenClawAgentMessageInput(dist)).toThrow("Unsupported OpenClaw version");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
