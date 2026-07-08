// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// Use a temp dir so tests don't touch real ~/.nemoclaw.
// HOME must be set before loading registry (it reads HOME at require time),
// so we use createRequire instead of a static import.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-test-"));
process.env.HOME = tmpDir;

const require = createRequire(import.meta.url);
const registry = require("../src/lib/state/registry");

const regFile = path.join(tmpDir, ".nemoclaw", "sandboxes.json");

function makeMessagingPlan(
  name: string,
  channels: string[] = ["telegram"],
  disabledChannels: string[] = [],
) {
  const disabled = new Set<string>(disabledChannels);
  return {
    schemaVersion: 1,
    sandboxName: name,
    agent: "openclaw",
    workflow: "onboard",
    channels: channels.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode: "token-paste",
      active: !disabled.has(channelId),
      selected: true,
      configured: true,
      disabled: disabled.has(channelId),
      inputs: [],
      hooks: [],
    })),
    disabledChannels,
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

beforeEach(() => {
  if (fs.existsSync(regFile)) fs.unlinkSync(regFile);
});

describe("registry", () => {
  it("starts empty", () => {
    const { sandboxes, defaultSandbox } = registry.listSandboxes();
    expect(sandboxes.length).toBe(0);
    expect(defaultSandbox).toBe(null);
  });

  it("registers a sandbox and sets it as default", () => {
    registry.registerSandbox({ name: "alpha", model: "test-model", provider: "nvidia-nim" });
    const sb = registry.getSandbox("alpha");
    expect(sb.name).toBe("alpha");
    expect(sb.model).toBe("test-model");
    expect(registry.getDefault()).toBe("alpha");
  });

  it("stores durable inference metadata at registration time", () => {
    registry.registerSandbox({
      name: "alpha",
      gpuEnabled: false,
      model: "nvidia/nemotron-3-super-120b-a12b",
      provider: "nvidia-prod",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      preferredInferenceApi: "openai-completions",
      nimContainer: null,
    });
    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(data.sandboxes.alpha.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(data.sandboxes.alpha.provider).toBe("nvidia-prod");
    expect(data.sandboxes.alpha.endpointUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(data.sandboxes.alpha.credentialEnv).toBe("NVIDIA_INFERENCE_API_KEY");
    expect(data.sandboxes.alpha.preferredInferenceApi).toBe("openai-completions");
    expect(data.sandboxes.alpha.nimContainer).toBeNull();
  });

  it("stores rebuild fidelity metadata at registration time", () => {
    registry.registerSandbox({
      name: "alpha",
      webSearchEnabled: true,
      toolDisclosure: "direct",
      observabilityEnabled: true,
      fromDockerfile: "/tmp/Dockerfile.custom",
      hermesAuthMethod: "oauth",
    });
    expect(registry.getSandbox("alpha")).toMatchObject({
      webSearchEnabled: true,
      toolDisclosure: "direct",
      observabilityEnabled: true,
      fromDockerfile: "/tmp/Dockerfile.custom",
      hermesAuthMethod: "oauth",
    });
  });

  it("round-trips absent, known-empty, populated, and cloned image-plugin provenance", () => {
    const weatherInstall = {
      id: "weather",
      installPath: "/sandbox/.openclaw/extensions/weather",
      loadPaths: [],
    };
    registry.registerSandbox({ name: "legacy", agent: "openclaw" });
    registry.registerSandbox({
      name: "known-empty",
      agent: "openclaw",
      openclawImagePluginInstalls: [],
    });
    registry.registerSandbox({
      name: "populated",
      agent: "openclaw",
      openclawImagePluginInstalls: [weatherInstall],
    });
    registry.registerSandbox({
      ...registry.getSandbox("populated"),
      name: "populated-clone",
    });
    registry.registerSandbox({
      ...registry.getSandbox("known-empty"),
      name: "known-empty-clone",
    });

    const data = JSON.parse(fs.readFileSync(regFile, "utf-8")).sandboxes;
    expect(registry.getSandbox("legacy").openclawImagePluginInstalls).toBeUndefined();
    expect(registry.getSandbox("known-empty").openclawImagePluginInstalls).toEqual([]);
    expect(registry.getSandbox("known-empty-clone").openclawImagePluginInstalls).toEqual([]);
    expect(registry.getSandbox("populated").openclawImagePluginInstalls).toEqual([weatherInstall]);
    expect(registry.getSandbox("populated-clone").openclawImagePluginInstalls).toEqual([
      weatherInstall,
    ]);
    expect(data.legacy.openclawImagePluginInstalls).toBeUndefined();
    expect(data["known-empty"].openclawImagePluginInstalls).toEqual([]);
    expect(data["known-empty-clone"].openclawImagePluginInstalls).toEqual([]);
    expect(data.populated.openclawImagePluginInstalls).toEqual([weatherInstall]);
    expect(data["populated-clone"].openclawImagePluginInstalls).toEqual([weatherInstall]);
  });

  it("does not invent observability intent for legacy registry rows", () => {
    registry.registerSandbox({ name: "legacy" });
    expect(registry.getSandbox("legacy").observabilityEnabled).toBeUndefined();
  });

  it("preserves missing tool-disclosure state on reconstructed legacy rows", () => {
    registry.registerSandbox({ name: "legacy" });

    const entry = registry.getSandbox("legacy");
    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(entry.toolDisclosure).toBeUndefined();
    expect(data.sandboxes.legacy.toolDisclosure).toBeUndefined();
  });

  it("stores normalized compatible-endpoint reasoning state", () => {
    registry.registerSandbox({
      name: "alpha",
      provider: "compatible-endpoint",
      model: "reasoning-model",
      endpointUrl: "https://example.test/v1",
      compatibleEndpointReasoning: "true",
    });
    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(data.sandboxes.alpha.compatibleEndpointReasoning).toBe("true");
    expect(registry.getSandbox("alpha").compatibleEndpointReasoning).toBe("true");
  });

  it("persists distinct gateway bindings for two sandboxes on different ports (#4422)", () => {
    registry.registerSandbox({
      name: "first",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      dashboardPort: 18789,
    });
    registry.registerSandbox({
      name: "second",
      gatewayName: "nemoclaw-8081",
      gatewayPort: 8081,
      dashboardPort: 18790,
    });
    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(data.sandboxes.first.gatewayName).toBe("nemoclaw");
    expect(data.sandboxes.first.gatewayPort).toBe(8080);
    expect(data.sandboxes.second.gatewayName).toBe("nemoclaw-8081");
    expect(data.sandboxes.second.gatewayPort).toBe(8081);
    // The second registration must not retarget the first sandbox's binding.
    expect(registry.getSandbox("first").gatewayName).toBe("nemoclaw");
    expect(registry.getSandbox("first").gatewayPort).toBe(8080);
  });

  it("registry serialization and update strip recoveredFromGateway display marker (#5714)", () => {
    // The transient #5714 display markers must never reach sandboxes.json even
    // if a caller force-passes one through updateSandbox(). They are not part of
    // the durable SandboxEntry type; serializeSandboxEntryForDisk strips them.
    registry.registerSandbox({ name: "alpha", model: "m", provider: "p" });
    registry.updateSandbox("alpha", {
      policies: ["npm"],
      recoveredFromGateway: true,
      livePhase: "Ready",
    });

    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(data.sandboxes.alpha.policies).toEqual(["npm"]);
    expect(data.sandboxes.alpha.recoveredFromGateway).toBeUndefined();
    expect(data.sandboxes.alpha.livePhase).toBeUndefined();
  });

  it("persists MCP server state without local proxy secrets", () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      mcp: {
        bridges: {
          github: {
            server: "github",
            agent: "openclaw",
            adapter: "mcporter",
            url: "https://api.githubcopilot.com/mcp/",
            env: ["GITHUB_TOKEN"],
            providerName: "alpha-mcp-github",
            providerId: "11111111-2222-4333-8444-555555555555",
            policyName: "mcp-bridge-github",
            addedAt: new Date(0).toISOString(),
          },
        },
      },
    });

    const raw = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    const entry = raw.sandboxes.alpha.mcp.bridges.github;

    expect(entry).toMatchObject({
      url: "https://api.githubcopilot.com/mcp/",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-github",
    });
    expect(entry.token).toBeUndefined();
    expect(entry.command).toBeUndefined();
    expect(entry.port).toBeUndefined();
    expect(raw.sandboxes.alpha.mcp.managedServerNames).toEqual(["github"]);
  });

  it("retains sanitized managed MCP names after the active bridge map is emptied", () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "hermes",
      mcp: {
        bridges: {},
        managedServerNames: ["retired", "../invalid", "retired", "still_active"],
      },
    });

    const stored = registry.getSandbox("alpha").mcp;
    expect(stored).toEqual({
      bridges: {},
      managedServerNames: ["retired", "still_active"],
    });
    expect(JSON.parse(fs.readFileSync(regFile, "utf-8")).sandboxes.alpha.mcp).toEqual(stored);
  });

  it("normalizes MCP bridge maps by the recovered server name", () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      mcp: {
        bridges: {
          stale_key: {
            server: "github",
            agent: "openclaw",
            adapter: "mcporter",
            url: "https://api.githubcopilot.com/mcp/",
            env: ["GITHUB_TOKEN"],
            providerName: "alpha-mcp-github",
            policyName: "mcp-bridge-github",
            addedAt: new Date(0).toISOString(),
          },
        },
      },
    });

    const raw = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(raw.sandboxes.alpha.mcp.bridges.github.server).toBe("github");
    expect(raw.sandboxes.alpha.mcp.bridges.stale_key).toBeUndefined();
  });

  it("normalizes configured inference fields into a discriminated view", () => {
    const configured = { name: "alpha", provider: "nvidia-prod", model: "nvidia/test" };
    const missingProvider = { name: "beta", provider: null, model: "nvidia/test" };
    const missingModel = { name: "gamma", provider: "nvidia-prod", model: null };
    const blankProvider = { name: "delta", provider: "", model: "nvidia/test" };
    const blankModel = { name: "epsilon", provider: "nvidia-prod", model: "   " };

    expect(registry.getSandboxEntryInference(configured)).toEqual({
      kind: "configured",
      provider: "nvidia-prod",
      model: "nvidia/test",
    });
    expect(registry.getSandboxEntryInference(missingProvider)).toEqual({ kind: "unconfigured" });
    expect(registry.getSandboxEntryInference(missingModel)).toEqual({ kind: "unconfigured" });
    expect(registry.getSandboxEntryInference(blankProvider)).toEqual({ kind: "unconfigured" });
    expect(registry.getSandboxEntryInference(blankModel)).toEqual({ kind: "unconfigured" });
  });

  it("first registered becomes default", () => {
    registry.registerSandbox({ name: "first" });
    registry.registerSandbox({ name: "second" });
    expect(registry.getDefault()).toBe("first");
  });

  it("setDefault changes the default", () => {
    registry.registerSandbox({ name: "a" });
    registry.registerSandbox({ name: "b" });
    registry.setDefault("b");
    expect(registry.getDefault()).toBe("b");
  });

  it("setDefault returns false for nonexistent sandbox", () => {
    expect(registry.setDefault("nope")).toBe(false);
  });

  it("updateSandbox modifies fields", () => {
    registry.registerSandbox({ name: "up" });
    registry.updateSandbox("up", { policies: ["pypi", "npm"], model: "new-model" });
    const sb = registry.getSandbox("up");
    expect(sb.policies).toEqual(["pypi", "npm"]);
    expect(sb.model).toBe("new-model");
  });

  it("persists MCP env names without raw host env values", () => {
    registry.registerSandbox({ name: "mcp-sb", agent: "openclaw" });
    registry.updateSandbox("mcp-sb", {
      mcp: {
        bridges: {
          github: {
            server: "github",
            agent: "openclaw",
            adapter: "mcporter",
            url: "https://api.githubcopilot.com/mcp/",
            env: ["GITHUB_TOKEN"],
            providerName: "mcp-sb-mcp-github",
            providerId: "11111111-2222-4333-8444-555555555555",
            policyName: "mcp-bridge-github",
            addedAt: new Date(0).toISOString(),
          },
        },
      },
    });

    const raw = fs.readFileSync(regFile, "utf-8");
    const data = JSON.parse(raw);
    expect(data.sandboxes["mcp-sb"].mcp.bridges.github.env).toEqual(["GITHUB_TOKEN"]);
    expect(data.sandboxes["mcp-sb"].mcp.bridges.github.providerName).toBe("mcp-sb-mcp-github");
    expect(data.sandboxes["mcp-sb"].mcp.bridges.github.providerId).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
    expect(data.sandboxes["mcp-sb"].mcp.bridges.github.token).toBeUndefined();
    expect(raw).not.toContain("ghp_");
    expect(raw).not.toContain("secret-value");
  });

  it("drops invalid persisted MCP bridge entries during registry serialization", () => {
    registry.registerSandbox({ name: "mcp-safe", agent: "openclaw" });
    registry.updateSandbox("mcp-safe", {
      mcp: {
        bridges: {
          ok: {
            server: "ok",
            agent: "openclaw",
            adapter: "mcporter",
            url: "https://api.githubcopilot.com/mcp/#ignored",
            env: ["GITHUB_TOKEN", "GITHUB_TOKEN"],
            providerName: "mcp-safe-mcp-ok",
            policyName: "mcp-bridge-ok",
            addedAt: new Date(0).toISOString(),
          },
          credentialUrl: {
            server: "credentialUrl",
            agent: "openclaw",
            adapter: "mcporter",
            url: "https://user:secret@example.test/mcp",
            env: ["TOKEN"],
            providerName: "mcp-safe-mcp-credential",
            policyName: "mcp-bridge-credential",
            addedAt: new Date(0).toISOString(),
          },
          privateIp: {
            server: "privateIp",
            agent: "openclaw",
            adapter: "mcporter",
            url: "http://127.0.0.1:31337/mcp",
            env: ["TOKEN"],
            providerName: "mcp-safe-mcp-private",
            policyName: "mcp-bridge-private",
            addedAt: new Date(0).toISOString(),
          },
          invalidEnv: {
            server: "invalidEnv",
            agent: "openclaw",
            adapter: "mcporter",
            url: "https://api.githubcopilot.com/mcp/",
            env: ["TOKEN=secret"],
            providerName: "mcp-safe-mcp-invalid-env",
            policyName: "mcp-bridge-invalid-env",
            addedAt: new Date(0).toISOString(),
          },
          unknownAdapter: {
            server: "unknownAdapter",
            agent: "openclaw",
            adapter: "unknown",
            url: "https://api.githubcopilot.com/mcp/",
            env: ["TOKEN"],
            providerName: "mcp-safe-mcp-unknown",
            policyName: "mcp-bridge-unknown",
            addedAt: new Date(0).toISOString(),
          },
          invalidProviderId: {
            server: "invalidProviderId",
            agent: "openclaw",
            adapter: "mcporter",
            url: "https://api.githubcopilot.com/mcp/",
            env: ["TOKEN"],
            providerName: "mcp-safe-mcp-invalid-provider-id",
            providerId: "invalid provider id",
            policyName: "mcp-bridge-invalid-provider-id",
            addedAt: new Date(0).toISOString(),
          },
          oversizedUrl: {
            server: "oversizedUrl",
            agent: "openclaw",
            adapter: "mcporter",
            url: `https://api.githubcopilot.com/${"a".repeat(2_048)}`,
            env: ["TOKEN"],
            providerName: "mcp-safe-mcp-oversized",
            policyName: "mcp-bridge-oversized",
            addedAt: new Date(0).toISOString(),
          },
        },
      },
    });

    const bridges = registry.getSandbox("mcp-safe").mcp.bridges;
    expect(Object.keys(bridges)).toEqual(["ok"]);
    expect(bridges.ok.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(bridges.ok.env).toEqual(["GITHUB_TOKEN"]);
  });

  it("updateSandbox returns false for nonexistent sandbox", () => {
    expect(registry.updateSandbox("nope", {})).toBe(false);
  });

  it("registerSandbox does not inherit a finalized policy marker (#4621)", () => {
    // Snapshot restore spreads the source entry (possibly finalized) but resets
    // policies; the clone must not carry a stale finalized marker.
    registry.registerSandbox({ name: "clone", policies: [], policyPresetsFinalized: true });
    expect(registry.getSandbox("clone").policyPresetsFinalized).toBeUndefined();
    // The marker is set only by the post-policy registry write.
    registry.updateSandbox("clone", { policyPresetsFinalized: true });
    expect(registry.getSandbox("clone").policyPresetsFinalized).toBe(true);
  });

  it("updateSandbox rejects name changes", () => {
    registry.registerSandbox({ name: "orig" });
    expect(registry.updateSandbox("orig", { name: "renamed" })).toBe(false);
    // Original entry unchanged
    expect(registry.getSandbox("orig").name).toBe("orig");
    // No ghost entry under new name
    expect(registry.getSandbox("renamed")).toBe(null);
  });

  it("removeSandbox deletes and shifts default", () => {
    registry.registerSandbox({ name: "x" });
    registry.registerSandbox({ name: "y" });
    registry.setDefault("x");
    registry.removeSandbox("x");
    expect(registry.getSandbox("x")).toBe(null);
    expect(registry.getDefault()).toBe("y");
  });

  it("getDefault falls back when defaultSandbox points to a stale name", () => {
    registry.registerSandbox({ name: "alive" });
    const data = registry.load();
    data.defaultSandbox = "deleted-sandbox";
    registry.save(data);
    expect(registry.getDefault()).toBe("alive");
  });

  it("getDefault returns null when registry is empty with stale pointer", () => {
    const data = { sandboxes: {}, defaultSandbox: "ghost" };
    registry.save(data);
    expect(registry.getDefault()).toBe(null);
  });

  it("removeSandbox last sandbox sets default to null", () => {
    registry.registerSandbox({ name: "only" });
    registry.removeSandbox("only");
    expect(registry.getDefault()).toBe(null);
    expect(registry.listSandboxes().sandboxes.length).toBe(0);
  });

  it("removeSandbox returns false for nonexistent", () => {
    expect(registry.removeSandbox("nope")).toBe(false);
  });

  it("atomically returns the exact registry row it removes", () => {
    registry.registerSandbox({ name: "receipt", model: "captured", imageTag: "old-image" });
    const receipt = registry.removeSandboxWithReceipt("receipt");
    expect(receipt?.entry).toMatchObject({
      name: "receipt",
      model: "captured",
      imageTag: "old-image",
    });
    expect(receipt).toMatchObject({
      wasDefault: true,
      fallbackDefault: null,
      postRemovalDefaultSelectionRevision: 2,
    });
    expect(registry.getSandbox("receipt")).toBeNull();
    expect(registry.removeSandboxWithReceipt("receipt")).toBeNull();
  });

  it("restores a removed row after an intervening registry registration", () => {
    registry.registerSandbox({ name: "alpha", model: "original", imageTag: "old-image" });
    const receipt = registry.removeSandboxWithReceipt("alpha");
    expect(receipt).not.toBeNull();

    registry.registerSandbox({ name: "concurrent", model: "new" });
    expect(registry.setDefault("concurrent")).toBe(true);

    expect(registry.restoreSandboxEntryIfMissing(receipt!)).toBe(true);
    expect(registry.getSandbox("alpha")).toMatchObject({
      name: "alpha",
      model: "original",
      imageTag: "old-image",
    });
    expect(registry.getSandbox("concurrent")).toMatchObject({
      name: "concurrent",
      model: "new",
    });
    expect(registry.getDefault()).toBe("concurrent");
  });

  it("serializes a spawned registration that starts during an atomic restore", () => {
    const { spawnSync } = require("child_process");
    registry.registerSandbox({ name: "alpha", model: "original", imageTag: "old-image" });
    registry.registerSandbox({ name: "beta", model: "existing" });
    registry.setDefault("alpha");
    const receipt = registry.removeSandboxWithReceipt("alpha");
    expect(receipt).not.toBeNull();
    expect(registry.getDefault()).toBe("beta");

    const registryPath = path.resolve(
      path.join(import.meta.dirname, "..", "src", "lib", "state", "registry.ts"),
    );
    const homeDir = path.dirname(path.dirname(regFile));
    const coordinationDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-restore-race-"));
    const restoreEntered = path.join(coordinationDir, "restore-entered");
    const writerBlocked = path.join(coordinationDir, "writer-blocked");
    const releaseRestore = path.join(coordinationDir, "release-restore");
    const pauseSource =
      "const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);";
    const restoreScript = `
      process.env.HOME = ${JSON.stringify(homeDir)};
      const fs = require("fs");
      ${pauseSource}
      const registry = require(${JSON.stringify(registryPath)});
      const realReadFile = fs.readFileSync;
      let pausedRegistryLoad = false;
      fs.readFileSync = (target, options) => {
        if (!pausedRegistryLoad && String(target) === registry.REGISTRY_FILE) {
          pausedRegistryLoad = true;
          fs.writeFileSync(${JSON.stringify(restoreEntered)}, "ready");
          const deadline = Date.now() + 10_000;
          while (!fs.existsSync(${JSON.stringify(releaseRestore)})) {
            if (Date.now() >= deadline) throw new Error("timed out waiting to release restore");
            pause(10);
          }
        }
        return realReadFile(target, options);
      };
      const restored = registry.restoreSandboxEntryIfMissing(JSON.parse(process.argv[1]));
      process.exit(restored ? 0 : 2);
    `;
    const writerScript = `
      process.env.HOME = ${JSON.stringify(homeDir)};
      const fs = require("fs");
      const registry = require(${JSON.stringify(registryPath)});
      const realMkdir = fs.mkdirSync;
      fs.mkdirSync = (target, options) => {
        try {
          return realMkdir(target, options);
        } catch (error) {
          if (String(target) === registry.LOCK_DIR && error?.code === "EEXIST") {
            fs.writeFileSync(
              ${JSON.stringify(writerBlocked)},
              fs.readFileSync(registry.LOCK_OWNER, "utf-8").trim(),
            );
          }
          throw error;
        }
      };
      registry.registerSandbox({ name: "concurrent", model: "new" });
    `;
    const orchestrator = `
      const { spawn } = require("child_process");
      const fs = require("fs");
      ${pauseSource}
      const waitForFile = (file) => {
        const deadline = Date.now() + 10_000;
        while (!fs.existsSync(file)) {
          if (Date.now() >= deadline) throw new Error("timed out waiting for " + file);
          pause(10);
        }
      };
      const waitForExit = (child) => new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      (async () => {
        const restore = spawn(process.execPath, ["-e", ${JSON.stringify(restoreScript)}, ${JSON.stringify(JSON.stringify(receipt))}], { stdio: "inherit" });
        const restoreExit = waitForExit(restore);
        waitForFile(${JSON.stringify(restoreEntered)});
        const writer = spawn(process.execPath, ["-e", ${JSON.stringify(writerScript)}], { stdio: "inherit" });
        const writerExit = waitForExit(writer);
        waitForFile(${JSON.stringify(writerBlocked)});
        const lockOwnerPid = Number(fs.readFileSync(${JSON.stringify(writerBlocked)}, "utf-8"));
        if (lockOwnerPid !== restore.pid) {
          throw new Error(
            "writer blocked on lock owner " + lockOwnerPid + ", expected restore pid " + restore.pid,
          );
        }
        fs.writeFileSync(${JSON.stringify(releaseRestore)}, "go");
        const [restoreResult, writerResult] = await Promise.all([
          restoreExit,
          writerExit,
        ]);
        if (restoreResult.code !== 0 || writerResult.code !== 0) {
          console.error(JSON.stringify({ restoreResult, writerResult }));
          process.exit(1);
        }
      })().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;

    try {
      const result = spawnSync(process.execPath, ["-e", orchestrator], {
        encoding: "utf-8",
        timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(registry.getSandbox("alpha")).toMatchObject({ model: "original" });
      expect(registry.getSandbox("beta")).toMatchObject({ model: "existing" });
      expect(registry.getSandbox("concurrent")).toMatchObject({ model: "new" });
      expect(registry.getDefault()).toBe("alpha");
      const persisted = JSON.parse(fs.readFileSync(regFile, "utf-8"));
      expect(Object.keys(persisted.sandboxes).sort()).toEqual(["alpha", "beta", "concurrent"]);
      expect(persisted.defaultSandbox).toBe("alpha");
      expect(
        fs.readdirSync(path.dirname(regFile)).filter((name) => name.includes(".tmp.")),
      ).toEqual([]);
    } finally {
      fs.rmSync(coordinationDir, { recursive: true, force: true });
    }
  });

  it("restores a rebuild entry only while its name is unclaimed", () => {
    registry.registerSandbox({ name: "alpha", model: "old", imageTag: "old-image" });
    registry.registerSandbox({ name: "beta" });
    registry.registerSandbox({ name: "gamma" });
    registry.setDefault("alpha");
    const original = registry.getSandbox("alpha");

    const firstReceipt = registry.removeSandboxWithReceipt("alpha");
    expect(firstReceipt).not.toBeNull();
    expect(registry.getDefault()).toBe("beta");
    expect(
      registry.restoreSandboxEntryIfMissing({
        ...firstReceipt!,
        entry: { ...original, imageTag: null },
      }),
    ).toBe(true);
    expect(registry.getDefault()).toBe("alpha");
    expect(registry.getSandbox("alpha").imageTag).toBe(null);

    registry.updateSandbox("alpha", {
      model: "replacement",
      imageTag: "replacement-image",
    });
    expect(registry.restoreSandboxEntryIfMissing(firstReceipt!)).toBe(false);
    expect(registry.getSandbox("alpha").model).toBe("replacement");
    expect(registry.getSandbox("alpha").imageTag).toBe("replacement-image");

    const secondReceipt = registry.removeSandboxWithReceipt("alpha");
    expect(secondReceipt).not.toBeNull();
    registry.setDefault("gamma");
    expect(registry.restoreSandboxEntryIfMissing(secondReceipt!)).toBe(true);
    expect(registry.getDefault()).toBe("gamma");

    registry.clearAll();
    expect(registry.restoreSandboxEntryIfMissing(secondReceipt!)).toBe(true);
    expect(registry.getDefault()).toBe("alpha");
  });

  it("getSandbox returns null for nonexistent", () => {
    expect(registry.getSandbox("nope")).toBe(null);
  });

  it("persists to disk and survives reload", () => {
    registry.registerSandbox({ name: "persist", model: "m1" });
    // Read file directly
    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(data.sandboxes.persist.model).toBe("m1");
    expect(data.defaultSandbox).toBe("persist");
  });

  it("clearAll removes persisted sandboxes and the default pointer", () => {
    registry.registerSandbox({ name: "alpha", model: "m1" });
    registry.registerSandbox({ name: "beta", model: "m2" });
    registry.setDefault("beta");

    registry.clearAll();

    expect(registry.listSandboxes()).toEqual({
      sandboxes: [],
      defaultSandbox: null,
    });
    expect(registry.getDefault()).toBe(null);
    expect(registry.getSandbox("alpha")).toBe(null);
    expect(JSON.parse(fs.readFileSync(regFile, "utf-8"))).toEqual({
      sandboxes: {},
      defaultSandbox: null,
      defaultSelectionRevision: 3,
    });
  });

  it("stores imageTag at registration time", () => {
    registry.registerSandbox({
      name: "tagged",
      imageTag: "openshell/sandbox-from:1776766054",
    });
    const sb = registry.getSandbox("tagged");
    expect(sb.imageTag).toBe("openshell/sandbox-from:1776766054");
    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(data.sandboxes.tagged.imageTag).toBe("openshell/sandbox-from:1776766054");
  });

  it("stores messaging plan state at registration time", () => {
    const basePlan = makeMessagingPlan("messaging", ["telegram"]);
    const plan = {
      ...basePlan,
      channels: [
        {
          ...basePlan.channels[0],
          inputs: [
            {
              channelId: "telegram",
              inputId: "botToken",
              kind: "secret",
              required: true,
              sourceEnv: "TELEGRAM_BOT_TOKEN",
              credentialAvailable: true,
            },
          ],
        },
      ],
      credentialBindings: [
        {
          channelId: "telegram",
          credentialId: "telegramBotToken",
          sourceInput: "botToken",
          providerName: "messaging-telegram-bridge",
          providerEnvKey: "TELEGRAM_BOT_TOKEN",
          placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
          credentialAvailable: true,
          credentialHash: "hash",
        },
      ],
    };
    registry.registerSandbox({
      name: "messaging",
      messaging: { schemaVersion: 1, plan },
    });

    const sb = registry.getSandbox("messaging");
    expect(sb.messaging).toMatchObject({
      schemaVersion: 1,
      plan: {
        schemaVersion: 1,
        sandboxName: "messaging",
        channels: [expect.objectContaining({ channelId: "telegram", active: true })],
      },
    });
    const rawSandbox = sb as unknown as Record<string, unknown>;
    expect(rawSandbox.messagingChannels).toBeUndefined();
    expect(rawSandbox.messagingChannelConfig).toBeUndefined();
    expect(registry.getConfiguredMessagingChannels("messaging")).toEqual(["telegram"]);
    const hydrated = registry.getHydratedMessagingPlanFromEntry(sb);
    expect(
      hydrated.agentRender.some((entry: { channelId: string }) => entry.channelId === "telegram"),
    ).toBe(true);
    expect(
      hydrated.channels[0].hooks.some(
        (hook: { channelId: string }) => hook.channelId === "telegram",
      ),
    ).toBe(true);
    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(data.sandboxes.messaging.messaging.schemaVersion).toBe(1);
    expect(data.sandboxes.messaging.messaging.plan).toMatchObject({
      schemaVersion: 1,
      sandboxName: "messaging",
      channels: [{ channelId: "telegram" }],
    });
    expect(data.sandboxes.messaging.messaging.plan.networkPolicy).toEqual({
      presets: [],
      entries: [],
    });
    expect(data.sandboxes.messaging.messaging.plan.agentRender).toBeUndefined();
    expect(data.sandboxes.messaging.messaging.plan.buildSteps).toBeUndefined();
    expect(data.sandboxes.messaging.messaging.plan.runtimeSetup).toBeUndefined();
    expect(data.sandboxes.messaging.messaging.plan.stateUpdates).toBeUndefined();
    expect(data.sandboxes.messaging.messaging.plan.healthChecks).toBeUndefined();
    expect(data.sandboxes.messaging.messaging.plan.channels[0]).toEqual({
      channelId: "telegram",
      active: true,
      configured: true,
      disabled: false,
      inputs: [{ inputId: "botToken", credentialAvailable: true }],
    });
    expect(data.sandboxes.messaging.messaging.plan.channels[0].hooks).toBeUndefined();
    expect(data.sandboxes.messaging.messaging.plan.credentialBindings).toEqual([
      {
        channelId: "telegram",
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
        credentialAvailable: true,
        credentialHash: "hash",
      },
    ]);
    expect(data.sandboxes.messaging.messagingChannels).toBeUndefined();
    expect(data.sandboxes.messaging.messagingChannelConfig).toBeUndefined();
  });

  it("imageTag defaults to null when not provided", () => {
    registry.registerSandbox({ name: "no-tag" });
    const sb = registry.getSandbox("no-tag");
    expect(sb.imageTag).toBe(null);
  });

  it("imageTag can be updated via updateSandbox", () => {
    registry.registerSandbox({ name: "updatable" });
    registry.updateSandbox("updatable", { imageTag: "openshell/sandbox-from:9999" });
    expect(registry.getSandbox("updatable").imageTag).toBe("openshell/sandbox-from:9999");
  });

  it("handles corrupt registry file gracefully", () => {
    fs.mkdirSync(path.dirname(regFile), { recursive: true });
    fs.writeFileSync(regFile, "NOT JSON");
    // Should not throw, returns empty
    const { sandboxes } = registry.listSandboxes();
    expect(sandboxes.length).toBe(0);
  });

  it("skips malformed sandbox entries while loading the registry", () => {
    fs.mkdirSync(path.dirname(regFile), { recursive: true });
    fs.writeFileSync(
      regFile,
      JSON.stringify({
        defaultSandbox: "broken",
        sandboxes: {
          good: { name: "good", model: "m1" },
          broken: null,
          text: "not-an-entry",
        },
      }),
    );

    expect(registry.getSandbox("broken")).toBe(null);
    expect(registry.getDefault()).toBe("good");
    expect(
      registry.listSandboxes().sandboxes.map((sandbox: { name: string }) => sandbox.name),
    ).toEqual(["good"]);
  });

  it("setChannelDisabled toggles a channel on and off for a sandbox", () => {
    registry.registerSandbox({
      name: "s1",
      messaging: { schemaVersion: 1, plan: makeMessagingPlan("s1", ["telegram", "discord"]) },
    });
    expect(registry.getDisabledChannels("s1")).toEqual([]);

    expect(registry.setChannelDisabled("s1", "telegram", true)).toBe(true);
    expect(registry.getDisabledChannels("s1")).toEqual(["telegram"]);

    expect(registry.setChannelDisabled("s1", "discord", true)).toBe(true);
    expect(registry.getDisabledChannels("s1")).toEqual(["discord", "telegram"]);

    registry.setChannelDisabled("s1", "telegram", false);
    expect(registry.getDisabledChannels("s1")).toEqual(["discord"]);
  });

  it("setChannelDisabled clears plan.disabledChannels when empty", () => {
    registry.registerSandbox({
      name: "s1",
      messaging: { schemaVersion: 1, plan: makeMessagingPlan("s1", ["telegram"]) },
    });
    registry.setChannelDisabled("s1", "telegram", true);
    registry.setChannelDisabled("s1", "telegram", false);
    const persisted = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(persisted.sandboxes.s1.messaging.plan.disabledChannels).toEqual([]);
    expect(persisted.sandboxes.s1.disabledChannels).toBeUndefined();
  });

  it("setChannelDisabled returns false when the channel is not configured in the plan", () => {
    registry.registerSandbox({
      name: "s1",
      messaging: { schemaVersion: 1, plan: makeMessagingPlan("s1", ["telegram"]) },
    });
    expect(registry.setChannelDisabled("s1", "discord", true)).toBe(false);
    expect(registry.getDisabledChannels("s1")).toEqual([]);
  });

  it("setChannelDisabled returns false when sandbox is missing", () => {
    expect(registry.setChannelDisabled("missing", "telegram", true)).toBe(false);
  });

  it("registerSandbox preserves disabledChannels when re-registering", () => {
    registry.registerSandbox({
      name: "s1",
      messaging: { schemaVersion: 1, plan: makeMessagingPlan("s1", ["telegram"]) },
    });
    registry.setChannelDisabled("s1", "telegram", true);
    registry.registerSandbox({
      name: "s1",
      messaging: registry.getSandbox("s1").messaging,
    });
    expect(registry.getDisabledChannels("s1")).toEqual(["telegram"]);
  });

  it("addCustomPolicy persists name, content, and sourcePath", () => {
    registry.registerSandbox({ name: "cp1" });
    const added = registry.addCustomPolicy("cp1", {
      name: "my-api",
      content: "preset:\n  name: my-api\nnetwork_policies: {}\n",
      sourcePath: "/tmp/my-api.yaml",
    });
    expect(added).toBe(true);
    const list = registry.getCustomPolicies("cp1");
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("my-api");
    expect(list[0].content).toMatch(/name: my-api/);
    expect(list[0].sourcePath).toBe("/tmp/my-api.yaml");
    expect(typeof list[0].appliedAt).toBe("string");
  });

  it("addCustomPolicy replaces an existing entry with the same name", () => {
    registry.registerSandbox({ name: "cp2" });
    registry.addCustomPolicy("cp2", { name: "dup", content: "v1" });
    registry.addCustomPolicy("cp2", { name: "dup", content: "v2" });
    const list = registry.getCustomPolicies("cp2");
    expect(list.length).toBe(1);
    expect(list[0].content).toBe("v2");
  });

  it("removeCustomPolicyByName removes an entry and returns true", () => {
    registry.registerSandbox({ name: "cp3" });
    registry.addCustomPolicy("cp3", { name: "a", content: "x" });
    registry.addCustomPolicy("cp3", { name: "b", content: "y" });
    expect(registry.removeCustomPolicyByName("cp3", "a")).toBe(true);
    const list = registry.getCustomPolicies("cp3");
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("b");
  });

  it("removeCustomPolicyByName returns false when the entry is missing", () => {
    registry.registerSandbox({ name: "cp4" });
    expect(registry.removeCustomPolicyByName("cp4", "nope")).toBe(false);
  });

  it("getCustomPolicies returns [] for unknown or fresh sandboxes", () => {
    expect(registry.getCustomPolicies("nonexistent")).toEqual([]);
    registry.registerSandbox({ name: "cp5" });
    expect(registry.getCustomPolicies("cp5")).toEqual([]);
  });

  describe("extra providers", () => {
    it("starts with an empty extra-provider list", () => {
      expect(registry.listExtraProviders()).toEqual([]);
    });

    it("addExtraProvider persists a sorted, deduplicated list", () => {
      expect(registry.addExtraProvider("tavily-search")).toBe(true);
      expect(registry.addExtraProvider("custom-provider")).toBe(true);
      expect(registry.addExtraProvider("tavily-search")).toBe(false);
      expect(registry.listExtraProviders()).toEqual(["custom-provider", "tavily-search"]);
    });

    it("removeExtraProvider clears the entry and drops the field when empty", () => {
      registry.addExtraProvider("tavily-search");
      expect(registry.removeExtraProvider("tavily-search")).toBe(true);
      expect(registry.listExtraProviders()).toEqual([]);
      const raw = JSON.parse(fs.readFileSync(regFile, "utf-8"));
      expect("extraProviders" in raw).toBe(false);
      expect(registry.removeExtraProvider("tavily-search")).toBe(false);
    });

    it("survives a registry round-trip through disk", () => {
      registry.addExtraProvider("tavily-search");
      expect(registry.listExtraProviders()).toEqual(["tavily-search"]);
    });
  });
});

describe("atomic writes", () => {
  const regDir = path.dirname(regFile);

  beforeEach(() => {
    if (fs.existsSync(regFile)) fs.unlinkSync(regFile);
    // Clean up any leftover tmp files
    if (fs.existsSync(regDir)) {
      for (const f of fs.readdirSync(regDir)) {
        if (f.startsWith("sandboxes.json.tmp.")) {
          fs.unlinkSync(path.join(regDir, f));
        }
      }
    }
  });

  it("save() writes via temp file + rename (no partial writes on disk)", () => {
    registry.registerSandbox({ name: "atomic-test" });
    // File must exist and be valid JSON after save
    const raw = fs.readFileSync(regFile, "utf-8");
    const data = JSON.parse(raw);
    expect(data.sandboxes["atomic-test"].name).toBe("atomic-test");
    // No leftover .tmp files
    const tmpFiles = fs.readdirSync(regDir).filter((f) => f.startsWith("sandboxes.json.tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  it("save() cleans up temp file when rename fails", () => {
    fs.mkdirSync(regDir, { recursive: true });
    fs.writeFileSync(regFile, '{"sandboxes":{},"defaultSandbox":null}', { mode: 0o600 });

    // Stub renameSync so writeFileSync succeeds (temp file is created)
    // but the rename step throws — exercising the cleanup branch.
    const original = fs.renameSync;
    fs.renameSync = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    try {
      expect(() => registry.save({ sandboxes: {}, defaultSandbox: null })).toThrow(
        /Cannot write config file|EACCES/,
      );
    } finally {
      fs.renameSync = original;
    }
    // The save() catch block should have removed the temp file
    const tmpFiles = fs.readdirSync(regDir).filter((f) => f.startsWith("sandboxes.json.tmp."));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe("advisory file locking", () => {
  const lockDir = regFile + ".lock";
  const ownerFile = path.join(lockDir, "owner");

  beforeEach(() => {
    if (fs.existsSync(regFile)) fs.unlinkSync(regFile);
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it("acquireLock creates lock directory with owner file and releaseLock removes both", () => {
    registry.acquireLock();
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.existsSync(ownerFile)).toBe(true);
    expect(fs.readFileSync(ownerFile, "utf-8").trim()).toBe(String(process.pid));
    registry.releaseLock();
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("withLock releases lock even when callback throws", () => {
    expect(() => {
      registry.withLock(() => {
        expect(fs.existsSync(lockDir)).toBe(true);
        throw new Error("intentional");
      });
    }).toThrow("intentional");
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("acquireLock cleans up lock dir when owner file write fails", () => {
    const origWrite = fs.writeFileSync;
    let firstCall = true;
    fs.writeFileSync = (...args) => {
      // Fail only the first writeFileSync targeting the owner tmp file
      if (String(args[0]).includes("owner.tmp.") && firstCall) {
        firstCall = false;
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      }
      return origWrite.apply(fs, args);
    };
    try {
      // First attempt should throw, but no stale lock dir left behind
      expect(() => registry.acquireLock()).toThrow("ENOSPC");
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      fs.writeFileSync = origWrite;
    }
  });

  it("acquireLock removes stale lock owned by dead process", () => {
    // Create a lock with a PID that doesn't exist (99999999)
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(ownerFile, "99999999", { mode: 0o600 });

    // Should succeed by detecting the dead owner and removing the stale lock
    registry.acquireLock();
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.readFileSync(ownerFile, "utf-8").trim()).toBe(String(process.pid));
    registry.releaseLock();
  });

  it("mutating operations acquire and release the lock", () => {
    const mkdirCalls = [];
    const rmCalls = [];
    const origMkdir = fs.mkdirSync;
    const origRm = fs.rmSync;
    fs.mkdirSync = (...args) => {
      if (args[0] === lockDir) mkdirCalls.push(args[0]);
      return origMkdir.apply(fs, args);
    };
    fs.rmSync = (...args) => {
      if (args[0] === lockDir) rmCalls.push(args[0]);
      return origRm.apply(fs, args);
    };
    try {
      registry.registerSandbox({ name: "lock-test" });
    } finally {
      fs.mkdirSync = origMkdir;
      fs.rmSync = origRm;
    }
    expect(mkdirCalls.length).toBeGreaterThanOrEqual(1);
    expect(rmCalls.length).toBeGreaterThanOrEqual(1);
    expect(registry.getSandbox("lock-test").name).toBe("lock-test");
  });

  it("concurrent writers do not corrupt the registry", () => {
    const { spawnSync } = require("child_process");
    const registryPath = path.resolve(
      path.join(import.meta.dirname, "..", "src", "lib", "state", "registry.ts"),
    );
    const homeDir = path.dirname(path.dirname(regFile));
    // Script that spawns 4 workers in parallel, each writing 5 sandboxes
    const orchestrator = `
      const { spawn } = require("child_process");
      const workerScript = \`
        process.env.HOME = ${JSON.stringify(homeDir)};
        const reg = require(${JSON.stringify(registryPath)});
        const id = process.argv[1];
        for (let i = 0; i < 5; i++) {
          reg.registerSandbox({ name: id + "-" + i, model: "m" });
        }
      \`;
      const workers = [];
      for (let w = 0; w < 4; w++) {
        workers.push(spawn(process.execPath, ["-e", workerScript, "w" + w]));
      }
      let exitCount = 0;
      let allOk = true;
      for (const child of workers) {
        child.on("exit", (code) => {
          if (code !== 0) allOk = false;
          exitCount++;
          if (exitCount === workers.length) {
            process.exit(allOk ? 0 : 1);
          }
        });
      }
    `;
    const result = spawnSync(process.execPath, ["-e", orchestrator], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    // All 20 sandboxes (4 workers × 5 each) must be present
    const { sandboxes } = registry.listSandboxes();
    expect(sandboxes.length).toBe(20);
  });

  it("clearAll removes all sandboxes and resets default", () => {
    registry.registerSandbox({ name: "alpha" });
    registry.registerSandbox({ name: "beta" });
    registry.setDefault("beta");

    registry.clearAll();

    const { sandboxes, defaultSandbox } = registry.listSandboxes();
    expect(sandboxes).toHaveLength(0);
    expect(defaultSandbox).toBe(null);
  });

  it("clearAll persists empty state to disk", () => {
    registry.registerSandbox({ name: "persist-me" });

    registry.clearAll();

    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(data.sandboxes).toEqual({});
    expect(data.defaultSandbox).toBe(null);
  });

  it("clearAll is safe to call on empty registry", () => {
    registry.clearAll();

    const { sandboxes, defaultSandbox } = registry.listSandboxes();
    expect(sandboxes).toHaveLength(0);
    expect(defaultSandbox).toBe(null);
  });
});
