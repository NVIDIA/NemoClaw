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
    ["1", true, "mention-only (1)"],
    ["0", false, "all-messages (0)"],
  ] as const)("reports effective Telegram group replies for configured mention value %s (#5691)", async (configuredValue, renderedValue, expectedDetail) => {
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
        status: "ok",
        detail: expectedDetail,
      }),
    );
    expect(JSON.stringify(report)).not.toMatch(/bot[_-]?token/i);
  });
});
