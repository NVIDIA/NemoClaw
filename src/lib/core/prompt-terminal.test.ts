// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import readline from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStdinPromptInterface,
  PROMPT_INTERRUPT_EXIT_CODES,
  raisePromptInterrupt,
} from "./prompt-terminal";

/** The byte a terminal delivers for Ctrl-C when the line discipline is raw. */
const CTRL_C = "";

type PromptInput = NodeJS.ReadableStream & { isTTY?: boolean };

function makeInput(isTTY: boolean | undefined): PromptInput {
  const input = new PassThrough() as unknown as PromptInput;
  input.isTTY = isTTY;
  return input;
}

function stubInterface(): readline.Interface {
  const rl = { close: () => undefined } as unknown as readline.Interface;
  vi.spyOn(readline, "createInterface").mockReturnValue(rl);
  return rl;
}

function capturedOptions(): readline.ReadLineOptions {
  const spy = vi.mocked(readline.createInterface);
  expect(spy).toHaveBeenCalledOnce();
  return spy.mock.calls[0]?.[0] as readline.ReadLineOptions;
}

describe("createStdinPromptInterface", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps keypress handling when stdin is a TTY and stderr is captured (#12167)", () => {
    const rl = stubInterface();
    const input = makeInput(true);
    const output = new PassThrough() as unknown as NodeJS.WritableStream;

    expect(createStdinPromptInterface(input, output)).toBe(rl);
    expect(capturedOptions()).toMatchObject({ input, output, terminal: true });
  });

  it("keeps keypress handling when both stdin and stderr are TTYs", () => {
    stubInterface();
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
    }) as unknown as NodeJS.WritableStream;

    createStdinPromptInterface(makeInput(true), output);
    expect(capturedOptions()).toMatchObject({ terminal: true });
  });

  it("stays non-terminal for piped stdin so headless EOF cancellation is unchanged", () => {
    stubInterface();

    createStdinPromptInterface(makeInput(false));
    expect(capturedOptions()).toMatchObject({ terminal: false });
  });

  it("stays non-terminal when stdin reports no isTTY property", () => {
    stubInterface();

    createStdinPromptInterface(makeInput(undefined));
    expect(capturedOptions()).toMatchObject({ terminal: false });
  });

  it("defaults to process.stdin and process.stderr", () => {
    stubInterface();

    createStdinPromptInterface();
    expect(capturedOptions()).toMatchObject({ input: process.stdin, output: process.stderr });
  });

  it("emits SIGINT for a Ctrl-C keypress on a TTY stdin whose output is captured", async () => {
    const input = makeInput(true);
    const output = new PassThrough();
    const rl = createStdinPromptInterface(input, output as unknown as NodeJS.WritableStream);
    const interrupted = new Promise<void>((resolve) => {
      rl.on("SIGINT", () => resolve());
    });

    rl.question("  Choose [1]: ", () => undefined);
    (input as unknown as PassThrough).write(CTRL_C);

    await expect(interrupted).resolves.toBeUndefined();
    rl.close();
  });
});

describe("raisePromptInterrupt", () => {
  function makeProcess() {
    const kills: Array<[number, string]> = [];
    return {
      exitCode: undefined as number | string | null | undefined,
      pid: 4242,
      kill(pid: number, signal: "SIGINT" | "SIGTERM") {
        kills.push([pid, signal]);
        return true;
      },
      kills,
    };
  }

  it("pins exit 130 before re-raising so a cancelled prompt never exits 0 (#12167)", () => {
    const processLike = makeProcess();

    raisePromptInterrupt("SIGINT", processLike);

    expect(processLike.exitCode).toBe(PROMPT_INTERRUPT_EXIT_CODES.SIGINT);
    expect(processLike.kills).toEqual([[4242, "SIGINT"]]);
  });

  it("defaults to SIGINT", () => {
    const processLike = makeProcess();

    raisePromptInterrupt(undefined, processLike);

    expect(processLike.exitCode).toBe(130);
    expect(processLike.kills).toEqual([[4242, "SIGINT"]]);
  });

  it("pins exit 143 for a terminated prompt", () => {
    const processLike = makeProcess();

    raisePromptInterrupt("SIGTERM", processLike);

    expect(processLike.exitCode).toBe(PROMPT_INTERRUPT_EXIT_CODES.SIGTERM);
    expect(processLike.kills).toEqual([[4242, "SIGTERM"]]);
  });

  it("still pins the exit code when the process cannot be signalled", () => {
    const processLike = { exitCode: undefined as number | undefined };

    raisePromptInterrupt("SIGINT", processLike);

    expect(processLike.exitCode).toBe(130);
  });
});
