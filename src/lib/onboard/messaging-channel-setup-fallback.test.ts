// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import readline from "node:readline";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCredential, prompt } from "../credentials/store";
import { MESSAGING_SETUP_APPLIER_ENV_KEY } from "../messaging/applier/types";
import { validateSlackCredentials } from "../messaging/channels/slack/hooks/credential-validation";
import { setupMessagingChannels } from "./messaging-channel-setup";

vi.mock("../credentials/store", () => ({
  getCredential: vi.fn(() => null),
  normalizeCredentialValue: vi.fn((value: unknown) =>
    typeof value === "string" ? value.trim() : "",
  ),
  prompt: vi.fn(async () => ""),
  saveCredential: vi.fn(),
}));

vi.mock("../messaging/channels/slack/hooks/credential-validation", () => ({
  formatSlackValidationFailure: vi.fn((result: { message: string }) => result.message),
  validateSlackCredentials: vi.fn(() => ({ ok: true })),
}));

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_STDIN_IS_TTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const ORIGINAL_STDIN_SET_RAW_MODE = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const ORIGINAL_STDERR_IS_TTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

function mockLineModeAnswer(answer: string): { questions: string[] } {
  const questions: string[] = [];
  const rl = {
    question(question: string, callback: (answer: string) => void) {
      questions.push(question);
      callback(answer);
      return rl;
    },
    close() {},
    on() {
      return rl;
    },
  } as unknown as readline.Interface;

  vi.spyOn(readline, "createInterface").mockReturnValue(rl);
  return { questions };
}

function forceLineModeStdio(): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: false,
  });
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: false,
  });
}

function restoreDescriptor(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
    return;
  }
  Reflect.deleteProperty(target, property);
}

function stubTelegramReachability(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return { ok: true };
      },
      async text() {
        return "";
      },
    })),
  );
}

describe("setupMessagingChannels selector fallback", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.clearAllMocks();
    vi.mocked(getCredential).mockReturnValue(null);
    vi.mocked(prompt).mockResolvedValue("");
    vi.mocked(validateSlackCredentials).mockReturnValue({ ok: true });
    stubTelegramReachability();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    restoreDescriptor(process.stdin, "isTTY", ORIGINAL_STDIN_IS_TTY);
    restoreDescriptor(process.stdin, "setRawMode", ORIGINAL_STDIN_SET_RAW_MODE);
    restoreDescriptor(process.stderr, "isTTY", ORIGINAL_STDERR_IS_TTY);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses line-mode fallback and keeps seeded channels on empty selection", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:telegram-token";
    const { questions } = mockLineModeAnswer("");
    forceLineModeStdio();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });

    const result = await setupMessagingChannels(null, null, {
      isNonInteractive: () => false,
    });

    expect(readline.createInterface).toHaveBeenCalledOnce();
    expect(questions).toEqual(["  Messaging channel numbers/IDs: "]);
    expect(result).toEqual(["telegram"]);
    expect(logs.join("\n")).toContain("telegram — already configured");
  });

  it("uses line-mode fallback and clears seeded channels for none", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:telegram-token";
    process.env[MESSAGING_SETUP_APPLIER_ENV_KEY] = "stale-plan";
    const { questions } = mockLineModeAnswer("none");
    forceLineModeStdio();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });

    const result = await setupMessagingChannels(null, null, {
      isNonInteractive: () => false,
    });

    expect(readline.createInterface).toHaveBeenCalledOnce();
    expect(questions).toEqual(["  Messaging channel numbers/IDs: "]);
    expect(result).toEqual([]);
    expect(process.env[MESSAGING_SETUP_APPLIER_ENV_KEY]).toBeUndefined();
    expect(logs.join("\n")).toContain("Skipping messaging channels.");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("skips the interactive selector when no channels are available", async () => {
    const createInterfaceSpy = vi.spyOn(readline, "createInterface");
    const setRawMode = vi.fn(() => {
      throw new Error("raw selector should not start when no channels are available");
    });
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdin, "setRawMode", {
      configurable: true,
      value: setRawMode,
    });
    Object.defineProperty(process.stderr, "isTTY", {
      configurable: true,
      value: true,
    });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });

    const result = await setupMessagingChannels(
      {
        name: "openclaw",
        messagingPlatforms: ["unsupported-channel"],
      } as unknown as Parameters<typeof setupMessagingChannels>[0],
      null,
      { isNonInteractive: () => false },
    );

    expect(result).toEqual([]);
    expect(setRawMode).not.toHaveBeenCalled();
    expect(createInterfaceSpy).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Skipping messaging channels.");
  });
});
