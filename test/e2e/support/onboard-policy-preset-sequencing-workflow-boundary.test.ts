// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  catalogueTarget,
  validateE2eTargetCatalogue,
} from "../../../tools/e2e/target-catalogue.mts";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";
import { assertCleanupPassed, CleanupRegistry } from "../fixtures/cleanup.ts";

// The interactive-command unit cases stop before registry verification.
vi.mock("../../../src/lib/inference/native-provider/recorded-selection.ts", () => ({
  recordedNativeProviderAttachment: vi.fn(),
}));

vi.mock("../../../tools/e2e/credential-free-tests.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../tools/e2e/credential-free-tests.mts")>()),
  // This catalog-only selector never selects shared credential-free tests.
  discoverCredentialFreeTests: () => [],
}));

// #6042: onboard-policy-preset-sequencing.test.ts drives the real
// interactive onboard wizard through a PTY; forcing non-interactive mode
// (as cloud-onboard and double-onboard both do) would defeat the whole
// regression. Prove the catalogue selects the right test file today, and
// that reintroducing NEMOCLAW_NON_INTERACTIVE on this target is caught.
describe("onboard-policy-preset-sequencing workflow boundary", () => {
  it("selects onboard-policy-preset-sequencing.test.ts with interactive mode enabled", () => {
    const target = catalogueTarget("onboard-policy-preset-sequencing");
    const plan = buildE2eWorkflowPlan({ jobs: target.id });

    expect(target.testFile).toBe("test/e2e/live/onboard-policy-preset-sequencing.test.ts");
    expect(target.installNonInteractive).toBe(false);
    expect(target.environment.NEMOCLAW_NON_INTERACTIVE).toBeUndefined();
    expect(plan.catalogueMatrices.standard).toEqual([
      expect.objectContaining({
        id: target.id,
        install_non_interactive: false,
        test_file: target.testFile,
      }),
    ]);
  });

  it("rejects onboard-policy-preset-sequencing forced back into non-interactive mode", () => {
    const target = catalogueTarget("onboard-policy-preset-sequencing");

    expect(() =>
      validateE2eTargetCatalogue([
        {
          ...target,
          installNonInteractive: true,
          environment: { ...target.environment, NEMOCLAW_NON_INTERACTIVE: "1" },
        },
      ]),
    ).toThrow(
      "E2E target onboard-policy-preset-sequencing requires interactive installation and execution",
    );
  });
});

it.each(["docker", "podman"])(
  "uses a public endpoint for interactive %s onboarding without trusting private hosts (#6042)",
  async (runtime) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const captured = vi.fn();
    const stop = new Error("interactive command captured");
    const drive = vi.fn(
      async (
        _options: import("../live/onboard-interactive-pty.ts").DriveInteractiveCommandOptions,
      ) => {
        throw stop;
      },
    );
    const cleanup = new CleanupRegistry();
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "linux" });
      vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", runtime);
      vi.stubEnv("OPENSHELL_PODMAN_SOCKET", "/run/user/1001/podman/podman.sock");
      vi.resetModules();
      vi.doMock("../fixtures/e2e-test.ts", () => ({ expect, test: captured }));
      vi.doMock("../live/onboard-interactive-pty.ts", () => ({ driveInteractiveCommand: drive }));
      vi.doMock("../live/cloudflared-prerequisite.ts", () => ({
        resolveVerifiedCloudflaredBinary: async () => "/verified/cloudflared",
      }));
      vi.doMock("../live/mcp-bridge-servers.ts", () => ({
        startPublicMcpHttpsTunnel: async (options: { server: { port: number } }) => {
          const response = await fetch(`http://127.0.0.1:${options.server.port}/v1/models`, {
            method: "HEAD",
          });
          expect(response.status).toBe(200);
          return { origin: "https://personal.trycloudflare.com" };
        },
      }));
      await import("../live/onboard-policy-preset-sequencing.test.ts");
      const { startTestProgress } = await import("../fixtures/progress.ts");
      const progress = startTestProgress(
        "hosted policy fixture",
        captured.mock.calls[0]![1].meta.e2ePhases,
        { logLine: () => undefined },
      );
      cleanup.trackDisposable("stop fixture progress", () => progress.stop());
      const run = captured.mock.calls[0]![2] as (input: object) => Promise<void>;
      const command = vi.fn(async () => ({ exitCode: 0, stdout: "route 10.20.30.40", stderr: "" }));
      await expect(
        run({
          artifacts: { addRedactionValues: vi.fn() },
          cleanup: {
            trackDisposable: cleanup.trackDisposable.bind(cleanup),
            trackSandbox: vi.fn(),
          },
          host: { command },
          progress,
          runtimeProvider: { requireAvailable: vi.fn() },
        }),
      ).rejects.toBe(stop);
      const options = drive.mock.calls[0]![0];
      expect(options.env.NEMOCLAW_TRUSTED_PRIVATE_HOSTS).toBeUndefined();
      const endpoint = String(
        options.rules.find((rule) => rule.trigger === "OpenAI-compatible base URL")!.response,
      ).trim();
      expect(endpoint).toBe("https://personal.trycloudflare.com/v1");
      expect(command).not.toHaveBeenCalled();
    } finally {
      const result = await cleanup.runAll();
      vi.doUnmock("../fixtures/e2e-test.ts");
      vi.doUnmock("../live/onboard-interactive-pty.ts");
      vi.doUnmock("../live/cloudflared-prerequisite.ts");
      vi.doUnmock("../live/mcp-bridge-servers.ts");
      vi.unstubAllEnvs();
      Object.defineProperty(process, "platform", platform);
      assertCleanupPassed(result);
    }
  },
);
