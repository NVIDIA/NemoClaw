// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import readline from "node:readline";

export interface MessagingChannelSelectorEntry {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
}

export type MessagingSelectorInput = typeof process.stdin & {
  readonly isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
};

export type MessagingSelectorOutput = typeof process.stderr & {
  readonly isTTY?: boolean;
};

export type MessagingSelectorKeyAction = "continue" | "redraw" | "finish" | "interrupt";

export interface MessagingSelectorNormalizerState {
  carry: string;
}

const APPLICATION_KEYPAD_DIGITS: Record<string, string> = {
  p: "0",
  q: "1",
  r: "2",
  s: "3",
  t: "4",
  u: "5",
  v: "6",
  w: "7",
  x: "8",
  y: "9",
  M: "\r",
};

export function createMessagingSelectorNormalizerState(): MessagingSelectorNormalizerState {
  return { carry: "" };
}

export function normalizeMessagingSelectorInput(
  text: string,
  state?: MessagingSelectorNormalizerState,
): string {
  const combined = `${state?.carry ?? ""}${text}`;
  const { complete, carry } = splitIncompleteMessagingSelectorInput(combined);
  if (state) state.carry = carry;

  return complete
    .replace(/\x1bO([Mp-y])/g, (_match, key: string) => APPLICATION_KEYPAD_DIGITS[key] || "")
    .replace(/\x1b\[(\d+)(?:;\d+)*u/g, (_match, code: string) => {
      const charCode = Number.parseInt(code, 10);
      if (charCode >= 48 && charCode <= 57) return String.fromCharCode(charCode);
      if (charCode === 13) return "\r";
      return "";
    });
}

export function applyMessagingSelectorKey(
  key: string,
  enabled: Set<string>,
  availableChannels: readonly MessagingChannelSelectorEntry[],
): MessagingSelectorKeyAction {
  if (key === "\u0003") return "interrupt";
  if (key === "\r" || key === "\n") return "finish";

  const num = Number.parseInt(key, 10);
  if (num >= 1 && num <= availableChannels.length) {
    const channel = availableChannels[num - 1];
    if (enabled.has(channel.id)) {
      enabled.delete(channel.id);
    } else {
      enabled.add(channel.id);
    }
    return "redraw";
  }

  return "continue";
}

export function renderMessagingChannelList<T extends MessagingChannelSelectorEntry>(
  output: Pick<MessagingSelectorOutput, "write">,
  availableChannels: readonly T[],
  enabled: Set<string>,
  statusForChannel: (channel: T) => string,
): void {
  output.write("\n");
  output.write("  Available messaging channels:\n");
  availableChannels.forEach((channel, index) => {
    const marker = enabled.has(channel.id) ? "●" : "○";
    output.write(
      `    [${index + 1}] ${marker} ${channel.id} — ${
        channel.description ?? channel.displayName
      }${statusForChannel(channel)}\n`,
    );
  });
  output.write("\n");
}

export function resolveMessagingChannelSelectorEntry<T extends MessagingChannelSelectorEntry>(
  value: string,
  availableChannels: readonly T[],
): T | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  const numeric = Number.parseInt(trimmed, 10);
  if (String(numeric) === trimmed && numeric >= 1 && numeric <= availableChannels.length) {
    return availableChannels[numeric - 1] ?? null;
  }

  return availableChannels.find((channel) => channel.id === trimmed) ?? null;
}

export async function promptMessagingChannelLineSelection<T extends MessagingChannelSelectorEntry>(
  availableChannels: readonly T[],
  enabled: Set<string>,
  statusForChannel: (channel: T) => string,
): Promise<void> {
  renderMessagingChannelList(process.stderr, availableChannels, enabled, statusForChannel);
  console.error("  Enter comma-separated numbers/IDs, Enter for current selection, or 'none'.");

  const answer = (await promptMessagingSelectorLine("  Messaging channel numbers/IDs: ")).trim();
  if (!answer) return;
  if (/^(none|no|skip)$/i.test(answer)) {
    enabled.clear();
    return;
  }

  const next = new Set<string>();
  for (const part of answer.split(/[\s,]+/).filter(Boolean)) {
    const channel = resolveMessagingChannelSelectorEntry(part, availableChannels);
    if (!channel) {
      console.error(`  Unknown messaging channel selection: ${part}`);
      process.exit(1);
    }
    next.add(channel.id);
  }

  enabled.clear();
  for (const channel of next) enabled.add(channel);
}

export function readMessagingChannelSelection<T extends MessagingChannelSelectorEntry>(
  availableChannels: readonly T[],
  enabled: Set<string>,
  showList: () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const input = process.stdin as MessagingSelectorInput;
    const output = process.stderr;
    const normalizerState = createMessagingSelectorNormalizerState();
    let rawModeEnabled = false;
    let finished = false;

    function cleanup() {
      input.removeListener("data", onData);
      process.removeListener("SIGINT", sigintHandler);
      process.removeListener("SIGTERM", sigtermHandler);
      if (rawModeEnabled && typeof input.setRawMode === "function") {
        input.setRawMode(false);
      }
      if (typeof input.pause === "function") {
        input.pause();
      }
      if (typeof input.unref === "function") {
        input.unref();
      }
    }

    function finish(): void {
      if (finished) return;
      finished = true;
      cleanup();
      output.write("\n");
      resolve();
    }

    function interrupt(signal: NodeJS.Signals): void {
      if (finished) return;
      finished = true;
      cleanup();
      reject(Object.assign(new Error("Prompt interrupted"), { code: signal }));
      process.kill(process.pid, signal);
    }

    function sigintHandler(): void {
      interrupt("SIGINT");
    }

    function sigtermHandler(): void {
      interrupt("SIGTERM");
    }

    function onData(chunk: Buffer | string): void {
      const text = normalizeMessagingSelectorInput(chunk.toString("utf8"), normalizerState);
      for (let index = 0; index < text.length; index += 1) {
        const action = applyMessagingSelectorKey(text[index], enabled, availableChannels);
        if (action === "interrupt") {
          interrupt("SIGINT");
          return;
        }
        if (action === "finish") {
          finish();
          return;
        }
        if (action === "redraw") {
          showList();
        }
      }
    }

    if (typeof input.ref === "function") {
      input.ref();
    }
    input.setEncoding("utf8");
    if (typeof input.resume === "function") {
      input.resume();
    }
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
      rawModeEnabled = true;
    }
    process.on("SIGINT", sigintHandler);
    process.on("SIGTERM", sigtermHandler);
    input.on("data", onData);
  });
}

function splitIncompleteMessagingSelectorInput(text: string): {
  complete: string;
  carry: string;
} {
  const incomplete =
    text.match(/\x1b\[[0-9;]*$/)?.[0] ??
    text.match(/\x1bO$/)?.[0] ??
    text.match(/\x1b$/)?.[0] ??
    "";

  if (!incomplete) return { complete: text, carry: "" };
  return {
    complete: text.slice(0, text.length - incomplete.length),
    carry: incomplete,
  };
}

function promptMessagingSelectorLine(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof process.stdin.ref === "function") {
      process.stdin.ref();
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    let finished = false;

    function cleanup() {
      rl.close();
      if (typeof process.stdin.pause === "function") {
        process.stdin.pause();
      }
      if (typeof process.stdin.unref === "function") {
        process.stdin.unref();
      }
    }

    function resolvePrompt(value: string) {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(value);
    }

    function rejectPrompt(error: Error) {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    }

    rl.on("SIGINT", () => {
      rejectPrompt(Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" }));
      process.kill(process.pid, "SIGINT");
    });
    rl.question(question, resolvePrompt);
  });
}
