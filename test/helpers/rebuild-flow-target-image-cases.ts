// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  originalSandboxName,
  snapshotEnv,
} from "./rebuild-flow-test-harness";

export function registerRebuildFlowTargetImageTests(): void {
  describe("rebuildSandbox flow: target image", () => {
    installRebuildFlowTestHooks();
    it("aborts before backup/delete when the durable custom Dockerfile is unreadable", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-from-"));
      const dockerfile = path.join(tempDir, "Dockerfile.unreadable");
      fs.writeFileSync(dockerfile, "FROM scratch\n", { mode: 0o000 });
      const harness = createRebuildFlowHarness({ sandboxEntry: { fromDockerfile: dockerfile } });
      try {
        await expect(
          harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
        ).rejects.toThrow("Recorded custom Dockerfile is unavailable");
        expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
        expect(harness.onboardSpy).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("fails closed on a corrupt durable custom Dockerfile value", async () => {
      const harness = createRebuildFlowHarness({ sandboxEntry: { fromDockerfile: 42 } });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Recorded custom Dockerfile is invalid");

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    });

    it("rebuilds a known-remote target even when the session belongs to another sandbox (#5735)", async () => {
      const restoreEnv = snapshotEnv(["NVIDIA_INFERENCE_API_KEY"]);
      process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-key"; // pass credential preflight
      try {
        const harness = createRebuildFlowHarness({
          applyPreset: () => true,
          sandboxEntry: { provider: "nvidia-prod", model: "nvidia/nemotron" },
          sessionSandboxName: "some-other-sandbox",
        });
        const staleEndpoint = "https://stale.example.test/v1";
        harness.session.endpointUrl = staleEndpoint;
        harness.session.metadata = {
          gatewayName: "nemoclaw",
          fromDockerfile: "/tmp/unrelated.Dockerfile",
        };
        harness.session.webSearchConfig = { fetchEnabled: true };
        harness.session.policyPresets = ["foreign-preset"];
        harness.session.gpuPassthrough = true;

        await expect(
          harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
        ).resolves.toBeUndefined();

        expect(harness.onboardSpy).toHaveBeenCalled();
        const providerPreflightCall = harness.runOpenshellSpy.mock.calls.findIndex(
          ([args]) => Array.isArray(args) && args[0] === "provider",
        );
        expect(providerPreflightCall).toBeGreaterThanOrEqual(0);
        expect(harness.ensureTargetGatewaySpy.mock.invocationCallOrder[0]).toBeLessThan(
          harness.runOpenshellSpy.mock.invocationCallOrder[providerPreflightCall],
        );
        expect(harness.session.endpointUrl).not.toBe(staleEndpoint);
        expect(harness.session.metadata).toMatchObject({ fromDockerfile: null });
        expect(harness.session.webSearchConfig).toBeNull();
        expect(harness.session.policyPresets).toEqual(["npm", "bad", "throw"]);
        expect(harness.session.gpuPassthrough).toBe(false);
        expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
          ["sandbox", "delete", "alpha"],
          expect.objectContaining({ ignoreError: true }),
        );
      } finally {
        restoreEnv();
      }
    });

    it("does not abort a routed (nvidia-router) target with a non-matching session (#5735)", async () => {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        sandboxEntry: { provider: "nvidia-router", model: "router-model" },
        sessionSandboxName: "some-other-sandbox",
      });
      harness.session.routerPid = 4242;
      harness.session.routerCredentialHash = "router-credential-hash";

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(harness.onboardSpy).toHaveBeenCalled();
      expect(harness.session.routerPid).toBe(4242);
      expect(harness.session.routerCredentialHash).toBe("router-credential-hash");
    });

    it("marks recreate onboarding failures as terminal and preserves retry cleanup", async () => {
      const overrideEnvVar = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";
      const restoreEnv = snapshotEnv([overrideEnvVar]);
      process.env[overrideEnvVar] = "nemoclaw-hermes-sandbox-base-local:image-caller";
      try {
        const harness = createRebuildFlowHarness({
          baseImagePreflight: {
            ok: true,
            imageRef: "nemoclaw-hermes-sandbox-base-local:image-preflighted",
            overrideEnvVar,
          },
          onboard: (session) => {
            expect(process.env[overrideEnvVar]).toBe(
              "nemoclaw-hermes-sandbox-base-local:image-preflighted",
            );
            session.lastStepStarted = "sandbox";
            throw new Error("inner recreate boom");
          },
        });

        await expect(
          harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
        ).rejects.toThrow("Recreate failed");

        expect(process.env[overrideEnvVar]).toBe("nemoclaw-hermes-sandbox-base-local:image-caller");
        expect(harness.releaseOnboardLockSpy).toHaveBeenCalled();
        expect(harness.markStepFailedSpy).toHaveBeenCalledWith(
          "sandbox",
          "Rebuild recreate failed",
          expect.objectContaining({ updateMachine: true }),
        );
        expect(harness.session).toMatchObject({
          status: "failed",
          failure: { step: "sandbox", message: "Rebuild recreate failed" },
          machine: { state: "failed" },
          steps: { sandbox: { status: "failed", error: "Rebuild recreate failed" } },
        });
        expect(harness.relockSpy).toHaveBeenCalledWith(
          "alpha",
          expect.any(Object),
          false,
          "nemoclaw",
        );
        expect(process.env.NEMOCLAW_SANDBOX_NAME).toBe(originalSandboxName);

        const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
        expect(errors).toContain("Recreate failed after sandbox was destroyed");
        expect(errors).toContain("Backup is preserved at: /tmp/nemoclaw-rebuild-backup");
        expect(errors).toContain("onboard --resume");
      } finally {
        restoreEnv();
      }
    });
  });
}
