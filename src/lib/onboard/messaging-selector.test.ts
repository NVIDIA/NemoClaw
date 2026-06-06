// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyMessagingSelectorKey,
  createMessagingSelectorNormalizerState,
  normalizeMessagingSelectorInput,
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
