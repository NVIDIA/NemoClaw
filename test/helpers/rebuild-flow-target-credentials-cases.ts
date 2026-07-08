// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  snapshotEnv,
} from "./rebuild-flow-test-harness";

export function registerRebuildFlowTargetCredentialsTests(): void {
  describe("rebuildSandbox flow: target credentials", () => {
    installRebuildFlowTestHooks();
    it("aborts before backup/delete when durable Brave credential validation fails", async () => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: { webSearchEnabled: true },
        sessionSandboxName: "some-other-sandbox",
        ensureValidatedBraveSearchCredential: async () => {
          throw new Error("invalid Brave credential");
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Brave Search credential preflight failed");

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
    });

    it("rejects recorded web search when the target agent does not support it", async () => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: { agent: "hermes", webSearchEnabled: true },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Recorded Brave Search is unsupported");

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    });

    it("rejects a Tavily credential already owned by MCP before rebuild mutation", async () => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: {
          webSearchEnabled: true,
          webSearchProvider: "tavily",
          mcp: {
            bridges: {
              search: {
                server: "search",
                agent: "openclaw",
                url: "https://mcp.example.com/mcp",
                env: ["TAVILY_API_KEY"],
                policyName: "alpha-mcp-search",
                addedAt: "2026-07-03T00:00:00.000Z",
              },
            },
          },
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Web Search and MCP credential ownership conflict");

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.prepareMcpBridgesForRebuildSpy).not.toHaveBeenCalled();
      expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
    });

    it("preserves legacy Brave web search during a nonmatching-session rebuild", async () => {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        sandboxEntry: { policies: ["brave"], webSearchEnabled: undefined },
        sessionSandboxName: "some-other-sandbox",
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.ensureValidatedBraveSearchCredentialSpy).toHaveBeenCalledWith(
        { fetchEnabled: true, provider: "brave" },
        true,
      );
      expect(harness.session.webSearchConfig).toEqual({ fetchEnabled: true, provider: "brave" });
    });

    it("reconciles stale Brave policy state to the durable Tavily provider", async () => {
      const harness = createRebuildFlowHarness({
        applyPreset: (name) => name === "tavily",
        backupPolicyPresets: ["brave"],
        sandboxEntry: {
          policies: ["brave"],
          webSearchEnabled: true,
          webSearchProvider: "tavily",
        },
        sessionSandboxName: "some-other-sandbox",
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "tavily");
      expect(harness.applyPresetSpy).not.toHaveBeenCalledWith("alpha", "brave");
      expect(harness.session.webSearchConfig).toEqual({
        fetchEnabled: true,
        provider: "tavily",
      });
    });

    it("restores the caller Tavily credential environment after rebuild", async () => {
      const restoreEnv = snapshotEnv(["TAVILY_API_KEY"]);
      process.env.TAVILY_API_KEY = "caller-tavily-key";
      try {
        const harness = createRebuildFlowHarness({
          applyPreset: () => true,
          sandboxEntry: { webSearchEnabled: true, webSearchProvider: "tavily" },
          ensureValidatedWebSearchCredential: async () => {
            process.env.TAVILY_API_KEY = "validated-tavily-key";
            return "validated-tavily-key";
          },
        });

        await expect(
          harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
        ).resolves.toBeUndefined();
        expect(process.env.TAVILY_API_KEY).toBe("caller-tavily-key");
      } finally {
        restoreEnv();
      }
    });

    it("recreates unrelated-session targets from durable web, image, and Hermes auth state", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-from-"));
      const dockerfile = path.join(tempDir, "Dockerfile.custom");
      fs.writeFileSync(dockerfile, "FROM scratch\nARG NEMOCLAW_WEB_SEARCH_ENABLED=0\n");
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        sessionSandboxName: "some-other-sandbox",
        sandboxEntry: {
          provider: "hermes-provider",
          model: "hermes-model",
          webSearchEnabled: true,
          fromDockerfile: dockerfile,
          hermesAuthMethod: "api_key",
        },
        hermesCredentialKeys: ["NOUS_API_KEY"],
      });
      harness.session.webSearchConfig = null;
      harness.session.hermesAuthMethod = "oauth";
      harness.session.metadata = { fromDockerfile: "/tmp/unrelated.Dockerfile" };

      try {
        await expect(
          harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
        ).resolves.toBeUndefined();

        expect(harness.ensureValidatedBraveSearchCredentialSpy).toHaveBeenCalledWith(
          { fetchEnabled: true, provider: "brave" },
          true,
        );
        expect(harness.session.webSearchConfig).toEqual({
          fetchEnabled: true,
          provider: "brave",
        });
        expect(harness.session.hermesAuthMethod).toBe("api_key");
        expect(harness.session.credentialEnv).toBe("NOUS_API_KEY");
        expect(harness.session.metadata).toMatchObject({ fromDockerfile: dockerfile });
        expect(harness.onboardSpy).toHaveBeenCalledWith(
          expect.objectContaining({ fromDockerfile: dockerfile }),
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("keeps the Hermes OAuth credential binding with durable OAuth auth", async () => {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        sandboxEntry: {
          agent: "hermes",
          provider: "hermes-provider",
          model: "hermes-model",
          hermesAuthMethod: "oauth",
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.session.hermesAuthMethod).toBe("oauth");
      expect(harness.session.credentialEnv).toBe("OPENAI_API_KEY");
    });

    it("rejects a shared Hermes Provider whose credential binding changed", async () => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: {
          provider: "hermes-provider",
          model: "hermes-model",
          hermesAuthMethod: "api_key",
        },
        hermesCredentialKeys: ["OPENAI_API_KEY"],
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Missing Hermes Provider credentials");
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    });

    it("does not use a generic provider alias to recreate a missing Hermes API-key binding", async () => {
      const restoreEnv = snapshotEnv(["NOUS_API_KEY", "NEMOCLAW_PROVIDER_KEY"]);
      delete process.env.NOUS_API_KEY;
      process.env.NEMOCLAW_PROVIDER_KEY = "unrelated-provider-key";
      try {
        const harness = createRebuildFlowHarness({
          sandboxEntry: {
            provider: "hermes-provider",
            model: "hermes-model",
            hermesAuthMethod: "api_key",
          },
          hermesProviderExists: false,
        });
        await expect(
          harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
        ).rejects.toThrow("Missing Hermes Provider credentials");
        expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      } finally {
        restoreEnv();
      }
    });

    it("ignores a stale matching-session credential for a resolved local target", async () => {
      const harness = createRebuildFlowHarness();
      harness.session.credentialEnv = "NVIDIA_INFERENCE_API_KEY";

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.session.credentialEnv).toBeNull();
    });

    it("fails closed when a legacy matching session recovers Hermes without auth state", async () => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: { provider: null, model: null, hermesAuthMethod: undefined },
      });
      harness.session.provider = "hermes-provider";
      harness.session.model = "hermes-model";
      harness.session.hermesAuthMethod = null;

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Cannot determine recorded Hermes Provider authentication method");

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    });

    it("treats durable web-search false and Dockerfile null as authoritative", async () => {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        sandboxEntry: {
          webSearchEnabled: false,
          fromDockerfile: null,
          hermesAuthMethod: null,
        },
      });
      harness.session.webSearchConfig = { fetchEnabled: true };
      harness.session.hermesAuthMethod = "oauth";
      harness.session.metadata = { fromDockerfile: "/tmp/stale.Dockerfile" };

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.ensureValidatedBraveSearchCredentialSpy).not.toHaveBeenCalled();
      expect(harness.session.webSearchConfig).toBeNull();
      expect(harness.session.hermesAuthMethod).toBeNull();
      expect(harness.session.metadata).toMatchObject({ fromDockerfile: null });
    });

    it("aborts before backup/delete when the durable custom Dockerfile is missing", async () => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: { fromDockerfile: "/definitely/missing/NemoClaw.Dockerfile" },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Recorded custom Dockerfile is unavailable");

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    });
  });
}
