// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { SetupInference, SetupInferenceDeps } from "../src/lib/onboard/setup-inference.js";
import {
  createDirectCommandRouter,
  createDirectSetupInferenceHarnessFactory,
  withProcessEnv,
} from "./support/setup-inference-test-harness.js";

const onboard = require("../src/lib/onboard") as {
  createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
};

const createHarness = createDirectSetupInferenceHarnessFactory(onboard.createSetupInference);
const GATEWAY = "nemoclaw-9090";

function expectCommandsTargetOnly(commands: Array<{ command: string }>): void {
  expect(commands.some(({ command }) => command.startsWith("gateway select"))).toBe(false);
  const gatewayStateCommands = commands.filter(
    ({ command }) => /^(provider|inference) /.test(command) || /^sandbox provider /.test(command),
  );
  for (const { command } of gatewayStateCommands) {
    expect(command.match(/(?:^| )-g nemoclaw-9090(?: |$)/g)).toHaveLength(1);
  }
}

describe("onboarding inference gateway scope", () => {
  it("targets a non-default gateway for provider creation, route apply, and verification", async () => {
    await withProcessEnv({ OPENAI_API_KEY: "sk-TEST-NOT-A-REAL-VALUE" }, async () => {
      const harness = createHarness({
        runOpenshell: (args) =>
          args.slice(0, 2).join(" ") === "provider get" ? { status: 1 } : undefined,
      });

      await expect(
        harness.setupInference(
          "test-box",
          "gpt-test",
          "openai-api",
          "https://api.openai.com/v1",
          "OPENAI_API_KEY",
          null,
          [],
          { gatewayName: GATEWAY },
        ),
      ).resolves.toEqual({ ok: true });

      expect(harness.commands.map(({ command }) => command)).toEqual([
        `provider get -g ${GATEWAY} openai-api`,
        `provider create -g ${GATEWAY} --name openai-api --type openai --credential OPENAI_API_KEY --config OPENAI_BASE_URL=https://api.openai.com/v1`,
        `inference set -g ${GATEWAY} --no-verify --provider openai-api --model gpt-test`,
      ]);
      expect(harness.verifyInferenceRoute).toHaveBeenCalledWith(GATEWAY, "openai-api", "gpt-test");
      expectCommandsTargetOnly(harness.commands);
    });
  });

  it("keeps compatible-endpoint replacement and detach recovery on the target gateway", async () => {
    await withProcessEnv(
      { COMPATIBLE_ANTHROPIC_API_KEY: "sk-ant-TEST-NOT-A-REAL-VALUE" },
      async () => {
        const commandRouter = createDirectCommandRouter([
          {
            name: "provider-get",
            matches: (command) => command.startsWith(`provider get -g ${GATEWAY}`),
            results: [
              {
                status: 0,
                stdout: [
                  "Name: compatible-anthropic-endpoint",
                  "Type: anthropic",
                  "Credential keys: COMPATIBLE_ANTHROPIC_API_KEY",
                  "Config keys: ANTHROPIC_BASE_URL",
                ].join("\n"),
              },
              { status: 1 },
            ],
          },
          {
            name: "provider-delete",
            matches: (command) => command.startsWith(`provider delete -g ${GATEWAY}`),
            results: [
              {
                status: 1,
                stderr:
                  "provider 'compatible-anthropic-endpoint' is attached to sandbox(es): test-box",
              },
              {
                status: 1,
                stderr:
                  "provider 'compatible-anthropic-endpoint' is attached to sandbox(es): test-box",
              },
              { status: 0 },
            ],
          },
        ]);
        const harness = createHarness({
          runOpenshell: commandRouter.runOpenshell,
          overrides: {
            probeOpenAiLikeEndpoint: vi.fn(() => ({ ok: true })),
          },
        });

        await expect(
          harness.setupInference(
            "test-box",
            "claude-test",
            "compatible-anthropic-endpoint",
            "https://example.test",
            "COMPATIBLE_ANTHROPIC_API_KEY",
            null,
            [],
            { gatewayName: GATEWAY, preferredInferenceApi: "openai-completions" },
          ),
        ).resolves.toEqual({ ok: true });

        expect(commandRouter.callCount("provider-delete")).toBe(3);
        expect(harness.commands.map(({ command }) => command)).toContain(
          `sandbox provider detach -g ${GATEWAY} test-box compatible-anthropic-endpoint`,
        );
        expectCommandsTargetOnly(harness.commands);
      },
    );
  });
});
