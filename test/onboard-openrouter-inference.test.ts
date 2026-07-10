// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import type { SetupInference, SetupInferenceDeps } from "../src/lib/onboard/setup-inference.js";
import {
  createDirectSetupInferenceHarnessFactory,
  withProcessEnv,
} from "./support/setup-inference-test-harness.js";

const onboard = require("../src/lib/onboard") as {
  createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
};
const openrouterRuntimeOnboard =
  require("../src/lib/onboard/openrouter-runtime") as typeof import("../src/lib/onboard/openrouter-runtime.js");

const createDirectSetupInferenceHarness = createDirectSetupInferenceHarnessFactory(
  onboard.createSetupInference,
);

describe("OpenRouter onboarding inference setup", () => {
  it("configures OpenRouter through the runtime header adapter (#5826)", async () => {
    await withProcessEnv({ OPENROUTER_API_KEY: "sk-or-test" }, async () => {
      const ensureAdapter = vi.fn(async () => ({
        baseUrl: "http://host.openshell.internal:11437/v1",
        localBaseUrl: "http://127.0.0.1:11437/v1",
        credentialEnv: "OPENROUTER_API_KEY",
        logPath: "/tmp/openrouter-runtime-adapter.log",
        started: true,
        startedPid: 12345,
      }));
      const setupOpenRouterRuntimeInference =
        openrouterRuntimeOnboard.setupOpenRouterRuntimeInference;
      const harness = createDirectSetupInferenceHarness({
        overrides: {
          isNonInteractive: () => true,
          openrouterRuntimeOnboard: {
            setupOpenRouterRuntimeInference: (
              input: Parameters<typeof setupOpenRouterRuntimeInference>[0],
            ) => setupOpenRouterRuntimeInference({ ...input, ensureAdapter }),
          },
        },
      });

      await harness.setupInference(
        "test-box",
        "moonshotai/kimi-k2.6",
        "openrouter-api",
        "https://openrouter.ai/api/v1",
        "OPENROUTER_API_KEY",
      );

      expect(ensureAdapter).toHaveBeenCalledWith({ authorizationToken: "sk-or-test" });
      const commands = harness.commands.map(({ command }) => command);
      assert.deepEqual(commands, [
        "provider get -g nemoclaw openrouter-api",
        "provider update -g nemoclaw openrouter-api --credential OPENROUTER_API_KEY --config OPENAI_BASE_URL=http://host.openshell.internal:11437/v1",
        "inference set -g nemoclaw --no-verify --provider openrouter-api --model moonshotai/kimi-k2.6 --timeout 180",
      ]);
      assert.equal(harness.commands[1].env?.OPENROUTER_API_KEY, "sk-or-test");
      assert.ok(
        !commands.some((command) => command.includes("sk-or-test")),
        "OpenRouter key must not appear in argv",
      );
      expect(harness.verifyInferenceRoute).toHaveBeenCalledWith(
        "nemoclaw",
        "openrouter-api",
        "moonshotai/kimi-k2.6",
      );
      expect(harness.verifyOnboardInferenceSmoke).toHaveBeenCalledWith({
        provider: "openrouter-api",
        model: "moonshotai/kimi-k2.6",
        endpointUrl: "http://127.0.0.1:11437/v1",
        credentialEnv: "OPENROUTER_API_KEY",
        forceOpenAiLike: true,
      });
      assert.deepEqual(harness.errors, []);
      assert.deepEqual(harness.logs, [
        "  OpenRouter Runtime adapter ready: sandbox route http://host.openshell.internal:11437/v1, host log /tmp/openrouter-runtime-adapter.log",
        "  ✓ Inference route set: openrouter-api / moonshotai/kimi-k2.6",
      ]);
    });
  });

  it("updates OpenRouter adapter config while reusing a gateway-held credential (#5826)", async () => {
    await withProcessEnv({ OPENROUTER_API_KEY: undefined }, async () => {
      const ensureAdapter = vi.fn(async () => ({
        baseUrl: "http://host.openshell.internal:11437/v1",
        localBaseUrl: "http://127.0.0.1:11437/v1",
        credentialEnv: "OPENROUTER_API_KEY",
        logPath: "/tmp/openrouter-runtime-adapter.log",
        started: false,
        startedPid: null,
      }));
      const setupOpenRouterRuntimeInference =
        openrouterRuntimeOnboard.setupOpenRouterRuntimeInference;
      const harness = createDirectSetupInferenceHarness({
        overrides: {
          isNonInteractive: () => true,
          openrouterRuntimeOnboard: {
            setupOpenRouterRuntimeInference: (
              input: Parameters<typeof setupOpenRouterRuntimeInference>[0],
            ) => setupOpenRouterRuntimeInference({ ...input, ensureAdapter }),
          },
        },
      });

      await harness.setupInference(
        "test-box",
        "moonshotai/kimi-k2.6",
        "openrouter-api",
        "https://openrouter.ai/api/v1",
        "OPENROUTER_API_KEY",
        null,
        [],
        {
          reuseGatewayCredentialWithoutLocalKey: true,
          skipHostInferenceSmoke: true,
        },
      );

      expect(ensureAdapter).toHaveBeenCalledWith({ authorizationToken: null });
      expect(harness.commands.map(({ command }) => command)).toEqual([
        "provider get -g nemoclaw openrouter-api",
        "provider update -g nemoclaw openrouter-api --config OPENAI_BASE_URL=http://host.openshell.internal:11437/v1",
        "inference set -g nemoclaw --no-verify --provider openrouter-api --model moonshotai/kimi-k2.6 --timeout 180",
      ]);
      expect(harness.commands[1].env?.OPENROUTER_API_KEY).toBeUndefined();
      expect(harness.verifyOnboardInferenceSmoke).not.toHaveBeenCalled();
      expect(harness.logs).toEqual([
        "  OpenRouter Runtime adapter ready: sandbox route http://host.openshell.internal:11437/v1, host log /tmp/openrouter-runtime-adapter.log",
        "  Reusing existing gateway credential; skipping host inference smoke.",
        "  ✓ Inference route set: openrouter-api / moonshotai/kimi-k2.6",
      ]);
      expect(harness.errors).toEqual([]);
    });
  });

  it("stops a newly-started OpenRouter adapter when provider registration fails (#5826)", async () => {
    await withProcessEnv({ OPENROUTER_API_KEY: "sk-or-test" }, async () => {
      const adapter = {
        baseUrl: "http://host.openshell.internal:11437/v1",
        localBaseUrl: "http://127.0.0.1:11437/v1",
        credentialEnv: "OPENROUTER_API_KEY",
        logPath: "/tmp/openrouter-runtime-adapter.log",
        started: true,
        startedPid: 12345,
      };
      const ensureAdapter = vi.fn(async () => adapter);
      const cleanupAdapter = vi.fn();
      const setupOpenRouterRuntimeInference =
        openrouterRuntimeOnboard.setupOpenRouterRuntimeInference;
      const harness = createDirectSetupInferenceHarness({
        runOpenshell: (args) => {
          if (args.join(" ").startsWith("provider update ")) {
            return { status: 44, stderr: "provider update failed" };
          }
          return undefined;
        },
        overrides: {
          openrouterRuntimeOnboard: {
            setupOpenRouterRuntimeInference: (
              input: Parameters<typeof setupOpenRouterRuntimeInference>[0],
            ) => setupOpenRouterRuntimeInference({ ...input, ensureAdapter, cleanupAdapter }),
          },
        },
      });

      const result = await harness.setupInference(
        "test-box",
        "moonshotai/kimi-k2.6",
        "openrouter-api",
        "https://openrouter.ai/api/v1",
        "OPENROUTER_API_KEY",
      );

      expect(result).toEqual({ retry: "selection" });
      expect(cleanupAdapter).toHaveBeenCalledWith(adapter);
      expect(harness.errors.join("\n")).toContain("provider update failed");
    });
  });

  it("does not stop a reused OpenRouter adapter when inference registration fails (#5826)", async () => {
    await withProcessEnv({ OPENROUTER_API_KEY: "sk-or-test" }, async () => {
      const adapter = {
        baseUrl: "http://host.openshell.internal:11437/v1",
        localBaseUrl: "http://127.0.0.1:11437/v1",
        credentialEnv: "OPENROUTER_API_KEY",
        logPath: "/tmp/openrouter-runtime-adapter.log",
        started: false,
        startedPid: null,
      };
      const ensureAdapter = vi.fn(async () => adapter);
      const cleanupAdapter = vi.fn();
      const setupOpenRouterRuntimeInference =
        openrouterRuntimeOnboard.setupOpenRouterRuntimeInference;
      const harness = createDirectSetupInferenceHarness({
        runOpenshell: (args) => {
          if (args.join(" ").startsWith("inference set ")) {
            return { status: 45, stderr: "inference set failed" };
          }
          return undefined;
        },
        overrides: {
          openrouterRuntimeOnboard: {
            setupOpenRouterRuntimeInference: (
              input: Parameters<typeof setupOpenRouterRuntimeInference>[0],
            ) => setupOpenRouterRuntimeInference({ ...input, ensureAdapter, cleanupAdapter }),
          },
        },
      });

      const result = await harness.setupInference(
        "test-box",
        "moonshotai/kimi-k2.6",
        "openrouter-api",
        "https://openrouter.ai/api/v1",
        "OPENROUTER_API_KEY",
      );

      expect(result).toEqual({ retry: "selection" });
      expect(cleanupAdapter).not.toHaveBeenCalled();
      expect(harness.errors.join("\n")).toContain("inference set failed");
    });
  });
});
