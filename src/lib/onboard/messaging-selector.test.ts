// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import readline from "node:readline";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isAnyPromptActive } from "../core/prompt-activity";
import {
  applyMessagingSelectorKey,
  createMessagingSelectorNormalizerState,
  normalizeMessagingSelectorInput,
  promptMessagingChannelLineSelection,
  readMessagingChannelSelection,
  resolveMessagingChannelSelectorEntry,
} from "./messaging-selector";

const channels = [
  { id: "telegram", displayName: "Telegram", description: "Telegram bot messaging" },
  { id: "discord", displayName: "Discord", description: "Discord bot messaging" },
  { id: "wechat", displayName: "WeChat", description: "WeChat bot messaging" },
];

const ORIGINAL_STDIN = Object.getOwnPropertyDescriptor(process, "stdin");
const ORIGINAL_STDERR = Object.getOwnPropertyDescriptor(process, "stderr");

function restoreProcessDescriptor(
  property: "stdin" | "stderr",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(process, property, descriptor);
    return;
  }
  Reflect.deleteProperty(process, property);
}

function createMockSelectorInput(): EventEmitter & {
  setRawMode: ReturnType<typeof vi.fn>;
  setEncoding: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  ref: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
} {
  const input = new EventEmitter() as EventEmitter & {
    setRawMode: ReturnType<typeof vi.fn>;
    setEncoding: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    ref: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  input.setRawMode = vi.fn();
  input.setEncoding = vi.fn();
  input.resume = vi.fn();
  input.pause = vi.fn();
  input.ref = vi.fn();
  input.unref = vi.fn();
  return input;
}

afterEach(() => {
  restoreProcessDescriptor("stdin", ORIGINAL_STDIN);
  restoreProcessDescriptor("stderr", ORIGINAL_STDERR);
  vi.restoreAllMocks();
});

describe("messaging selector key handling", () => {
  it("toggles numeric raw keypresses before Enter confirms", () => {
    const enabled = new Set<string>();

    expect(applyMessagingSelectorKey("1", enabled, channels)).toBe("redraw");
    expect([...enabled]).toEqual(["telegram"]);
    expect(applyMessagingSelectorKey("2", enabled, channels)).toBe("redraw");
    expect([...enabled]).toEqual(["telegram", "discord"]);
    expect(applyMessagingSelectorKey("\r", enabled, channels)).toBe("finish");
  });

  it("treats a raw Ctrl-D as a closed stdin (#12169)", () => {
    const enabled = new Set<string>(["telegram"]);

    expect(applyMessagingSelectorKey("\u0004", enabled, channels)).toBe("eof");
    expect([...enabled]).toEqual(["telegram"]);
  });

  it("normalizes complete terminal keypad and extended numeric sequences", () => {
    expect(normalizeMessagingSelectorInput("\x1bOq")).toBe("1");
    expect(normalizeMessagingSelectorInput("\x1b[49;5u")).toBe("1");
    expect(normalizeMessagingSelectorInput("\x1bOM")).toBe("\r");
    expect(normalizeMessagingSelectorInput("\x1b[13u")).toBe("\r");
  });

  it("buffers split terminal keypad and extended numeric sequences", () => {
    const state = createMessagingSelectorNormalizerState();

    expect(normalizeMessagingSelectorInput("\x1bO", state)).toBe("");
    expect(state.carry).toBe("\x1bO");
    expect(normalizeMessagingSelectorInput("q", state)).toBe("1");
    expect(state.carry).toBe("");

    expect(normalizeMessagingSelectorInput("\x1b[49;", state)).toBe("");
    expect(state.carry).toBe("\x1b[49;");
    expect(normalizeMessagingSelectorInput("5u", state)).toBe("1");
    expect(state.carry).toBe("");
  });

  it("resolves line-mode selections by number or channel id", () => {
    expect(resolveMessagingChannelSelectorEntry("2", channels)?.id).toBe("discord");
    expect(resolveMessagingChannelSelectorEntry("WeChat", channels)?.id).toBe("wechat");
    expect(resolveMessagingChannelSelectorEntry("mattermost", channels)).toBeNull();
  });

  it("releases line-mode prompt activity when stdin closes before an answer (#6651)", async () => {
    const rl = new EventEmitter() as EventEmitter & {
      close: ReturnType<typeof vi.fn>;
      question: ReturnType<typeof vi.fn>;
    };
    rl.close = vi.fn();
    rl.question = vi.fn();
    vi.spyOn(readline, "createInterface").mockReturnValue(rl as unknown as readline.Interface);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stdinRef = vi.spyOn(process.stdin, "ref").mockImplementation(() => process.stdin);
    const stdinPause = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    const stdinUnref = vi.spyOn(process.stdin, "unref").mockImplementation(() => process.stdin);

    expect(isAnyPromptActive()).toBe(false);
    const selection = promptMessagingChannelLineSelection(channels, new Set<string>(), () => "");
    expect(isAnyPromptActive()).toBe(true);

    rl.emit("close");

    await expect(selection).rejects.toMatchObject({ code: "EOF" });
    expect(isAnyPromptActive()).toBe(false);
    expect(rl.close).toHaveBeenCalledOnce();
    expect(stdinRef).toHaveBeenCalledOnce();
    expect(stdinPause).toHaveBeenCalledOnce();
    expect(stdinUnref).toHaveBeenCalledOnce();
  });

  it("releases raw-mode prompt activity when terminal setup throws (#6651)", async () => {
    const input = createMockSelectorInput();
    input.setRawMode.mockImplementation(() => {
      throw new Error("raw mode unavailable");
    });
    const output = { write: vi.fn() };
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: input,
    });
    Object.defineProperty(process, "stderr", {
      configurable: true,
      value: output,
    });

    expect(isAnyPromptActive()).toBe(false);
    const selection = readMessagingChannelSelection(channels, new Set<string>(), () => {});

    await expect(selection).rejects.toThrow("raw mode unavailable");
    expect(isAnyPromptActive()).toBe(false);
    expect(input.pause).toHaveBeenCalledOnce();
    expect(input.unref).toHaveBeenCalledOnce();
    expect(input.listenerCount("data")).toBe(0);
  });

  it("releases raw-mode prompt activity when stdin closes before a selection (#6651)", async () => {
    const input = createMockSelectorInput();
    const output = { write: vi.fn() };
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: input,
    });
    Object.defineProperty(process, "stderr", {
      configurable: true,
      value: output,
    });

    expect(isAnyPromptActive()).toBe(false);
    const selection = readMessagingChannelSelection(channels, new Set<string>(), () => {});
    expect(isAnyPromptActive()).toBe(true);

    input.emit("close");

    await expect(selection).rejects.toMatchObject({ code: "EOF" });
    expect(isAnyPromptActive()).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
  });

  it("treats a leading NUL byte as a lost Ctrl-D and cancels the raw menu (#13910)", async () => {
    // A Ctrl-D queued while the terminal was cooked becomes a NUL byte when
    // the raw-mode switch lands before it is read; the menu must still settle.
    const input = createMockSelectorInput();
    const output = { write: vi.fn() };
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: input,
    });
    Object.defineProperty(process, "stderr", {
      configurable: true,
      value: output,
    });

    const selection = readMessagingChannelSelection(channels, new Set<string>(), () => {});
    input.emit("data", "\u0000");

    await expect(selection).rejects.toMatchObject({ code: "EOF" });
    expect(isAnyPromptActive()).toBe(false);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("does not treat a NUL byte after real input as a cancellation (#13910)", async () => {
    const input = createMockSelectorInput();
    const output = { write: vi.fn() };
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: input,
    });
    Object.defineProperty(process, "stderr", {
      configurable: true,
      value: output,
    });

    const selection = readMessagingChannelSelection(channels, new Set<string>(), () => {});
    input.emit("data", "1");
    // After real input the NUL is an ordinary ignored byte, not a cancellation;
    // the menu keeps waiting until stdin actually closes.
    input.emit("data", "\u0000");
    input.emit("close");

    await expect(selection).rejects.toMatchObject({ code: "EOF" });
  });

  it("cancels and restores the terminal when Ctrl-D is pressed in the raw menu (#12169)", async () => {
    const input = createMockSelectorInput();
    const output = { write: vi.fn() };
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: input,
    });
    Object.defineProperty(process, "stderr", {
      configurable: true,
      value: output,
    });

    const selection = readMessagingChannelSelection(channels, new Set<string>(), () => {});
    input.emit("data", "\u0004");

    await expect(selection).rejects.toMatchObject({ code: "EOF" });
    expect(isAnyPromptActive()).toBe(false);
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
  });

  it("restores raw mode and removes listeners when SIGTERM interrupts", async () => {
    const input = createMockSelectorInput();
    const output = { write: vi.fn() };
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: input,
    });
    Object.defineProperty(process, "stderr", {
      configurable: true,
      value: output,
    });
    const processOn = vi.spyOn(process, "on");
    const processRemoveListener = vi.spyOn(process, "removeListener");
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation((_pid: number, _signal?: string | number) => true);

    const selection = readMessagingChannelSelection(channels, new Set<string>(), () => {});
    const sigtermHandler = processOn.mock.calls.find(([signal]) => signal === "SIGTERM")?.[1];
    expect(sigtermHandler).toBeTypeOf("function");

    (sigtermHandler as () => void)();

    await expect(selection).rejects.toMatchObject({ code: "SIGTERM" });
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenNthCalledWith(2, false);
    expect(input.pause).toHaveBeenCalledOnce();
    expect(input.unref).toHaveBeenCalledOnce();
    expect(input.listenerCount("data")).toBe(0);
    expect(processRemoveListener).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processRemoveListener).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(processKill).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });
});
