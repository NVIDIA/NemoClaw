// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { createBuildContextVerifier } from "../../src/lib/actions/sandbox/rebuild-prepared-image-context";
import { fingerprintBuildContext } from "../../src/lib/adapters/fs/build-context-fingerprint";
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

    it("recreates from the retained context after the source Dockerfile symlink changes", async () => {
      const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-source-link-"));
      const preparedDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-prepared-"));
      const sourceDockerfile = path.join(sourceDir, "Dockerfile");
      const preparedDockerfile = path.join(preparedDir, "Dockerfile");
      fs.writeFileSync(path.join(sourceDir, "Dockerfile.safe"), "FROM scratch\n# safe\n");
      fs.writeFileSync(path.join(sourceDir, "Dockerfile.changed"), "FROM scratch\n# changed\n");
      fs.symlinkSync("Dockerfile.safe", sourceDockerfile);
      fs.writeFileSync(preparedDockerfile, "FROM scratch\n# safe\n");
      const cleanupBuildCtx = vi.fn(() => {
        fs.rmSync(preparedDir, { recursive: true, force: true });
        return true;
      });
      const prepared = {
        buildCtx: preparedDir,
        stagedDockerfile: preparedDockerfile,
        cleanupBuildCtx,
        buildId: "source-link-prepared",
        contextFingerprint: fingerprintBuildContext(preparedDir),
        verifyBuildCtx: createBuildContextVerifier(
          preparedDir,
          fingerprintBuildContext(preparedDir),
        ),
        rebuildTarget: { agentName: null, fromDockerfile: sourceDockerfile },
      };
      const harness = createRebuildFlowHarness({
        sandboxEntry: { fromDockerfile: sourceDockerfile },
        customImagePreflight: {
          ok: true,
          imageTag: "nemoclaw-rebuild-preflight:source-link",
          prepared,
        },
        beforeBackup: () => {
          fs.unlinkSync(sourceDockerfile);
          fs.symlinkSync("Dockerfile.changed", sourceDockerfile);
        },
        onboard: (_session, options) => {
          expect(options.fromDockerfile).toBe(sourceDockerfile);
          expect(options.preparedImageRebuild?.buildContext).toBe(prepared);
          expect(fs.readFileSync(sourceDockerfile, "utf8")).toContain("# changed");
          expect(fs.readFileSync(preparedDockerfile, "utf8")).toContain("# safe");
        },
      });

      try {
        await expect(
          harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
        ).resolves.toBeUndefined();

        expect(harness.onboardSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            fromDockerfile: sourceDockerfile,
            preparedImageRebuild: expect.objectContaining({ buildContext: prepared }),
          }),
        );
        expect(cleanupBuildCtx).toHaveBeenCalledOnce();
      } finally {
        fs.rmSync(sourceDir, { recursive: true, force: true });
        fs.rmSync(preparedDir, { recursive: true, force: true });
      }
    });

    it("aborts before delete when the retained context changes after preflight", async () => {
      const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-source-"));
      const preparedDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-prepared-"));
      const sourceDockerfile = path.join(sourceDir, "Dockerfile");
      const preparedDockerfile = path.join(preparedDir, "Dockerfile");
      fs.writeFileSync(sourceDockerfile, "FROM scratch\n# source\n");
      fs.writeFileSync(preparedDockerfile, "FROM scratch\n# prepared\n");
      const cleanupBuildCtx = vi.fn(() => {
        fs.rmSync(preparedDir, { recursive: true, force: true });
        return true;
      });
      const prepared = {
        buildCtx: preparedDir,
        stagedDockerfile: preparedDockerfile,
        cleanupBuildCtx,
        buildId: "mutated-prepared",
        contextFingerprint: fingerprintBuildContext(preparedDir),
        verifyBuildCtx: createBuildContextVerifier(
          preparedDir,
          fingerprintBuildContext(preparedDir),
        ),
        rebuildTarget: { agentName: null, fromDockerfile: sourceDockerfile },
      };
      const harness = createRebuildFlowHarness({
        sandboxEntry: { fromDockerfile: sourceDockerfile },
        customImagePreflight: {
          ok: true,
          imageTag: "nemoclaw-rebuild-preflight:mutated",
          prepared,
        },
        beforeBackup: () => fs.writeFileSync(preparedDockerfile, "FROM scratch\n# changed\n"),
      });

      try {
        await expect(
          harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
        ).rejects.toThrow("Replacement sandbox image context changed before delete");

        expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
          ["sandbox", "delete", "alpha"],
          expect.anything(),
        );
        expect(harness.onboardSpy).not.toHaveBeenCalled();
        expect(cleanupBuildCtx).toHaveBeenCalledOnce();
      } finally {
        fs.rmSync(sourceDir, { recursive: true, force: true });
        fs.rmSync(preparedDir, { recursive: true, force: true });
      }
    });

    it.runIf(process.platform !== "win32")(
      "aborts before delete when retained file special bits change after preflight",
      async () => {
        const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-mode-source-"));
        const preparedDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "nemoclaw-rebuild-mode-prepared-"),
        );
        const sourceDockerfile = path.join(sourceDir, "Dockerfile");
        const preparedDockerfile = path.join(preparedDir, "Dockerfile");
        fs.writeFileSync(sourceDockerfile, "FROM scratch\n# source\n");
        fs.writeFileSync(preparedDockerfile, "FROM scratch\n# prepared\n", { mode: 0o755 });
        const cleanupBuildCtx = vi.fn(() => {
          fs.rmSync(preparedDir, { recursive: true, force: true });
          return true;
        });
        const contextFingerprint = fingerprintBuildContext(preparedDir);
        const prepared = {
          buildCtx: preparedDir,
          stagedDockerfile: preparedDockerfile,
          cleanupBuildCtx,
          buildId: "special-mode-mutated-prepared",
          contextFingerprint,
          verifyBuildCtx: createBuildContextVerifier(preparedDir, contextFingerprint),
          rebuildTarget: { agentName: null, fromDockerfile: sourceDockerfile },
        };
        const harness = createRebuildFlowHarness({
          sandboxEntry: { fromDockerfile: sourceDockerfile },
          customImagePreflight: {
            ok: true,
            imageTag: "nemoclaw-rebuild-preflight:special-mode-mutated",
            prepared,
          },
          beforeBackup: () => fs.chmodSync(preparedDockerfile, 0o4755),
        });

        try {
          await expect(
            harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
          ).rejects.toThrow("Replacement sandbox image context changed before delete");
          expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
            ["sandbox", "delete", "alpha"],
            expect.anything(),
          );
          expect(harness.onboardSpy).not.toHaveBeenCalled();
          expect(cleanupBuildCtx).toHaveBeenCalledOnce();
        } finally {
          fs.rmSync(sourceDir, { recursive: true, force: true });
          fs.rmSync(preparedDir, { recursive: true, force: true });
        }
      },
    );

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
