// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import {
  createDoctorHarness,
  resetDoctorHarness,
  telegramMessaging,
} from "./doctor-flow.test-helpers";

describe("Telegram mention diagnostics in doctor", () => {
  afterEach(() => {
    resetDoctorHarness();
  });

  it.each([
    ["configured mention-only", "1", true, "ok", "mention-only (1)"],
    ["configured all-messages", "0", false, "ok", "all-messages (0)"],
    ["default mention-only", undefined, true, "ok", "mention-only (1, default)"],
    ["rendered drift", "0", true, "warn", "expected all-messages (0); rendered mention-only (1)"],
  ] as const)("reports %s Telegram group replies (#5691)", async (_caseName, configuredValue, renderedValue, expectedStatus, expectedDetail) => {
    const harness = createDoctorHarness();
    harness.configuredMessagingChannelsSpy.mockReturnValue(["telegram"]);
    harness.getSandboxSpy.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      model: "registry-model",
      provider: "ollama-local",
      openshellDriver: "docker",
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
      messaging: telegramMessaging(configuredValue),
    });
    harness.executeSandboxCommandForVerificationSpy.mockImplementation((_sandboxName, command) =>
      command.startsWith("head -c ")
        ? {
            status: 0,
            stdout: JSON.stringify({
              channels: {
                telegram: {
                  accounts: { default: { groupPolicy: "open" } },
                  groups: { "*": { requireMention: renderedValue } },
                },
              },
            }),
            stderr: "",
          }
        : { status: 0, stdout: "ok", stderr: "" },
    );

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(report?.checks).toContainEqual(
      expect.objectContaining({
        group: "Messaging",
        label: "Telegram group mention mode (TELEGRAM_REQUIRE_MENTION)",
        status: expectedStatus,
        detail: expectedDetail,
      }),
    );
    expect(JSON.stringify(report)).not.toMatch(/bot[_-]?token/i);
  });

  it("labels an unreadable Telegram config source without matching display text (#5691)", async () => {
    const harness = createDoctorHarness();
    harness.configuredMessagingChannelsSpy.mockReturnValue(["telegram"]);
    harness.getSandboxSpy.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      model: "registry-model",
      provider: "ollama-local",
      openshellDriver: "docker",
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
      messaging: telegramMessaging("1"),
    });
    harness.executeSandboxCommandForVerificationSpy.mockImplementation((_sandboxName, command) =>
      command.startsWith("head -c ")
        ? { status: 1, stdout: "", stderr: "missing" }
        : { status: 0, stdout: "ok", stderr: "" },
    );

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(report?.checks).toContainEqual(
      expect.objectContaining({
        group: "Messaging",
        label: "Telegram rendered config",
        status: "warn",
      }),
    );
  });
});
