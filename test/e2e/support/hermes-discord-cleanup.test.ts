// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HostCliClient, SandboxClient } from "../fixtures/clients/index.ts";
import { precleanHermesDiscordResources } from "../live/hermes-discord-cleanup.ts";

describe("Hermes Discord preclean", () => {
  it.each([
    ["NemoClaw sandbox", "nemoclaw", ["nemoclaw"]],
    ["OpenShell sandbox", "openshell-sandbox", ["nemoclaw", "openshell-sandbox"]],
    [
      "OpenShell gateway",
      "openshell-gateway",
      ["nemoclaw", "openshell-sandbox", "openshell-gateway"],
    ],
  ])(
    "stops before installation when %s cleanup is denied",
    async (_label, deniedStage, expectedCalls) => {
      const calls: string[] = [];
      const allowed = async (): Promise<void> => undefined;
      const outcomes = new Map<string, () => Promise<void>>([
        [
          deniedStage,
          async () => Promise.reject(new Error(`permission denied during ${deniedStage} cleanup`)),
        ],
      ]);
      const cleanup = async (stage: string): Promise<void> => {
        calls.push(stage);
        await (outcomes.get(stage) ?? allowed)();
      };
      const host = {
        cleanupSandbox: async () => cleanup("nemoclaw"),
        cleanupGatewayRegistration: async () => cleanup("openshell-gateway"),
      } as unknown as Pick<HostCliClient, "cleanupGatewayRegistration" | "cleanupSandbox">;
      const sandbox = {
        cleanupSandbox: async () => cleanup("openshell-sandbox"),
      } as unknown as Pick<SandboxClient, "cleanupSandbox">;
      let installAttempted = false;

      await expect(
        (async () => {
          await precleanHermesDiscordResources(host, sandbox, {
            sandboxName: "e2e-hermes-discord",
            env: {},
            redactionValues: [],
            prefix: "preclean-hermes-discord",
          });
          installAttempted = true;
        })(),
      ).rejects.toThrow(`permission denied during ${deniedStage} cleanup`);

      expect(calls).toEqual(expectedCalls);
      expect(installAttempted).toBe(false);
    },
  );
});
