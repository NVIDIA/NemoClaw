// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as defs from "../../agent/defs";
import * as policies from "../../policy";
import * as registry from "../../state/registry";
import { addSandboxChannel } from "./policy-channel";

class ExitError extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const originalProcessEnv = { ...process.env };

let logSpy: MockInstance;
let errSpy: MockInstance;

async function captureExit(action: () => Promise<void>): Promise<number | undefined> {
  const outcome: unknown = await action().then(
    () => new Error("Expected process.exit to be called"),
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(ExitError);
  return (outcome as ExitError).code;
}

function printedText(spy: MockInstance): string {
  return spy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

beforeEach(() => {
  delete process.env.TELEGRAM_GROUP_POLICY;
  delete process.env.TELEGRAM_REQUIRE_MENTION;

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);

  vi.spyOn(defs, "loadAgent").mockReturnValue({ name: "openclaw" } as defs.AgentDefinition);
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: "alpha",
    agent: "openclaw",
  });
  vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue([]);
  vi.spyOn(registry, "getDisabledChannels").mockReturnValue([]);

  vi.spyOn(policies, "listPresets").mockReturnValue([
    { file: "telegram.yaml", name: "telegram", description: "Telegram access" },
  ]);
  vi.spyOn(policies, "listCustomPresets").mockResolvedValue([]);
  vi.spyOn(policies, "getAppliedPresets").mockResolvedValue([]);
  vi.spyOn(policies, "getGatewayPresets").mockResolvedValue(null);
  vi.spyOn(policies, "loadPresetForSandbox").mockImplementation(
    async (_sandboxName, presetName) =>
      `network_policies:\n  ${presetName}:\n    name: ${presetName}\n    endpoints:\n      - host: example.com\n        port: 443\n`,
  );
  vi.spyOn(policies, "parsePresetPolicyKeys").mockReturnValue(["telegram"]);
  vi.spyOn(policies, "getPresetContentGatewayState").mockResolvedValue("absent");
  vi.spyOn(policies, "getPresetValidationWarning").mockReturnValue(null);
  vi.spyOn(policies, "getPresetEndpoints").mockReturnValue(["example.com"]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalProcessEnv);
});

describe("addSandboxChannel messaging config env validation (#12409)", () => {
  it("refuses a mistyped TELEGRAM_GROUP_POLICY instead of defaulting to open", async () => {
    vi.stubEnv("TELEGRAM_GROUP_POLICY", "lockdown");

    const code = await captureExit(() =>
      addSandboxChannel("alpha", { channel: "telegram", dryRun: true }),
    );

    expect(code).toBe(1);
    expect(printedText(errSpy)).toContain(
      "Invalid TELEGRAM_GROUP_POLICY value 'lockdown' (expected one of: open, allowlist, disabled)",
    );
  });

  it("refuses an out-of-range TELEGRAM_REQUIRE_MENTION instead of defaulting", async () => {
    vi.stubEnv("TELEGRAM_REQUIRE_MENTION", "yes");

    const code = await captureExit(() =>
      addSandboxChannel("alpha", { channel: "telegram", dryRun: true }),
    );

    expect(code).toBe(1);
    expect(printedText(errSpy)).toContain(
      "Invalid TELEGRAM_REQUIRE_MENTION value 'yes' (expected one of: 0, 1)",
    );
  });

  it("accepts a valid TELEGRAM_GROUP_POLICY and reaches the dry-run preview", async () => {
    vi.stubEnv("TELEGRAM_GROUP_POLICY", "disabled");

    await addSandboxChannel("alpha", { channel: "telegram", dryRun: true });

    expect(printedText(errSpy)).not.toContain("Invalid TELEGRAM_GROUP_POLICY");
    expect(printedText(logSpy)).toContain("--dry-run: would enable channel 'telegram'");
  });
});
