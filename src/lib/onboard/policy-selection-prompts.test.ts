// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TierDefinition } from "../policy/tiers";
import { createPolicySelectionPromptHelpers } from "./policy-selection-prompts";
import { selectFromNumberedMenuOrExit } from "./prompt-helpers";

class FakeInput extends EventEmitter {
  isTTY: boolean;
  ref = vi.fn();
  pause = vi.fn();
  resume = vi.fn();
  setEncoding = vi.fn();
  setRawMode = vi.fn();
  unref = vi.fn();

  constructor(isTTY = true) {
    super();
    this.isTTY = isTTY;
  }
}

class FakeOutput {
  isTTY: boolean;
  chunks: string[] = [];
  write = vi.fn((chunk: string | Uint8Array) => {
    this.chunks.push(String(chunk));
    return true;
  });

  constructor(isTTY = true) {
    this.isTTY = isTTY;
  }
}

const TIERS: TierDefinition[] = [
  {
    name: "restricted",
    label: "Restricted",
    description: "Minimal egress",
    presets: [],
  },
  {
    name: "balanced",
    label: "Balanced",
    description: "Common package registries",
    presets: [
      { name: "npm", access: "read" },
      { name: "pypi", access: "read-write" },
    ],
  },
  {
    name: "open",
    label: "Open",
    description: "Permissive egress",
    presets: [
      { name: "npm", access: "read-write" },
      { name: "github", access: "read-write" },
    ],
  },
];

function createHarness({
  tiers = TIERS,
  stdinTTY = true,
  stdoutTTY = true,
  promptReplies = [],
}: {
  tiers?: TierDefinition[];
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  promptReplies?: string[];
} = {}) {
  const stdin = new FakeInput(stdinTTY);
  const stdout = new FakeOutput(stdoutTTY);
  const processEvents = new EventEmitter();
  const markCancelled = vi.fn();
  const prompt = vi.fn(async () => promptReplies.shift() ?? "");

  const helpers = createPolicySelectionPromptHelpers({
    tiers: {
      listTiers: () => tiers,
      getTier: (name) => tiers.find((tier) => tier.name === name) ?? null,
    },
    policyTierEnv: {
      resolvePolicyTierFromEnv: () => "balanced",
    },
    isNonInteractive: () => false,
    note: vi.fn(),
    prompt,
    selectFromNumberedMenuOrExit,
    makeOnboardCancelExit: (rollback, cleanup) => () => {
      cleanup();
      rollback.markCancelled();
    },
    sandboxCancelRollback: { markCancelled },
    useColor: false,
    stdin,
    stdout,
    processEvents,
  });

  return { helpers, markCancelled, processEvents, prompt, stdin, stdout };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createPolicySelectionPromptHelpers", () => {
  it("selectPolicyTier resolves numbered choices in the non-TTY fallback", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { helpers, prompt } = createHarness({
      stdinTTY: false,
      stdoutTTY: false,
      promptReplies: ["3"],
    });

    await expect(helpers.selectPolicyTier()).resolves.toBe("open");
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("Select tier [1-3]"));
  });

  it("selectPolicyTier keeps the balanced default on blank non-TTY input", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { helpers } = createHarness({
      stdinTTY: false,
      stdoutTTY: false,
      promptReplies: [""],
    });

    await expect(helpers.selectPolicyTier()).resolves.toBe("balanced");
  });

  it("selectTierPresetsAndAccess honors comma-separated non-TTY allowlists", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { helpers } = createHarness({
      stdinTTY: false,
      stdoutTTY: false,
      promptReplies: ["github, npm, missing"],
    });

    await expect(
      helpers.selectTierPresetsAndAccess("balanced", [
        { name: "npm" },
        { name: "pypi" },
        { name: "github" },
      ]),
    ).resolves.toEqual([
      { name: "npm", access: "read" },
      { name: "github", access: "read-write" },
    ]);
    expect(errorSpy).toHaveBeenCalledWith("  Unknown preset name ignored: missing");
  });

  it("selectTierPresetsAndAccess returns raw-mode access toggles on Enter", async () => {
    const { helpers, markCancelled, stdin } = createHarness();
    const result = helpers.selectTierPresetsAndAccess("balanced", [
      { name: "npm" },
      { name: "pypi" },
      { name: "github" },
    ]);

    stdin.emit("data", "\x1b[B");
    stdin.emit("data", "\x1b[B");
    stdin.emit("data", " ");
    stdin.emit("data", "r");
    stdin.emit("data", "\r");

    await expect(result).resolves.toEqual([
      { name: "npm", access: "read" },
      { name: "pypi", access: "read-write" },
      { name: "github", access: "read" },
    ]);
    expect(markCancelled).not.toHaveBeenCalled();
    expect(stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("selectPolicyTier marks rollback and restores raw mode on SIGTERM", () => {
    const { helpers, markCancelled, processEvents, stdin } = createHarness();

    void helpers.selectPolicyTier();
    processEvents.emit("SIGTERM");

    expect(markCancelled).toHaveBeenCalledOnce();
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("presetsCheckboxSelector marks rollback and restores raw mode on Ctrl-C", () => {
    const { helpers, markCancelled, stdin } = createHarness();

    void helpers.presetsCheckboxSelector([{ name: "npm", description: "npm registry" }], []);
    stdin.emit("data", "\x03");

    expect(markCancelled).toHaveBeenCalledOnce();
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("selectPolicyTier rejects when no policy tiers are configured", async () => {
    const { helpers } = createHarness({ tiers: [] });

    await expect(helpers.selectPolicyTier()).rejects.toThrow("No policy tiers are configured.");
  });
});
