// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as store from "../../credentials/store";
import * as policies from "../../policy";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import { addSandboxPolicy, removeSandboxPolicy } from "./policy-channel";

type PresetInfo = ReturnType<typeof policies.listPresets>[number];

class ExitError extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const POLICY_PRESETS: PresetInfo[] = [
  { file: "npm.yaml", name: "npm", description: "npm and Yarn registry access" },
  { file: "pypi.yaml", name: "pypi", description: "Python Package Index access" },
  { file: "discord.yaml", name: "discord", description: "Discord API access" },
  {
    file: "openclaw-pricing.yaml",
    name: "openclaw-pricing",
    description: "OpenClaw pricing lookup",
  },
  {
    file: "nous-web.yaml",
    name: "nous-web",
    description: "Nous Portal managed web search gateway",
  },
  {
    file: "nous-code.yaml",
    name: "nous-code",
    description: "Nous Portal managed sandboxed code gateway",
  },
  { file: "telegram.yaml", name: "telegram", description: "Telegram API access" },
  { file: "wechat.yaml", name: "wechat", description: "WeChat API access" },
];

let logSpy: MockInstance;
let errSpy: MockInstance;
let exitSpy: MockInstance;
let promptMock: MockInstance;
let getSandboxMock: MockInstance;
let getAppliedPresetsMock: MockInstance;
let getGatewayPresetsMock: MockInstance;
let selectFromListMock: MockInstance;
let selectForRemovalMock: MockInstance;
let loadPresetForSandboxMock: MockInstance;
let applyPresetMock: MockInstance;
let removePresetMock: MockInstance;

function printedText(): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls]
    .map((call) => call.map(String).join(" "))
    .join("\n");
}

async function captureExit(action: () => Promise<void>): Promise<number | undefined> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ExitError) return error.code;
    throw error;
  }
  throw new Error("Expected process.exit to be called");
}

function arrangeSandbox(agent: string | null = null): void {
  getSandboxMock.mockReturnValue({ name: "test-sandbox", agent, policies: ["pypi"] });
}

let stdinIsTty: PropertyDescriptor | undefined;

function arrangeTerminal(present: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: present ? true : undefined,
  });
}

beforeEach(() => {
  delete process.env.NEMOCLAW_NON_INTERACTIVE;
  stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  arrangeTerminal(true);

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);

  promptMock = vi.spyOn(store, "prompt").mockResolvedValue("y");
  getSandboxMock = vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: "test-sandbox",
    agent: null,
  });

  vi.spyOn(onboardSession, "loadSession").mockReturnValue(null);
  vi.spyOn(onboardSession, "updateSession").mockReturnValue(
    undefined as unknown as onboardSession.Session,
  );

  vi.spyOn(policies, "listPresets").mockReturnValue(POLICY_PRESETS);
  vi.spyOn(policies, "listCustomPresets").mockReturnValue([]);
  getAppliedPresetsMock = vi.spyOn(policies, "getAppliedPresets").mockReturnValue([]);
  getGatewayPresetsMock = vi.spyOn(policies, "getGatewayPresets").mockReturnValue(null);
  selectFromListMock = vi.spyOn(policies, "selectFromList").mockResolvedValue("pypi");
  selectForRemovalMock = vi.spyOn(policies, "selectForRemoval").mockResolvedValue("pypi");
  vi.spyOn(policies, "loadPreset").mockImplementation((name: unknown) => {
    const presetName = String(name);
    return `network_policies:\n  ${presetName}:\n    name: ${presetName}\n    endpoints:\n      - host: ${presetName}.example.com\n        port: 443\n        protocol: rest\n        rules:\n          - allow: { method: GET, path: "/**" }\n`;
  });
  loadPresetForSandboxMock = vi
    .spyOn(policies, "loadPresetForSandbox")
    .mockImplementation((_sandboxName: unknown, name: unknown) => {
      const presetName = String(name);
      return `network_policies:\n  ${presetName}:\n    name: ${presetName}\n    endpoints:\n      - host: ${presetName}.example.com\n        port: 443\n        protocol: rest\n        rules:\n          - allow: { method: GET, path: "/**" }\n`;
    });
  applyPresetMock = vi.spyOn(policies, "applyPreset").mockReturnValue(true);
  removePresetMock = vi.spyOn(policies, "removePreset").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEMOCLAW_NON_INTERACTIVE;
  stdinIsTty
    ? Object.defineProperty(process.stdin, "isTTY", stdinIsTty)
    : Reflect.deleteProperty(process.stdin, "isTTY");
});

describe("addSandboxPolicy", () => {
  it("prompts for confirmation before applying an interactively selected preset", async () => {
    await addSandboxPolicy("test-sandbox");

    expect(promptMock).toHaveBeenCalledWith("  Apply 'pypi' to sandbox 'test-sandbox'? [Y/n]: ");
    expect(applyPresetMock).toHaveBeenCalledWith("test-sandbox", "pypi", {
      suppressDisclosure: true,
    });
  });

  it("skips applying an interactively selected preset when confirmation is declined", async () => {
    promptMock.mockResolvedValue("n");

    await addSandboxPolicy("test-sandbox");

    expect(promptMock).toHaveBeenCalledWith("  Apply 'pypi' to sandbox 'test-sandbox'? [Y/n]: ");
    expect(applyPresetMock).not.toHaveBeenCalled();
  });

  it("prints a preview without prompting or applying when --dry-run is passed", async () => {
    await addSandboxPolicy("test-sandbox", { dryRun: true });

    expect(promptMock).not.toHaveBeenCalled();
    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(printedText()).toContain("Effective egress that would be opened:");
    expect(printedText()).toContain("- pypi.example.com:443");
    expect(printedText()).toContain("--dry-run: no changes applied.");
  });

  it("accepts an explicit preset with --yes for headless use", async () => {
    await addSandboxPolicy("test-sandbox", { preset: "pypi", yes: true });

    expect(promptMock).not.toHaveBeenCalled();
    expect(applyPresetMock).toHaveBeenCalledWith("test-sandbox", "pypi", {
      suppressDisclosure: true,
    });
  });

  it("honors non-interactive mode when an explicit preset is provided", async () => {
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";

    await addSandboxPolicy("test-sandbox", { preset: "pypi" });

    expect(promptMock).not.toHaveBeenCalled();
    expect(applyPresetMock).toHaveBeenCalledWith("test-sandbox", "pypi", {
      suppressDisclosure: true,
    });
  });

  it("fails fast in non-interactive mode without an explicit preset", async () => {
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";

    await expect(captureExit(() => addSandboxPolicy("test-sandbox"))).resolves.toBe(1);

    expect(printedText()).toContain("Non-interactive mode requires a preset name.");
    expect(applyPresetMock).not.toHaveBeenCalled();
  });

  it("never reaches the picker in a session without a terminal (#8877)", async () => {
    arrangeTerminal(false);

    await expect(captureExit(() => addSandboxPolicy("test-sandbox"))).resolves.toBe(1);

    expect(selectFromListMock).not.toHaveBeenCalled();
    expect(printedText()).toContain("No input available on stdin");
    expect(applyPresetMock).not.toHaveBeenCalled();
  });

  it("exits non-zero when the add picker reaches stdin EOF (#7418)", async () => {
    selectFromListMock.mockRejectedValueOnce(
      Object.assign(new Error("Prompt closed before input"), { code: "EOF" }),
    );

    await expect(captureExit(() => addSandboxPolicy("test-sandbox"))).resolves.toBe(1);

    // Names the real condition rather than reporting non-interactive mode,
    // which is not what happened here.
    expect(printedText()).toContain("No input available on stdin");
    expect(applyPresetMock).not.toHaveBeenCalled();
  });

  it("propagates a non-EOF picker failure instead of exiting (#7418)", async () => {
    const failure = Object.assign(new Error("stdin read failed"), { code: "EIO" });
    selectFromListMock.mockRejectedValueOnce(failure);

    await expect(addSandboxPolicy("test-sandbox")).rejects.toBe(failure);

    expect(applyPresetMock).not.toHaveBeenCalled();
  });

  it("filters Hermes-only presets from the OpenClaw picker", async () => {
    arrangeSandbox("openclaw");

    await addSandboxPolicy("test-sandbox");

    const pickerNames = selectFromListMock.mock.calls[0][0].map(
      (preset: PresetInfo) => preset.name,
    );
    expect(pickerNames).toEqual(
      expect.arrayContaining(["npm", "pypi", "discord", "openclaw-pricing"]),
    );
    expect(pickerNames).not.toContain("nous-web");
    expect(pickerNames).not.toContain("nous-code");
  });

  it("rejects Hermes-only preset names for OpenClaw sandboxes", async () => {
    arrangeSandbox("openclaw");

    await expect(
      captureExit(() => addSandboxPolicy("test-sandbox", { preset: "nous-web", yes: true })),
    ).resolves.toBe(1);

    expect(printedText()).toContain("Unknown preset 'nous-web'.");
    expect(printedText()).toContain("Valid presets: npm, pypi, discord, openclaw-pricing");
    expect(applyPresetMock).not.toHaveBeenCalled();
  });

  it("filters OpenClaw-only presets from the Hermes picker", async () => {
    arrangeSandbox("hermes");

    await addSandboxPolicy("test-sandbox");

    const pickerNames = selectFromListMock.mock.calls[0][0].map(
      (preset: PresetInfo) => preset.name,
    );
    expect(pickerNames).toEqual(
      expect.arrayContaining(["npm", "pypi", "discord", "nous-web", "nous-code"]),
    );
    expect(pickerNames).not.toContain("openclaw-pricing");
  });

  it("rejects OpenClaw-only preset names for Hermes sandboxes", async () => {
    arrangeSandbox("hermes");

    await expect(
      captureExit(() =>
        addSandboxPolicy("test-sandbox", { preset: "openclaw-pricing", yes: true }),
      ),
    ).resolves.toBe(1);

    expect(printedText()).toContain("Unknown preset 'openclaw-pricing'.");
    expect(printedText()).toContain("Valid presets: npm, pypi, discord, nous-web, nous-code");
    expect(applyPresetMock).not.toHaveBeenCalled();
  });

  it("treats messaging channel policy presets unavailable to terminal-runtime agents as unknown before preview or prompt", async () => {
    arrangeSandbox("langchain-deepagents-code");
    vi.spyOn(policies, "listPresets").mockReturnValue([
      { file: "npm.yaml", name: "npm", description: "npm and Yarn registry access" },
      { file: "pypi.yaml", name: "pypi", description: "Python Package Index access" },
      { file: "tavily.yaml", name: "tavily", description: "Tavily Search API access" },
    ]);

    await expect(
      captureExit(() => addSandboxPolicy("test-sandbox", { preset: "telegram", yes: true })),
    ).resolves.toBe(1);

    const output = printedText();
    expect(output).toContain("Unknown preset 'telegram'.");
    expect(output).toContain("Valid presets: npm, pypi, tavily");
    expect(output).not.toContain("not supported for agent");
    expect(output).not.toContain("Channels supported by agent");
    expect(output).not.toContain("Preset not found");
    expect(output).not.toContain("Effective egress that would be opened");
    expect(promptMock).not.toHaveBeenCalled();
    expect(loadPresetForSandboxMock).not.toHaveBeenCalled();
    expect(applyPresetMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      preset: "telegram",
      expected: "Note: the 'telegram' preset only opens network egress to the Telegram API.",
      detail: "re-run 'nemoclaw onboard' and select Telegram",
    },
    {
      preset: "wechat",
      expected: "Note: the 'wechat' preset only opens network egress to the WeChat API.",
      detail: "re-run 'nemoclaw onboard' and select WeChat",
    },
    {
      preset: "discord",
      expected: "curl is not in the preset binary allowlist, so curl probes can fail",
      detail: "https://discord.com/api/v10/gateway",
    },
  ])(
    "prints validation guidance when $preset is selected interactively",
    async ({ preset, expected, detail }) => {
      selectFromListMock.mockResolvedValue(preset);

      await addSandboxPolicy("test-sandbox");

      expect(printedText()).toContain(expected);
      expect(printedText()).toContain(detail);
      expect(applyPresetMock).toHaveBeenCalledWith("test-sandbox", preset, {
        suppressDisclosure: true,
      });
    },
  );

  it("prints Discord validation guidance when the preset name is provided", async () => {
    await addSandboxPolicy("test-sandbox", { preset: "discord", yes: true });

    expect(printedText()).toContain("curl is not in the preset binary allowlist");
    expect(printedText()).toContain("Node HTTPS");
    expect(promptMock).not.toHaveBeenCalled();
    expect(applyPresetMock).toHaveBeenCalledWith("test-sandbox", "discord", {
      suppressDisclosure: true,
    });
  });

  it("does not print messaging guidance when a non-messaging preset is selected", async () => {
    await addSandboxPolicy("test-sandbox");

    expect(printedText()).not.toContain("only opens network egress to the");
    expect(printedText()).not.toContain("re-run 'nemoclaw onboard' and select");
    expect(applyPresetMock).toHaveBeenCalledWith("test-sandbox", "pypi", {
      suppressDisclosure: true,
    });
  });
});

describe("removeSandboxPolicy", () => {
  beforeEach(() => {
    getAppliedPresetsMock.mockReturnValue(["pypi"]);
  });

  it("prompts for confirmation before removing an interactively selected preset", async () => {
    await removeSandboxPolicy("test-sandbox");

    expect(promptMock).toHaveBeenCalledWith("  Remove 'pypi' from sandbox 'test-sandbox'? [Y/n]: ");
    expect(removePresetMock).toHaveBeenCalledWith("test-sandbox", "pypi");
  });

  it("skips removing an interactively selected preset when confirmation is declined", async () => {
    promptMock.mockResolvedValue("n");

    await removeSandboxPolicy("test-sandbox");

    expect(promptMock).toHaveBeenCalledWith("  Remove 'pypi' from sandbox 'test-sandbox'? [Y/n]: ");
    expect(removePresetMock).not.toHaveBeenCalled();
  });

  it("prints a preview without prompting or removing when --dry-run is passed", async () => {
    await removeSandboxPolicy("test-sandbox", { dryRun: true });

    expect(promptMock).not.toHaveBeenCalled();
    expect(removePresetMock).not.toHaveBeenCalled();
    expect(printedText()).toContain("Endpoints that would be removed: pypi.example.com");
    expect(printedText()).toContain("--dry-run: no changes applied.");
  });

  it("accepts an explicit preset with --yes for scripted removal", async () => {
    await removeSandboxPolicy("test-sandbox", { preset: "pypi", yes: true });

    expect(promptMock).not.toHaveBeenCalled();
    expect(removePresetMock).toHaveBeenCalledWith("test-sandbox", "pypi");
  });

  it("honors non-interactive mode when an explicit preset is provided", async () => {
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";

    await removeSandboxPolicy("test-sandbox", { preset: "pypi" });

    expect(promptMock).not.toHaveBeenCalled();
    expect(removePresetMock).toHaveBeenCalledWith("test-sandbox", "pypi");
  });

  it("fails fast in non-interactive mode without an explicit preset", async () => {
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";

    await expect(captureExit(() => removeSandboxPolicy("test-sandbox"))).resolves.toBe(1);

    expect(printedText()).toContain("Non-interactive mode requires a preset name.");
    expect(removePresetMock).not.toHaveBeenCalled();
  });

  it("exits non-zero when the remove picker reaches stdin EOF (#7418)", async () => {
    selectForRemovalMock.mockRejectedValueOnce(
      Object.assign(new Error("Prompt closed before input"), { code: "EOF" }),
    );

    await expect(captureExit(() => removeSandboxPolicy("test-sandbox"))).resolves.toBe(1);

    expect(printedText()).toContain("No input available on stdin");
    expect(removePresetMock).not.toHaveBeenCalled();
  });

  it("removes a preset the gateway enforces but the registry never recorded (#9295)", async () => {
    getAppliedPresetsMock.mockReturnValue([]);
    getGatewayPresetsMock.mockReturnValue(["npm"]);

    await removeSandboxPolicy("test-sandbox", { preset: "npm", yes: true });

    expect(removePresetMock).toHaveBeenCalledWith("test-sandbox", "npm");
  });

  it("refuses a preset neither the registry nor the gateway holds (#9295)", async () => {
    getAppliedPresetsMock.mockReturnValue([]);
    getGatewayPresetsMock.mockReturnValue(["pypi"]);

    await expect(
      captureExit(() => removeSandboxPolicy("test-sandbox", { preset: "npm", yes: true })),
    ).resolves.toBe(1);

    expect(printedText()).toContain("Preset 'npm' is not applied.");
    expect(removePresetMock).not.toHaveBeenCalled();
  });

  it("names the unreachable gateway when it refuses on local state alone (#9295)", async () => {
    getAppliedPresetsMock.mockReturnValue([]);
    getGatewayPresetsMock.mockReturnValue(null);

    await expect(
      captureExit(() => removeSandboxPolicy("test-sandbox", { preset: "npm", yes: true })),
    ).resolves.toBe(1);

    expect(printedText()).toContain(
      "Could not query the gateway, so only local state was checked.",
    );
    expect(removePresetMock).not.toHaveBeenCalled();
  });

  it("offers a gateway-only preset in the removal picker (#9295)", async () => {
    getGatewayPresetsMock.mockReturnValue(["npm"]);

    await removeSandboxPolicy("test-sandbox");

    expect(selectForRemovalMock).toHaveBeenCalledWith(POLICY_PRESETS, {
      applied: ["pypi", "npm"],
    });
  });

  it("lists a preset both sources hold only once in the removal picker (#9295)", async () => {
    getGatewayPresetsMock.mockReturnValue(["pypi", "npm"]);

    await removeSandboxPolicy("test-sandbox");

    expect(selectForRemovalMock).toHaveBeenCalledWith(POLICY_PRESETS, {
      applied: ["pypi", "npm"],
    });
  });
});
