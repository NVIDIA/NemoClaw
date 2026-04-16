// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildProviderArgs,
  buildSandboxConfigSyncScript,
  classifySandboxCreateFailure,
  compactText,
  formatEnvAssignment,
  getDashboardAccessInfo,
  getDashboardForwardStartCommand,
  getNavigationChoice,
  getGatewayReuseState,
  getPortConflictServiceHints,
  getFutureShellPathHint,
  getSandboxInferenceConfig,
  getInstalledOpenshellVersion,
  getBlueprintMinOpenshellVersion,
  getBlueprintMaxOpenshellVersion,
  versionGte,
  getRequestedModelHint,
  getRequestedProviderHint,
  getRequestedSandboxNameHint,
  getResumeConfigConflicts,
  getResumeSandboxConflict,
  getSandboxStateFromOutputs,
  getStableGatewayImageRef,
  isGatewayHealthy,
  classifyValidationFailure,
  hasResponsesToolCall,
  isLoopbackHostname,
  normalizeProviderBaseUrl,
  parsePolicyPresetEnv,
  patchStagedDockerfile,
  pullAndResolveBaseImageDigest,
  SANDBOX_BASE_IMAGE,
  printSandboxCreateRecoveryHints,
  resolveDashboardForwardTarget,
  summarizeCurlFailure,
  summarizeProbeFailure,
  shouldIncludeBuildContextPath,
  writeSandboxConfigSyncFile,
} from "../dist/lib/onboard";
import { stageOptimizedSandboxBuildContext } from "../dist/lib/sandbox-build-context";
import { buildWebSearchDockerConfig } from "../dist/lib/web-search";

const require = createRequire(import.meta.url);
const { getSuggestedPolicyPresets } = require("../dist/lib/onboard.js");

describe("onboard helpers", () => {
  it("classifies sandbox create timeout failures and tracks upload progress", () => {
    expect(
      classifySandboxCreateFailure("Error: failed to read image export stream\nTimeout error").kind,
    ).toBe("image_transfer_timeout");
    expect(
      classifySandboxCreateFailure(
        [
          '  Pushing image openshell/sandbox-from:123 into gateway "nemoclaw"',
          "  [progress] Uploaded to gateway",
          "Error: failed to read image export stream",
        ].join("\n"),
      ),
    ).toEqual({
      kind: "image_transfer_timeout",
      uploadedToGateway: true,
    });
  });

  it("classifies sandbox create connection resets and incomplete create streams", () => {
    expect(classifySandboxCreateFailure("Connection reset by peer").kind).toBe(
      "image_transfer_reset",
    );
    expect(
      classifySandboxCreateFailure(
        [
          "  Image openshell/sandbox-from:123 is available in the gateway.",
          "Created sandbox: my-assistant",
          "Error: stream closed unexpectedly",
        ].join("\n"),
      ),
    ).toEqual({
      kind: "sandbox_create_incomplete",
      uploadedToGateway: true,
    });
  });

  it("builds a sandbox sync script that only writes nemoclaw config", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      onboardedAt: "2026-03-18T12:00:00.000Z",
    });

    assert.match(script, /cat > ~\/\.nemoclaw\/config\.json/);
    assert.match(script, /"model": "nemotron-3-nano:30b"/);
    assert.match(script, /"credentialEnv": "OPENAI_API_KEY"/);
    assert.doesNotMatch(script, /cat > ~\/\.openclaw\/openclaw\.json/);
    assert.doesNotMatch(script, /openclaw models set/);
    assert.match(script, /^exit$/m);
  });

  it("uses explicit messaging selections for policy suggestions when provided", () => {
    const originalTelegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const originalDiscordBotToken = process.env.DISCORD_BOT_TOKEN;
    const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
    process.env.DISCORD_BOT_TOKEN = "discord-token";
    process.env.SLACK_BOT_TOKEN = "slack-token";
    try {
      expect(getSuggestedPolicyPresets({ enabledChannels: [] })).toEqual(["pypi", "npm"]);
      expect(getSuggestedPolicyPresets({ enabledChannels: ["telegram"] })).toEqual([
        "pypi",
        "npm",
        "telegram",
      ]);
      expect(getSuggestedPolicyPresets({ enabledChannels: ["discord", "slack"] })).toEqual([
        "pypi",
        "npm",
        "slack",
        "discord",
      ]);
    } finally {
      if (originalTelegramBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = originalTelegramBotToken;
      if (originalDiscordBotToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = originalDiscordBotToken;
      if (originalSlackBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = originalSlackBotToken;
    }
  });

  it("patches the staged Dockerfile with the selected model and chat UI URL", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        "ARG NEMOCLAW_BUILD_ID=default",
      ].join("\n"),
    );

    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:19999",
        "build-123",
        "openai-api",
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(patched, /^ARG NEMOCLAW_MODEL=gpt-5\.4$/m);
      assert.match(patched, /^ARG NEMOCLAW_PROVIDER_KEY=openai$/m);
      assert.match(patched, /^ARG NEMOCLAW_PRIMARY_MODEL_REF=openai\/gpt-5\.4$/m);
      assert.match(patched, /^ARG CHAT_UI_URL=http:\/\/127\.0\.0\.1:19999$/m);
      assert.match(patched, /^ARG NEMOCLAW_BUILD_ID=build-123$/m);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("patches the staged Dockerfile with Discord guild config for server workspaces", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-discord-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        "ARG NEMOCLAW_MESSAGING_CHANNELS_B64=W10=",
        "ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=e30=",
        "ARG NEMOCLAW_DISCORD_GUILDS_B64=e30=",
        "ARG NEMOCLAW_BUILD_ID=default",
      ].join("\n"),
    );

    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:19999",
        "build-discord-guild",
        "openai-api",
        null,
        null,
        ["discord"],
        {},
        {
          "1491590992753590594": {
            requireMention: true,
            users: ["1005536447329222676"],
          },
        },
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(patched, /^ARG NEMOCLAW_MESSAGING_CHANNELS_B64=/m);
      const guildLine = patched
        .split("\n")
        .find((line) => line.startsWith("ARG NEMOCLAW_DISCORD_GUILDS_B64="));
      assert.ok(guildLine, "expected discord guild build arg");
      const encoded = guildLine.split("=")[1];
      const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      assert.deepEqual(decoded, {
        "1491590992753590594": {
          requireMention: true,
          users: ["1005536447329222676"],
        },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("patches the staged Dockerfile with Discord guild config that allows all server members", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-discord-open-"),
    );
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        "ARG NEMOCLAW_MESSAGING_CHANNELS_B64=W10=",
        "ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=e30=",
        "ARG NEMOCLAW_DISCORD_GUILDS_B64=e30=",
        "ARG NEMOCLAW_BUILD_ID=default",
      ].join("\n"),
    );

    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:19999",
        "build-discord-open",
        "openai-api",
        null,
        null,
        ["discord"],
        {},
        {
          "1491590992753590594": {
            requireMention: false,
          },
        },
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      const guildLine = patched
        .split("\n")
        .find((line) => line.startsWith("ARG NEMOCLAW_DISCORD_GUILDS_B64="));
      assert.ok(guildLine, "expected discord guild build arg");
      const encoded = guildLine.split("=")[1];
      const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      assert.deepEqual(decoded, {
        "1491590992753590594": {
          requireMention: false,
        },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("maps NVIDIA Endpoints to the routed inference provider", () => {
    assert.deepEqual(
      getSandboxInferenceConfig("qwen/qwen3.5-397b-a17b", "nvidia-prod", "openai-completions"),
      {
        providerKey: "inference",
        primaryModelRef: "inference/qwen/qwen3.5-397b-a17b",
        inferenceBaseUrl: "https://inference.local/v1",
        inferenceApi: "openai-completions",
        inferenceCompat: null,
      },
    );
  });

  it("classifies model-related 404/405 responses as model retries before endpoint retries", () => {
    expect(
      classifyValidationFailure({
        httpStatus: 404,
        message: "HTTP 404: model not found",
      }),
    ).toEqual({ kind: "model", retry: "model" });
    expect(
      classifyValidationFailure({
        httpStatus: 405,
        message: "HTTP 405: unsupported model",
      }),
    ).toEqual({ kind: "model", retry: "model" });
  });

  it("detects tool-calling responses payloads conservatively", () => {
    expect(
      hasResponsesToolCall(
        JSON.stringify({
          output: [
            {
              type: "function_call",
              name: "emit_ok",
              arguments: '{"value":"OK"}',
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      hasResponsesToolCall(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "function_call",
                  name: "emit_ok",
                  arguments: '{"value":"OK"}',
                },
              ],
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      hasResponsesToolCall(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "OK" }],
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(hasResponsesToolCall("{")).toBe(false);
  });

  it("normalizes anthropic-compatible base URLs with a trailing /v1", () => {
    expect(normalizeProviderBaseUrl("https://proxy.example.com/v1", "anthropic")).toBe(
      "https://proxy.example.com",
    );
    expect(normalizeProviderBaseUrl("https://proxy.example.com/v1/messages", "anthropic")).toBe(
      "https://proxy.example.com",
    );
  });

  it("detects loopback dashboard hosts and resolves remote binds correctly", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.0.0.42")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("chat.example.com")).toBe(false);

    expect(resolveDashboardForwardTarget("http://127.0.0.1:18789")).toBe("18789");
    expect(resolveDashboardForwardTarget("http://127.0.0.42:18789")).toBe("18789");
    expect(resolveDashboardForwardTarget("http://[::1]:18789")).toBe("18789");
    expect(resolveDashboardForwardTarget("https://chat.example.com")).toBe("0.0.0.0:18789");
    expect(resolveDashboardForwardTarget("http://10.0.0.25:18789")).toBe("0.0.0.0:18789");
  });

  it("includes a VS Code/WSL dashboard URL when running under WSL", () => {
    const access = getDashboardAccessInfo("the-crucible", {
      token: "secret-token",
      chatUiUrl: "http://127.0.0.1:19999",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      release: "6.6.87.2-microsoft-standard-WSL2",
      runCapture: (command) => (command.includes("hostname -I") ? "172.24.240.1\n" : ""),
    });

    expect(access).toEqual([
      { label: "Dashboard", url: "http://127.0.0.1:19999/#token=secret-token" },
      { label: "VS Code/WSL", url: "http://172.24.240.1:19999/#token=secret-token" },
    ]);
  });

  it("binds the dashboard forward to all interfaces under WSL", () => {
    const command = getDashboardForwardStartCommand("the-crucible", {
      chatUiUrl: "http://127.0.0.1:19999",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      openshellBinary: "/usr/bin/openshell",
      platform: "linux",
      release: "6.6.87.2-microsoft-standard-WSL2",
    });

    expect(command).toContain("forward");
    expect(command).toContain("start");
    expect(command).toContain("--background");
    // On WSL, bind to all interfaces so the Windows-side browser can reach the port.
    // The sandbox image is built with CHAT_UI_URL=http://127.0.0.1:19999, so the
    // gateway listens on 19999 inside the sandbox — openshell maps host:19999 →
    // sandbox:19999 (same port both sides, the only mapping openshell supports).
    expect(command).toContain("0.0.0.0:19999");
    expect(command).toContain("the-crucible");
  });

  it("uses the default port as-is when NEMOCLAW_DASHBOARD_PORT is not overridden", () => {
    const command = getDashboardForwardStartCommand("the-crucible", {
      chatUiUrl: "http://127.0.0.1:18789",
      openshellBinary: "/usr/bin/openshell",
    });

    expect(command).toContain("--background");
    // Default port — forward same port on both sides using the bare port number.
    // Must not regress to all-interfaces (0.0.0.0:18789) or port:port (18789:18789) forms.
    expect(command).toContain("18789");
    expect(command).not.toContain("0.0.0.0:18789");
    expect(command).not.toContain("18789:18789");
    expect(command).toContain("the-crucible");
  });

  it("forwards a custom port as-is on non-WSL loopback", () => {
    const command = getDashboardForwardStartCommand("the-crucible", {
      chatUiUrl: "http://127.0.0.1:19000",
      openshellBinary: "/usr/bin/openshell",
    });

    expect(command).toContain("--background");
    // The gateway is configured to listen on the same port (via CHAT_UI_URL baked at
    // onboard time), so host:19000 → sandbox:19000 is the correct mapping.
    // Non-WSL loopback must use the plain port — not the all-interfaces (0.0.0.0:19000)
    // form and not any port:port variant (openshell does not support asymmetric mapping).
    expect(command).toContain("19000");
    expect(command).not.toContain("0.0.0.0:19000");
    expect(command).not.toContain("19000:19000");
    expect(command).not.toContain("19000:18789");
    expect(command).toContain("the-crucible");
  });

  it("prints platform-appropriate service hints for port conflicts", () => {
    expect(getPortConflictServiceHints("darwin").join("\n")).toMatch(/launchctl unload/);
    expect(getPortConflictServiceHints("darwin").join("\n")).not.toMatch(/systemctl --user/);
    expect(getPortConflictServiceHints("linux").join("\n")).toMatch(
      /systemctl --user stop openclaw-gateway.service/,
    );
  });

  it("patches the staged Dockerfile for Anthropic with anthropic-messages routing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-anthropic-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1",
        "ARG NEMOCLAW_INFERENCE_API=openai-completions",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        "ARG NEMOCLAW_BUILD_ID=default",
      ].join("\n"),
    );

    try {
      patchStagedDockerfile(
        dockerfilePath,
        "claude-sonnet-4-5",
        "http://127.0.0.1:18789",
        "build-claude",
        "anthropic-prod",
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(patched, /^ARG NEMOCLAW_MODEL=claude-sonnet-4-5$/m);
      assert.match(patched, /^ARG NEMOCLAW_PROVIDER_KEY=anthropic$/m);
      assert.match(patched, /^ARG NEMOCLAW_PRIMARY_MODEL_REF=anthropic\/claude-sonnet-4-5$/m);
      assert.match(patched, /^ARG NEMOCLAW_INFERENCE_BASE_URL=https:\/\/inference\.local$/m);
      assert.match(patched, /^ARG NEMOCLAW_INFERENCE_API=anthropic-messages$/m);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("regression #1409: bakes NEMOCLAW_PROXY_HOST/PORT env into the staged Dockerfile", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-proxy-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1",
        "ARG NEMOCLAW_INFERENCE_API=openai-completions",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        "ARG NEMOCLAW_BUILD_ID=default",
        "ARG NEMOCLAW_PROXY_HOST=10.200.0.1",
        "ARG NEMOCLAW_PROXY_PORT=3128",
      ].join("\n"),
    );

    const priorHost = process.env.NEMOCLAW_PROXY_HOST;
    const priorPort = process.env.NEMOCLAW_PROXY_PORT;
    process.env.NEMOCLAW_PROXY_HOST = "1.2.3.4";
    process.env.NEMOCLAW_PROXY_PORT = "9999";
    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:18789",
        "build-proxy",
        "openai-api",
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(patched, /^ARG NEMOCLAW_PROXY_HOST=1\.2\.3\.4$/m);
      assert.match(patched, /^ARG NEMOCLAW_PROXY_PORT=9999$/m);
    } finally {
      if (priorHost === undefined) {
        delete process.env.NEMOCLAW_PROXY_HOST;
      } else {
        process.env.NEMOCLAW_PROXY_HOST = priorHost;
      }
      if (priorPort === undefined) {
        delete process.env.NEMOCLAW_PROXY_PORT;
      } else {
        process.env.NEMOCLAW_PROXY_PORT = priorPort;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("regression #1409: leaves Dockerfile defaults when proxy env is unset", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-proxy-default-"),
    );
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1",
        "ARG NEMOCLAW_INFERENCE_API=openai-completions",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        "ARG NEMOCLAW_BUILD_ID=default",
        "ARG NEMOCLAW_PROXY_HOST=10.200.0.1",
        "ARG NEMOCLAW_PROXY_PORT=3128",
      ].join("\n"),
    );

    const priorHost = process.env.NEMOCLAW_PROXY_HOST;
    const priorPort = process.env.NEMOCLAW_PROXY_PORT;
    delete process.env.NEMOCLAW_PROXY_HOST;
    delete process.env.NEMOCLAW_PROXY_PORT;
    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:18789",
        "build-proxy-default",
        "openai-api",
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      // Defaults must be preserved when no env override is in effect.
      assert.match(patched, /^ARG NEMOCLAW_PROXY_HOST=10\.200\.0\.1$/m);
      assert.match(patched, /^ARG NEMOCLAW_PROXY_PORT=3128$/m);
    } finally {
      if (priorHost !== undefined) process.env.NEMOCLAW_PROXY_HOST = priorHost;
      if (priorPort !== undefined) process.env.NEMOCLAW_PROXY_PORT = priorPort;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("regression #1409: rejects malformed NEMOCLAW_PROXY_HOST/PORT and keeps defaults", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-proxy-bad-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1",
        "ARG NEMOCLAW_INFERENCE_API=openai-completions",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        "ARG NEMOCLAW_BUILD_ID=default",
        "ARG NEMOCLAW_PROXY_HOST=10.200.0.1",
        "ARG NEMOCLAW_PROXY_PORT=3128",
      ].join("\n"),
    );

    const priorHost = process.env.NEMOCLAW_PROXY_HOST;
    const priorPort = process.env.NEMOCLAW_PROXY_PORT;
    // Inject malicious values that could break out of the ARG line if not validated.
    process.env.NEMOCLAW_PROXY_HOST = "1.2.3.4\nRUN rm -rf /";
    process.env.NEMOCLAW_PROXY_PORT = "abcd";
    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:18789",
        "build-proxy-bad",
        "openai-api",
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(patched, /^ARG NEMOCLAW_PROXY_HOST=10\.200\.0\.1$/m);
      assert.match(patched, /^ARG NEMOCLAW_PROXY_PORT=3128$/m);
      assert.doesNotMatch(patched, /RUN rm -rf/);
    } finally {
      if (priorHost === undefined) {
        delete process.env.NEMOCLAW_PROXY_HOST;
      } else {
        process.env.NEMOCLAW_PROXY_HOST = priorHost;
      }
      if (priorPort === undefined) {
        delete process.env.NEMOCLAW_PROXY_PORT;
      } else {
        process.env.NEMOCLAW_PROXY_PORT = priorPort;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("patches the staged Dockerfile with Brave Search config when enabled", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-web-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1",
        "ARG NEMOCLAW_INFERENCE_API=openai-completions",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        "ARG NEMOCLAW_BUILD_ID=default",
      ].join("\n"),
    );

    const priorBraveKey = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = "brv-test-key";
    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:18789",
        "build-web",
        "openai-api",
        null,
        { fetchEnabled: true },
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(patched, /^ARG NEMOCLAW_WEB_SEARCH_ENABLED=1$/m);
      // Regression guard: the old secret-bearing build arg must not reappear.
      assert.doesNotMatch(patched, /NEMOCLAW_WEB_CONFIG_B64/);
    } finally {
      if (priorBraveKey === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = priorBraveKey;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("maps Gemini to the routed inference provider with supportsStore disabled", () => {
    assert.deepEqual(getSandboxInferenceConfig("gemini-2.5-flash", "gemini-api"), {
      providerKey: "inference",
      primaryModelRef: "inference/gemini-2.5-flash",
      inferenceBaseUrl: "https://inference.local/v1",
      inferenceApi: "openai-completions",
      inferenceCompat: {
        supportsStore: false,
      },
    });
  });

  it("uses a probed Responses API override when one is available", () => {
    assert.deepEqual(getSandboxInferenceConfig("gpt-5.4", "openai-api", "openai-responses"), {
      providerKey: "openai",
      primaryModelRef: "openai/gpt-5.4",
      inferenceBaseUrl: "https://inference.local/v1",
      inferenceApi: "openai-responses",
      inferenceCompat: null,
    });
  });

  it("regression #1317: versionGte handles equal, greater, and lesser semvers", () => {
    expect(versionGte("0.1.0", "0.1.0")).toBe(true);
    expect(versionGte("0.1.0", "0.0.20")).toBe(true);
    expect(versionGte("0.0.20", "0.1.0")).toBe(false);
    expect(versionGte("1.2.3", "1.2.4")).toBe(false);
    expect(versionGte("1.2.4", "1.2.3")).toBe(true);
    expect(versionGte("0.0.21", "0.0.20")).toBe(true);
    // Defensive: missing components default to 0
    expect(versionGte("1.0", "1.0.0")).toBe(true);
    expect(versionGte("", "0.0.0")).toBe(true);
  });

  it("regression #1317: getBlueprintMinOpenshellVersion reads min_openshell_version from blueprint.yaml", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-min-version-"));
    const blueprintDir = path.join(tmpDir, "nemoclaw-blueprint");
    fs.mkdirSync(blueprintDir, { recursive: true });
    fs.writeFileSync(
      path.join(blueprintDir, "blueprint.yaml"),
      [
        'version: "0.1.0"',
        'min_openshell_version: "0.1.0"',
        'min_openclaw_version: "2026.3.0"',
      ].join("\n"),
    );
    try {
      expect(getBlueprintMinOpenshellVersion(tmpDir)).toBe("0.1.0");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("regression #1317: getBlueprintMinOpenshellVersion returns null on missing or unparseable blueprint", () => {
    // Missing directory
    const missingDir = path.join(
      os.tmpdir(),
      "nemoclaw-blueprint-missing-" + Date.now().toString(),
    );
    expect(getBlueprintMinOpenshellVersion(missingDir)).toBe(null);

    // Present file, missing field — must NOT block onboard
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-no-field-"));
    const blueprintDir = path.join(tmpDir, "nemoclaw-blueprint");
    fs.mkdirSync(blueprintDir, { recursive: true });
    fs.writeFileSync(path.join(blueprintDir, "blueprint.yaml"), 'version: "0.1.0"\n');
    try {
      expect(getBlueprintMinOpenshellVersion(tmpDir)).toBe(null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Present file, malformed YAML — must NOT throw, just return null
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-bad-yaml-"));
    const badBlueprintDir = path.join(badDir, "nemoclaw-blueprint");
    fs.mkdirSync(badBlueprintDir, { recursive: true });
    fs.writeFileSync(path.join(badBlueprintDir, "blueprint.yaml"), "this is: : not valid: yaml: [");
    try {
      expect(getBlueprintMinOpenshellVersion(badDir)).toBe(null);
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }

    // Present file, non-string value (yaml parses unquoted 1.5 as number) —
    // must NOT block onboard, just return null
    const wrongTypeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-wrong-type-"));
    const wrongTypeBlueprintDir = path.join(wrongTypeDir, "nemoclaw-blueprint");
    fs.mkdirSync(wrongTypeBlueprintDir, { recursive: true });
    fs.writeFileSync(
      path.join(wrongTypeBlueprintDir, "blueprint.yaml"),
      "min_openshell_version: 1.5\n",
    );
    try {
      expect(getBlueprintMinOpenshellVersion(wrongTypeDir)).toBe(null);
    } finally {
      fs.rmSync(wrongTypeDir, { recursive: true, force: true });
    }

    // Present file, string value that doesn't look like x.y.z — must NOT
    // block onboard. Defends against typos like "latest" or "0.1".
    const badShapeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-bad-shape-"));
    const badShapeBlueprintDir = path.join(badShapeDir, "nemoclaw-blueprint");
    fs.mkdirSync(badShapeBlueprintDir, { recursive: true });
    fs.writeFileSync(
      path.join(badShapeBlueprintDir, "blueprint.yaml"),
      'min_openshell_version: "latest"\n',
    );
    try {
      expect(getBlueprintMinOpenshellVersion(badShapeDir)).toBe(null);
    } finally {
      fs.rmSync(badShapeDir, { recursive: true, force: true });
    }
  });

  it("regression #1317: shipped blueprint.yaml exposes a parseable min_openshell_version", () => {
    // Sanity check against the real on-disk blueprint so a future edit that
    // accidentally drops or breaks the field is caught by CI rather than at
    // a user's onboard time.
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const v = getBlueprintMinOpenshellVersion(repoRoot);
    expect(v).not.toBe(null);
    expect(/^[0-9]+\.[0-9]+\.[0-9]+/.test(v)).toBe(true);
  });

  it("getBlueprintMaxOpenshellVersion reads max_openshell_version from blueprint.yaml", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-max-version-"));
    const blueprintDir = path.join(tmpDir, "nemoclaw-blueprint");
    fs.mkdirSync(blueprintDir, { recursive: true });
    fs.writeFileSync(
      path.join(blueprintDir, "blueprint.yaml"),
      [
        'version: "0.1.0"',
        'min_openshell_version: "0.0.24"',
        'max_openshell_version: "0.0.26"',
        'min_openclaw_version: "2026.3.0"',
      ].join("\n"),
    );
    try {
      expect(getBlueprintMaxOpenshellVersion(tmpDir)).toBe("0.0.26");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("getBlueprintMaxOpenshellVersion returns null on missing or unparseable blueprint", () => {
    // Missing directory
    const missingDir = path.join(
      os.tmpdir(),
      "nemoclaw-blueprint-max-missing-" + Date.now().toString(),
    );
    expect(getBlueprintMaxOpenshellVersion(missingDir)).toBe(null);

    // Present file, missing field — must NOT block onboard
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-no-max-field-"));
    const blueprintDir = path.join(tmpDir, "nemoclaw-blueprint");
    fs.mkdirSync(blueprintDir, { recursive: true });
    fs.writeFileSync(path.join(blueprintDir, "blueprint.yaml"), 'version: "0.1.0"\n');
    try {
      expect(getBlueprintMaxOpenshellVersion(tmpDir)).toBe(null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shipped blueprint.yaml exposes a parseable max_openshell_version", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const v = getBlueprintMaxOpenshellVersion(repoRoot);
    expect(v).not.toBe(null);
    expect(/^[0-9]+\.[0-9]+\.[0-9]+/.test(v)).toBe(true);
  });

  it("max_openshell_version is greater than or equal to min_openshell_version in shipped blueprint", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const min = getBlueprintMinOpenshellVersion(repoRoot);
    const max = getBlueprintMaxOpenshellVersion(repoRoot);
    expect(min).not.toBe(null);
    expect(max).not.toBe(null);
    expect(versionGte(max, min)).toBe(true);
  });

  it("pins the gateway image to the installed OpenShell release version", () => {
    expect(getInstalledOpenshellVersion("openshell 0.0.12")).toBe("0.0.12");
    expect(getInstalledOpenshellVersion("openshell 0.0.13-dev.8+gbbcaed2ea")).toBe("0.0.13");
    expect(getInstalledOpenshellVersion("bogus")).toBe(null);
    expect(getStableGatewayImageRef("openshell 0.0.12")).toBe(
      "ghcr.io/nvidia/openshell/cluster:0.0.12",
    );
    expect(getStableGatewayImageRef("openshell 0.0.13-dev.8+gbbcaed2ea")).toBe(
      "ghcr.io/nvidia/openshell/cluster:0.0.13",
    );
    expect(getStableGatewayImageRef("bogus")).toBe(null);
  });

  it("treats the gateway as healthy only when nemoclaw is running and connected", () => {
    expect(
      isGatewayHealthy(
        "Gateway status: Connected\nGateway: nemoclaw",
        "Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: https://127.0.0.1:8080",
        "Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: https://127.0.0.1:8080",
      ),
    ).toBe(true);
    expect(
      isGatewayHealthy(
        "\u001b[1mServer Status\u001b[0m\n\n  Gateway: openshell\n  Server: https://127.0.0.1:8080\n  Status: Connected",
        "Error:   × No gateway metadata found for 'nemoclaw'.",
        "Gateway Info\n\n  Gateway: openshell\n  Gateway endpoint: https://127.0.0.1:8080",
      ),
    ).toBe(false);
    expect(
      isGatewayHealthy(
        "Server Status\n\n  Gateway: openshell\n  Status: Connected",
        "Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: https://127.0.0.1:8080",
        "Gateway Info\n\n  Gateway: openshell\n  Gateway endpoint: https://127.0.0.1:8080",
      ),
    ).toBe(false);
    expect(isGatewayHealthy("Gateway status: Disconnected", "Gateway: nemoclaw")).toBe(false);
    expect(isGatewayHealthy("Gateway status: Connected", "Gateway: something-else")).toBe(false);
  });

  it("passes --port GATEWAY_PORT through every gateway start path", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );

    // Primary start path (startGatewayWithOptions) builds gwArgs with --port.
    assert.match(
      source,
      /const gwArgs = \["--name", GATEWAY_NAME, "--port", String\(GATEWAY_PORT\)\]/,
    );

    // Recovery start path (recoverGatewayRuntime) also passes --port.
    assert.match(
      source,
      /runOpenshell\(\s*\["gateway", "start", "--name", GATEWAY_NAME, "--port", String\(GATEWAY_PORT\)\]/,
    );
  });

  it("classifies gateway reuse states conservatively", () => {
    expect(
      getGatewayReuseState(
        "Gateway status: Connected\nGateway: nemoclaw",
        "Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: https://127.0.0.1:8080",
        "Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: https://127.0.0.1:8080",
      ),
    ).toBe("healthy");
    expect(
      getGatewayReuseState(
        "Gateway status: Connected",
        "Error:   × No gateway metadata found for 'nemoclaw'.",
        "Gateway Info\n\n  Gateway: openshell\n  Gateway endpoint: https://127.0.0.1:8080",
      ),
    ).toBe("foreign-active");
    expect(
      getGatewayReuseState(
        "Server Status\n\n  Gateway: openshell\n  Status: Connected",
        "Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: https://127.0.0.1:8080",
        "Gateway Info\n\n  Gateway: openshell\n  Gateway endpoint: https://127.0.0.1:8080",
      ),
    ).toBe("foreign-active");
    expect(
      getGatewayReuseState(
        "Gateway status: Disconnected",
        "Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: https://127.0.0.1:8080",
      ),
    ).toBe("stale");
    expect(
      getGatewayReuseState(
        "Gateway status: Connected\nGateway: nemoclaw",
        "",
        "Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: https://127.0.0.1:8080",
      ),
    ).toBe("healthy");
    expect(
      getGatewayReuseState(
        "Gateway status: Connected",
        "",
        "Gateway Info\n\n  Gateway: openshell\n  Gateway endpoint: https://127.0.0.1:8080",
      ),
    ).toBe("foreign-active");
    expect(getGatewayReuseState("", "")).toBe("missing");
  });

  it("prints doctor logs automatically when gateway fails to start (#1605)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-diag-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "gateway-diag.cjs");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    // Fake openshell:
    //   gateway start  — emits ANSI color codes + \r\n (mirrors real gateway output), exits 1
    //   doctor logs    — emits ANSI sequences, an OOMKilled message, and a fake nvapi- credential
    //                    to exercise ANSI stripping and redaction in the doctor-log path
    fs.writeFileSync(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [[ "$*" == *"doctor"*"logs"* ]]; then
  printf "\\033[31mERROR\\033[0m k3s cluster crashed: OOMKilled\\r\\n"
  printf "  Container nemoclaw_k3s ran out of memory\\r\\n"
  printf "  Gateway auth token: nvapi-fakecredential-9999\\r\\n"
  exit 0
fi
if [[ "$*" == *"gateway"*"start"* ]]; then
  printf "\\033[33mDeploying\\033[0m gateway nemoclaw...\\r\\n"
  printf "\\r\\nWaiting for gateway health...\\r\\n"
  exit 1
fi
exit 1
`,
      { mode: 0o755 },
    );

    // Script runs in a child process: patching p-retry to be immediate avoids the
    // 10 s + 30 s minTimeout delays, and NEMOCLAW_HEALTH_POLL_COUNT=0 skips the
    // health-poll loop so the function throws "Gateway failed to start" on the
    // first attempt. With exitOnFailure:true the catch block should auto-print
    // doctor logs to stderr and then call process.exit(1).
    const script = `
const mod = require("module");
const origLoad = mod._load;
mod._load = function(req, parent, isMain) {
  if (req === "p-retry") {
    return async (fn, opts) => {
      try {
        return await fn({ attemptNumber: 1, retriesLeft: 0 });
      } catch (e) {
        if (opts && opts.onFailedAttempt) {
          opts.onFailedAttempt(Object.assign(e, { attemptNumber: 1, retriesLeft: 0 }));
        }
        throw e;
      }
    };
  }
  return origLoad.call(this, req, parent, isMain);
};
const { startGateway } = require(${onboardPath});
startGateway(null).catch(() => {});
`;
    fs.writeFileSync(scriptPath, script);

    const nodeExec = process.execPath;
    const result = spawnSync(nodeExec, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_HEALTH_POLL_COUNT: "0",
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    // The process exits 1 because startGateway calls process.exit(1) on failure.
    assert.equal(result.status, 1, `unexpected exit code; stderr:\n${result.stderr}`);

    // Fix 3: doctor logs are auto-printed to stderr.
    assert.ok(
      result.stderr.includes("Gateway logs:"),
      `expected "Gateway logs:" header in stderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes("OOMKilled"),
      `expected doctor log output in stderr:\n${result.stderr}`,
    );

    // ANSI sequences must be stripped from both stdout (gateway start output) and
    // stderr (doctor logs). A raw \x1b in the output means the regex failed.
    assert.ok(
      !result.stdout.includes("\x1b"),
      `unexpected ANSI escape in stdout:\n${result.stdout}`,
    );
    assert.ok(
      !result.stderr.includes("\x1b"),
      `unexpected ANSI escape in stderr:\n${result.stderr}`,
    );

    // Credentials in doctor logs must be redacted, never printed verbatim.
    assert.ok(
      !result.stderr.includes("nvapi-fakecredential-9999"),
      `credential leaked verbatim in stderr:\n${result.stderr}`,
    );

    // Fix 2: the \r\n -> \naiting rendering artifact must not appear.
    assert.ok(
      !result.stdout.includes("\naiting"),
      `\\naiting artifact present in stdout:\n${result.stdout}`,
    );

    // Fix 1: gateway start output is printed per-line under the header, not as
    // one collapsed blob. "Deploying" and "Waiting" must appear on separate lines.
    const gatewayLines = result.stdout
      .split("\n")
      .filter((l) => l.includes("Deploying") || l.includes("Waiting"));
    assert.ok(
      gatewayLines.length >= 2,
      `expected "Deploying" and "Waiting" on separate lines in stdout:\n${result.stdout}`,
    );
  });

  it("classifies sandbox reuse states from openshell outputs", () => {
    expect(
      getSandboxStateFromOutputs(
        "my-assistant",
        "Name: my-assistant",
        "my-assistant   Ready   2m ago",
      ),
    ).toBe("ready");
    expect(
      getSandboxStateFromOutputs(
        "my-assistant",
        "Name: my-assistant",
        "my-assistant   NotReady   init failed",
      ),
    ).toBe("not_ready");
    expect(getSandboxStateFromOutputs("my-assistant", "", "")).toBe("missing");
  });

  it("filters local-only artifacts out of the sandbox build context", () => {
    expect(
      shouldIncludeBuildContextPath(
        "/repo/nemoclaw-blueprint",
        "/repo/nemoclaw-blueprint/orchestrator/main.py",
      ),
    ).toBe(true);
    expect(
      shouldIncludeBuildContextPath(
        "/repo/nemoclaw-blueprint",
        "/repo/nemoclaw-blueprint/.venv/bin/python",
      ),
    ).toBe(false);
    expect(
      shouldIncludeBuildContextPath(
        "/repo/nemoclaw-blueprint",
        "/repo/nemoclaw-blueprint/.ruff_cache/cache",
      ),
    ).toBe(false);
    expect(
      shouldIncludeBuildContextPath(
        "/repo/nemoclaw-blueprint",
        "/repo/nemoclaw-blueprint/._pyvenv.cfg",
      ),
    ).toBe(false);
  });

  it("normalizes sandbox name hints from the environment", () => {
    const previous = process.env.NEMOCLAW_SANDBOX_NAME;
    process.env.NEMOCLAW_SANDBOX_NAME = "  My-Assistant  ";
    try {
      expect(getRequestedSandboxNameHint()).toBe("my-assistant");
    } finally {
      if (previous === undefined) {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      } else {
        process.env.NEMOCLAW_SANDBOX_NAME = previous;
      }
    }
  });

  it("detects resume conflicts when a different sandbox is requested", () => {
    const previous = process.env.NEMOCLAW_SANDBOX_NAME;
    process.env.NEMOCLAW_SANDBOX_NAME = "other-sandbox";
    try {
      expect(getResumeSandboxConflict({ sandboxName: "my-assistant" })).toEqual({
        requestedSandboxName: "other-sandbox",
        recordedSandboxName: "my-assistant",
      });
      expect(getResumeSandboxConflict({ sandboxName: "other-sandbox" })).toBe(null);
    } finally {
      if (previous === undefined) {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      } else {
        process.env.NEMOCLAW_SANDBOX_NAME = previous;
      }
    }
  });

  it("returns provider and model hints only for non-interactive runs", () => {
    const previousProvider = process.env.NEMOCLAW_PROVIDER;
    const previousModel = process.env.NEMOCLAW_MODEL;
    process.env.NEMOCLAW_PROVIDER = "cloud";
    process.env.NEMOCLAW_MODEL = "nvidia/test-model";
    try {
      expect(getRequestedProviderHint(true)).toBe("build");
      expect(getRequestedModelHint(true)).toBe("nvidia/test-model");
      expect(getRequestedProviderHint(false)).toBe(null);
      expect(getRequestedModelHint(false)).toBe(null);
    } finally {
      if (previousProvider === undefined) {
        delete process.env.NEMOCLAW_PROVIDER;
      } else {
        process.env.NEMOCLAW_PROVIDER = previousProvider;
      }
      if (previousModel === undefined) {
        delete process.env.NEMOCLAW_MODEL;
      } else {
        process.env.NEMOCLAW_MODEL = previousModel;
      }
    }
  });

  it("detects resume conflicts for explicit provider and model changes", () => {
    const previousProvider = process.env.NEMOCLAW_PROVIDER;
    const previousModel = process.env.NEMOCLAW_MODEL;
    process.env.NEMOCLAW_PROVIDER = "cloud";
    process.env.NEMOCLAW_MODEL = "nvidia/other-model";
    try {
      // Provider conflict uses a two-stage alias chain in non-interactive mode:
      // "cloud" first resolves to the requested hint, then that hint resolves
      // to the effective provider name "nvidia-prod" for conflict comparison.
      expect(
        getResumeConfigConflicts(
          {
            sandboxName: "my-assistant",
            provider: "nvidia-nim",
            model: "nvidia/nemotron-3-super-120b-a12b",
          },
          { nonInteractive: true },
        ),
      ).toEqual([
        {
          field: "provider",
          requested: "nvidia-prod",
          recorded: "nvidia-nim",
        },
        {
          field: "model",
          requested: "nvidia/other-model",
          recorded: "nvidia/nemotron-3-super-120b-a12b",
        },
      ]);
    } finally {
      if (previousProvider === undefined) {
        delete process.env.NEMOCLAW_PROVIDER;
      } else {
        process.env.NEMOCLAW_PROVIDER = previousProvider;
      }
      if (previousModel === undefined) {
        delete process.env.NEMOCLAW_MODEL;
      } else {
        process.env.NEMOCLAW_MODEL = previousModel;
      }
    }
  });

  it("detects resume conflicts when a different agent is requested", () => {
    expect(
      getResumeConfigConflicts(
        {
          sandboxName: "my-assistant",
          agent: "openclaw",
        },
        { agent: "hermes" },
      ),
    ).toEqual([
      {
        field: "agent",
        requested: "hermes",
        recorded: "openclaw",
      },
    ]);
  });

  it("allows resume when requested agent matches recorded agent", () => {
    expect(
      getResumeConfigConflicts(
        {
          sandboxName: "my-assistant",
          agent: "hermes",
        },
        { agent: "hermes" },
      ),
    ).toEqual([]);
  });

  it("returns a future-shell PATH hint for user-local openshell installs", () => {
    expect(getFutureShellPathHint("/home/test/.local/bin", "/usr/local/bin:/usr/bin")).toBe(
      'export PATH="/home/test/.local/bin:$PATH"',
    );
  });

  it("skips the future-shell PATH hint when the bin dir is already on PATH", () => {
    expect(
      getFutureShellPathHint(
        "/home/test/.local/bin",
        "/home/test/.local/bin:/usr/local/bin:/usr/bin",
      ),
    ).toBe(null);
  });

  it("writes sandbox sync scripts to a temp file for stdin redirection", () => {
    const scriptFile = writeSandboxConfigSyncFile("echo test");
    try {
      expect(scriptFile).toMatch(/nemoclaw-sync.*\.sh$/);
      expect(fs.readFileSync(scriptFile, "utf8")).toBe("echo test\n");
      // Verify the file lives inside a mkdtemp-created directory (not directly in /tmp)
      const parentDir = path.dirname(scriptFile);
      expect(parentDir).not.toBe(os.tmpdir());
      expect(parentDir).toContain("nemoclaw-sync");
      if (process.platform !== "win32") {
        const stat = fs.statSync(scriptFile);
        expect(stat.mode & 0o777).toBe(0o600);
      }
    } finally {
      // mirrors cleanupTempDir() — inline guard to safely remove mkdtemp directory
      const parentDir = path.dirname(scriptFile);
      if (parentDir !== os.tmpdir() && path.basename(parentDir).startsWith("nemoclaw-sync-")) {
        fs.rmSync(parentDir, { recursive: true, force: true });
      }
    }
  });

  it("stages only the files required to build the sandbox image", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-"));

    try {
      const { buildCtx, stagedDockerfile } = stageOptimizedSandboxBuildContext(repoRoot, tmpDir);

      expect(stagedDockerfile).toBe(path.join(buildCtx, "Dockerfile"));
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw", "package-lock.json"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw", "src"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw-blueprint", ".venv"))).toBe(false);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "nemoclaw-start.sh"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "setup.sh"))).toBe(false);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw", "node_modules"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("formatEnvAssignment produces NAME=VALUE pairs for sandbox env", () => {
    expect(formatEnvAssignment("CHAT_UI_URL", "http://127.0.0.1:18789")).toBe(
      "CHAT_UI_URL=http://127.0.0.1:18789",
    );
    expect(formatEnvAssignment("EMPTY", "")).toBe("EMPTY=");
  });

  it("compactText collapses whitespace and trims leading/trailing space", () => {
    expect(compactText("  gateway   unreachable  ")).toBe("gateway unreachable");
    expect(compactText("")).toBe("");
    expect(compactText()).toBe("");
    expect(compactText("single")).toBe("single");
    expect(compactText("line1\n  line2\t\tline3")).toBe("line1 line2 line3");
  });

  it("getNavigationChoice recognizes back and exit commands case-insensitively", () => {
    expect(getNavigationChoice("back")).toBe("back");
    expect(getNavigationChoice("BACK")).toBe("back");
    expect(getNavigationChoice("  Back  ")).toBe("back");
    expect(getNavigationChoice("exit")).toBe("exit");
    expect(getNavigationChoice("quit")).toBe("exit");
    expect(getNavigationChoice("QUIT")).toBe("exit");
    expect(getNavigationChoice("")).toBeNull();
    expect(getNavigationChoice("something")).toBeNull();
    expect(getNavigationChoice(null)).toBeNull();
  });

  it("parsePolicyPresetEnv splits comma-separated preset names and trims whitespace", () => {
    expect(parsePolicyPresetEnv("strict,standard")).toEqual(["strict", "standard"]);
    expect(parsePolicyPresetEnv("  strict , standard , ")).toEqual(["strict", "standard"]);
    expect(parsePolicyPresetEnv("")).toEqual([]);
    expect(parsePolicyPresetEnv(null)).toEqual([]);
    expect(parsePolicyPresetEnv("single")).toEqual(["single"]);
  });

  it("summarizeCurlFailure formats curl errors with exit code and truncated detail", () => {
    expect(summarizeCurlFailure(7, "Connection refused", "")).toBe(
      "curl failed (exit 7): Connection refused",
    );
    expect(summarizeCurlFailure(28, "", "")).toBe("curl failed (exit 28)");
    expect(summarizeCurlFailure(0, "", "")).toBe("curl failed (exit 0)");
  });

  it("summarizeProbeFailure prioritizes curl failures then HTTP status then generic message", () => {
    // curl failure takes precedence
    expect(summarizeProbeFailure("body", 500, 7, "Connection refused")).toBe(
      "curl failed (exit 7): Connection refused",
    );
    // HTTP error when no curl failure
    expect(summarizeProbeFailure("Not Found", 404, 0, "")).toBe("HTTP 404: Not Found");
    // Fallback: no curl failure and no body → HTTP status with no body message
    expect(summarizeProbeFailure("", 0, 0, "")).toBe("HTTP 0 with no response body");
    // Non-JSON body gets compacted and returned
    expect(summarizeProbeFailure("  Service  Unavailable  ", 503, 0, "")).toBe(
      "HTTP 503: Service Unavailable",
    );
  });

  it("buildProviderArgs produces correct create arguments for generic providers", () => {
    const args = buildProviderArgs(
      "create",
      "discord-bridge",
      "generic",
      "DISCORD_BOT_TOKEN",
      null,
    );
    expect(args).toEqual([
      "provider",
      "create",
      "--name",
      "discord-bridge",
      "--type",
      "generic",
      "--credential",
      "DISCORD_BOT_TOKEN",
    ]);
  });

  it("buildProviderArgs produces correct update arguments", () => {
    const args = buildProviderArgs("update", "inference", "openai", "NVIDIA_API_KEY", null);
    expect(args).toEqual(["provider", "update", "inference", "--credential", "NVIDIA_API_KEY"]);
  });

  it("buildProviderArgs appends OPENAI_BASE_URL config for openai providers with a base URL", () => {
    const args = buildProviderArgs(
      "create",
      "inference",
      "openai",
      "NVIDIA_API_KEY",
      "https://api.example.com/v1",
    );
    expect(args).toContain("--config");
    expect(args).toContain("OPENAI_BASE_URL=https://api.example.com/v1");
  });

  it("buildProviderArgs appends ANTHROPIC_BASE_URL config for anthropic providers with a base URL", () => {
    const args = buildProviderArgs(
      "create",
      "inference",
      "anthropic",
      "ANTHROPIC_API_KEY",
      "https://api.anthropic.example.com",
    );
    expect(args).toContain("--config");
    expect(args).toContain("ANTHROPIC_BASE_URL=https://api.anthropic.example.com");
  });

  it("buildProviderArgs ignores base URL for generic providers", () => {
    const args = buildProviderArgs(
      "create",
      "slack-bridge",
      "generic",
      "SLACK_BOT_TOKEN",
      "https://ignored.example.com",
    );
    expect(args).not.toContain("--config");
  });

  it("rejects sandbox names starting with a digit", () => {
    // The validation regex must require names to start with a letter,
    // not a digit — Kubernetes rejects digit-prefixed names downstream.
    const SANDBOX_NAME_REGEX = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

    expect(SANDBOX_NAME_REGEX.test("my-assistant")).toBe(true);
    expect(SANDBOX_NAME_REGEX.test("a")).toBe(true);
    expect(SANDBOX_NAME_REGEX.test("agent-1")).toBe(true);
    expect(SANDBOX_NAME_REGEX.test("test-sandbox-v2")).toBe(true);

    expect(SANDBOX_NAME_REGEX.test("7racii")).toBe(false);
    expect(SANDBOX_NAME_REGEX.test("1sandbox")).toBe(false);
    expect(SANDBOX_NAME_REGEX.test("123")).toBe(false);
    expect(SANDBOX_NAME_REGEX.test("-start-hyphen")).toBe(false);
    expect(SANDBOX_NAME_REGEX.test("end-hyphen-")).toBe(false);
    expect(SANDBOX_NAME_REGEX.test("")).toBe(false);
  });

  it("passes credential names to openshell without embedding secret values in argv", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-inference-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-inference-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("inference") && command.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: nvidia-nim",
      "  Model: nvidia/nemotron-3-super-120b-a12b",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.NVIDIA_API_KEY = "nvapi-secret-value";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "nvidia/nemotron-3-super-120b-a12b", "nvidia-nim");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    expect(result.status).toBe(0);
    const commands = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(commands.length, 4);
    assert.match(commands[0].command, /gateway' 'select' 'nemoclaw'/);
    assert.match(commands[1].command, /'provider' 'get'/);
    assert.match(commands[2].command, /'--credential' 'NVIDIA_API_KEY'/);
    assert.doesNotMatch(commands[2].command, /nvapi-secret-value/);
    assert.match(commands[2].command, /provider' 'update'/);
    assert.match(commands[3].command, /inference' 'set'/);
  });

  it("detects when the live inference route already matches the requested provider and model", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-inference-ready-"));
    const fakeOpenshell = path.join(tmpDir, "openshell");
    const scriptPath = path.join(tmpDir, "inference-ready-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    fs.writeFileSync(
      fakeOpenshell,
      `#!/usr/bin/env bash
if [ "$1" = "inference" ] && [ "$2" = "get" ]; then
  cat <<'EOF'
Gateway inference:

  Route: inference.local
  Provider: nvidia-prod
  Model: nvidia/nemotron-3-super-120b-a12b
  Version: 1
EOF
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );

    fs.writeFileSync(
      scriptPath,
      `
const { isInferenceRouteReady } = require(${onboardPath});
console.log(JSON.stringify({
  same: isInferenceRouteReady("nvidia-prod", "nvidia/nemotron-3-super-120b-a12b"),
  otherModel: isInferenceRouteReady("nvidia-prod", "nvidia/other-model"),
  otherProvider: isInferenceRouteReady("openai-api", "nvidia/nemotron-3-super-120b-a12b"),
}));
`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${tmpDir}:${process.env.PATH || ""}`,
      },
    });

    try {
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        same: true,
        otherModel: false,
        otherProvider: false,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects when OpenClaw is already configured inside the sandbox", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-ready-"));
    const fakeOpenshell = path.join(tmpDir, "openshell");
    const scriptPath = path.join(tmpDir, "openclaw-ready-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    fs.writeFileSync(
      fakeOpenshell,
      `#!/usr/bin/env bash
if [ "$1" = "sandbox" ] && [ "$2" = "download" ]; then
  dest="\${@: -1}"
  mkdir -p "$dest/sandbox/.openclaw"
  cat > "$dest/sandbox/.openclaw/openclaw.json" <<'EOF'
{"gateway":{"auth":{"token":"test-token"}}}
EOF
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );

    fs.writeFileSync(
      scriptPath,
      `
const { isOpenclawReady } = require(${onboardPath});
console.log(JSON.stringify({
  ready: isOpenclawReady("my-assistant"),
}));
`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${tmpDir}:${process.env.PATH || ""}`,
      },
    });

    try {
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ ready: true });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects when recorded policy presets are already applied", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-ready-"));
    const registryDir = path.join(tmpDir, ".nemoclaw");
    const registryFile = path.join(registryDir, "sandboxes.json");
    const scriptPath = path.join(tmpDir, "policy-ready-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      registryFile,
      JSON.stringify(
        {
          sandboxes: {
            "my-assistant": {
              name: "my-assistant",
              policies: ["pypi", "npm"],
            },
          },
          defaultSandbox: "my-assistant",
        },
        null,
        2,
      ),
    );

    fs.writeFileSync(
      scriptPath,
      `
const { arePolicyPresetsApplied } = require(${onboardPath});
console.log(JSON.stringify({
  ready: arePolicyPresetsApplied("my-assistant", ["pypi", "npm"]),
  missing: arePolicyPresetsApplied("my-assistant", ["pypi", "slack"]),
  empty: arePolicyPresetsApplied("my-assistant", []),
}));
`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
      },
    });

    try {
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      expect(payload).toEqual({
        ready: true,
        missing: false,
        empty: false,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses native Anthropic provider creation without embedding the secret in argv", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-anthropic-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-anthropic-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  // provider-get returns not-found so we exercise the create path
  if (command.includes("'provider' 'get'")) return { status: 1 };
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("inference") && command.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: anthropic-prod",
      "  Model: claude-sonnet-4-5",
      "  Version: 1",
    ].join("\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.ANTHROPIC_API_KEY = "sk-ant-secret-value";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "claude-sonnet-4-5", "anthropic-prod", "https://api.anthropic.com", "ANTHROPIC_API_KEY");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(commands.length, 4);
    assert.match(commands[0].command, /gateway' 'select' 'nemoclaw'/);
    assert.match(commands[1].command, /'provider' 'get'/);
    assert.match(commands[2].command, /'--type' 'anthropic'/);
    assert.match(commands[2].command, /'--credential' 'ANTHROPIC_API_KEY'/);
    assert.doesNotMatch(commands[2].command, /sk-ant-secret-value/);
    assert.match(commands[3].command, /'--provider' 'anthropic-prod'/);
  });

  it("updates OpenAI-compatible providers without passing an unsupported --type flag", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-openai-update-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-openai-update-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("inference") && command.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
    ].join("\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.OPENAI_API_KEY = "sk-secret-value";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(commands.length, 4);
    assert.match(commands[0].command, /gateway' 'select' 'nemoclaw'/);
    assert.match(commands[1].command, /'provider' 'get'/);
    assert.match(commands[2].command, /provider' 'update' 'openai-api'/);
    assert.doesNotMatch(commands[2].command, /'--type'/);
    assert.match(commands[3].command, /inference' 'set' '--no-verify'/);
  });

  it("re-prompts for credentials when openshell inference set fails with authorization errors", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-apply-auth-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-inference-auth-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const credentials = require(${credentialsPath});

const commands = [];
const answers = ["retry", "sk-good"];
let inferenceSetCalls = 0;

credentials.prompt = async () => answers.shift() || "";
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  if (command.includes("'inference' 'set'")) {
    inferenceSetCalls += 1;
    if (inferenceSetCalls === 1) {
      return { status: 1, stdout: "", stderr: "HTTP 403: forbidden" };
    }
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  if (command.includes("inference") && command.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.OPENAI_API_KEY = "sk-bad";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify({ commands, key: process.env.OPENAI_API_KEY, inferenceSetCalls }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(payload.key, "sk-good");
    assert.equal(payload.inferenceSetCalls, 2);
    const providerEnvs = payload.commands
      .filter((entry) => entry.command.includes("'provider'"))
      .map((entry) => entry.env && entry.env.OPENAI_API_KEY)
      .filter(Boolean);
    assert.deepEqual(providerEnvs, ["sk-bad", "sk-good"]);
  });

  it("returns control to provider selection when inference apply recovery chooses back", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-apply-back-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-inference-apply-back-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const credentials = require(${credentialsPath});

const commands = [];
credentials.prompt = async () => "back";
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  if (command.includes("'inference' 'set'")) {
    return { status: 1, stdout: "", stderr: "HTTP 404: model not found" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = () => "";
registry.updateSandbox = () => true;

process.env.OPENAI_API_KEY = "sk-secret-value";

const { setupInference } = require(${onboardPath});

(async () => {
  const result = await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify({ result, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.deepEqual(payload.result, { retry: "selection" });
    assert.equal(
      payload.commands.filter((entry) => entry.command.includes("'inference' 'set'")).length,
      1,
    );
  });

  it("uses split curl timeout args and does not mislabel curl usage errors as timeouts", () => {
    const onboardSource = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );
    const probeSource = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "http-probe.ts"),
      "utf-8",
    );
    const recoverySource = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "validation-recovery.ts"),
      "utf-8",
    );

    assert.match(onboardSource, /http-probe/);
    assert.match(probeSource, /return \["--connect-timeout", "10", "--max-time", "60"\];/);
    assert.match(recoverySource, /failure\.curlStatus === 2/);
    assert.match(recoverySource, /local curl invocation error/);
  });

  it("checks provider existence before create/update to avoid AlreadyExists noise (#1155)", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );

    // upsertProvider must check existence first so it never triggers AlreadyExists.
    assert.match(source, /providerExistsInGateway\(name\)/);
    assert.match(source, /exists \? "update" : "create"/);
    // Only one openshell call should be made (no create-then-update fallback).
    assert.match(source, /const result = runOpenshell\(args, runOpts\)/);
  });

  it("marks the unused agent_setup/openclaw sibling step as skipped (#1834)", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );

    // When agent path is taken, openclaw must be marked skipped.
    assert.match(source, /handleAgentSetup[\s\S]*?markStepSkipped\("openclaw"\)/);
    // When default openclaw path is taken, agent_setup must be marked skipped.
    assert.match(source, /setupOpenclaw[\s\S]*?markStepSkipped\("agent_setup"\)/);
  });

  it("starts the sandbox step before prompting for the sandbox name", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );

    assert.match(
      source,
      /startRecordedStep\("sandbox", \{ sandboxName, provider, model \}\);\s*selectedMessagingChannels = await setupMessagingChannels\(\);\s*onboardSession\.updateSession\(\(current\) => \{\s*current\.messagingChannels = selectedMessagingChannels;\s*return current;\s*\}\);\s*sandboxName = await createSandbox\(\s*gpu,\s*model,\s*provider,\s*preferredInferenceApi,\s*sandboxName,\s*webSearchConfig,\s*selectedMessagingChannels,\s*fromDockerfile,\s*agent,\s*dangerouslySkipPermissions,\s*\);/,
    );
  });

  it("prints numbered step headers even when onboarding skips resumed steps", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );

    assert.match(source, /const ONBOARD_STEP_INDEX = \{/);
    assert.match(source, /function skippedStepMessage\(stepName, detail, reason = "resume"\)/);
    assert.match(source, /step\(stepInfo\.number, 8, stepInfo\.title\);/);
    assert.match(source, /skippedStepMessage\("openclaw", sandboxName\)/);
    assert.match(
      source,
      /skippedStepMessage\("policies", \(recordedPolicyPresets \|\| \[\]\)\.join\(", "\)\)/,
    );
  });

  it("activates permissive policy via policy set when dangerouslySkipPermissions is true", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );

    // The dangerouslySkipPermissions branch must call applyPermissivePolicy to
    // activate the policy via `openshell policy set --wait`.  Without this,
    // the base policy from sandbox create stays in Pending status (#897).
    assert.match(
      source,
      /if \(dangerouslySkipPermissions\) \{\s*step\(8, 8, "Policy presets"\);\s*if \(!waitForSandboxReady\(sandboxName\)\) \{[\s\S]*?\}\s*policies\.applyPermissivePolicy\(sandboxName\);/,
    );
    // Must NOT just print a skip message without activating the policy.
    assert.doesNotMatch(
      source,
      /dangerouslySkipPermissions\)[\s\S]*?Skipped —.*permissive base policy/,
    );
  });

  it("delegates sandbox-create progress streaming to the extracted helper module", () => {
    const onboardSource = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );
    const { streamSandboxCreate } = require("../dist/lib/sandbox-create-stream");

    assert.match(onboardSource, /sandbox-create-stream/);
    assert.equal(typeof streamSandboxCreate, "function");
  });

  it("hydrates stored provider credentials when setupInference runs without process env set", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-resume-cred-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-resume-credential-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const credentials = require(${credentialsPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("inference") && command.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
    ].join("\n");
  }
  return "";
};
registry.updateSandbox = () => true;

credentials.saveCredential("OPENAI_API_KEY", "sk-stored-secret");
delete process.env.OPENAI_API_KEY;

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify({ commands, openai: process.env.OPENAI_API_KEY || null }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(payload.openai, "sk-stored-secret");
    // commands[0]=gateway select, [1]=provider get, [2]=provider update
    assert.equal(payload.commands[2].env.OPENAI_API_KEY, "sk-stored-secret");
    assert.doesNotMatch(payload.commands[2].command, /sk-stored-secret/);
  });

  it("drops stale local sandbox registry entries when the live sandbox is gone", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-stale-sandbox-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "stale-sandbox-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const registry = require(${registryPath});
const runner = require(${runnerPath});
runner.runCapture = (command) => (command.includes("'sandbox' 'get' 'my-assistant'") ? "" : "");

registry.registerSandbox({ name: "my-assistant" });

const { pruneStaleSandboxEntry } = require(${onboardPath});

const liveExists = pruneStaleSandboxEntry("my-assistant");
console.log(JSON.stringify({ liveExists, sandbox: registry.getSandbox("my-assistant") }));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payloadLine = result.stdout
      .trim()
      .split("\n")
      .slice()
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
    const payload = JSON.parse(payloadLine);
    assert.equal(payload.liveExists, false);
    assert.equal(payload.sandbox, null);
  });

  it("builds the sandbox without uploading an external OpenClaw config file", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-create-sandbox-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "";
  if (command.includes("'sandbox' 'list'")) return "my-assistant Ready";
  if (command.includes("sandbox exec 'my-assistant' curl -sf http://localhost:18789/")) return "ok";
  if (command.includes("'forward' 'list'")) return "18789 -> my-assistant:18789";
  return "";
};
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: args[1][1], env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payloadLine = result.stdout
      .trim()
      .split("\n")
      .slice()
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
    const payload = JSON.parse(payloadLine);
    assert.equal(payload.sandboxName, "my-assistant");
    const createCommand = payload.commands.find((entry) =>
      entry.command.includes("'sandbox' 'create'"),
    );
    assert.ok(createCommand, "expected sandbox create command");
    assert.match(createCommand.command, /'nemoclaw-start'/);
    assert.doesNotMatch(createCommand.command, /'--upload'/);
    assert.doesNotMatch(createCommand.command, /OPENCLAW_CONFIG_PATH/);
    assert.doesNotMatch(createCommand.command, /NVIDIA_API_KEY=/);
    assert.doesNotMatch(createCommand.command, /DISCORD_BOT_TOKEN=/);
    assert.doesNotMatch(createCommand.command, /SLACK_BOT_TOKEN=/);
    assert.ok(
      payload.commands.some(
        (entry) =>
          entry.command.includes("'forward' 'start' '--background' '18789' 'my-assistant'") ||
          entry.command.includes("'forward' 'start' '--background' '0.0.0.0:18789' 'my-assistant'"),
      ),
      "expected dashboard forward (loopback or WSL 0.0.0.0)",
    );
  });

  it("binds the dashboard forward to 0.0.0.0 when CHAT_UI_URL points to a remote host", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-remote-forward-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-remote-forward.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "";
  if (command.includes("'sandbox' 'list'")) return "my-assistant Ready";
  if (command.includes("sandbox exec 'my-assistant' curl -sf http://localhost:18789/")) return "ok";
  if (command.includes("'forward' 'list'")) return "18789 -> my-assistant:18789";
  return "";
};
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: args[1][1], env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.CHAT_UI_URL = "https://chat.example.com";
  await createSandbox(null, "gpt-5.4");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.ok(
      commands.some((entry) =>
        entry.command.includes("'forward' 'start' '--background' '0.0.0.0:18789' 'my-assistant'"),
      ),
      "expected remote dashboard forward target",
    );
  });

  it("injects NEMOCLAW_DASHBOARD_PORT into sandbox create envArgs when set (#1925)", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dashboard-port-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "dashboard-port-envargs.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "";
  if (command.includes("'sandbox' 'list'")) return "my-assistant Ready";
  // Custom port: dashboard readiness curl uses 19000 (DASHBOARD_PORT from env)
  if (command.includes("sandbox exec 'my-assistant' curl -sf http://localhost:19000/")) return "ok";
  if (command.includes("'forward' 'list'")) return "19000 -> my-assistant:19000";
  return "";
};
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: args[1][1], env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    // Strip CHAT_UI_URL so createSandbox falls back to http://127.0.0.1:19000.
    // Without this, a CHAT_UI_URL set in the developer's shell or CI would be
    // inherited, causing chatUiUrl to use the wrong port and making the forward
    // command assertion below fail spuriously.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { CHAT_UI_URL: _stripped, ...inheritedEnv } = process.env;
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...inheritedEnv,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_DASHBOARD_PORT: "19000",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payloadLine = result.stdout
      .trim()
      .split("\n")
      .slice()
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
    const payload = JSON.parse(payloadLine);
    const createCommand = payload.commands.find((entry) =>
      entry.command.includes("'sandbox' 'create'"),
    );
    assert.ok(createCommand, "expected sandbox create command");
    // Part 1 of fix (#1925): NEMOCLAW_DASHBOARD_PORT must be in envArgs so
    // nemoclaw-start.sh can unconditionally override CHAT_UI_URL at runtime,
    // overriding whatever value the Docker image had baked in.
    assert.match(createCommand.command, /'NEMOCLAW_DASHBOARD_PORT=19000'/);
    // Forward must use same-port mapping (openshell does not support asymmetric)
    assert.ok(
      payload.commands.some(
        (entry) =>
          entry.command.includes("'forward' 'start' '--background' '19000' 'my-assistant'") ||
          entry.command.includes(
            "'forward' 'start' '--background' '0.0.0.0:19000' 'my-assistant'",
          ),
      ),
      "expected dashboard forward for port 19000",
    );
    assert.ok(
      !payload.commands.some((entry) => entry.command.includes("19000:18789")),
      "forward must not use asymmetric 19000:18789 mapping",
    );
    assert.ok(
      !payload.commands.some((entry) => entry.command.includes("19000:19000")),
      "forward must not use port:port form (openshell does not support it)",
    );
  });

  it(
    "creates providers for messaging tokens and attaches them to the sandbox",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-messaging-providers-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "messaging-provider-check.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
      const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "preflight.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  // provider-get returns not-found so messaging providers are created fresh
  if (command.includes("'provider' 'get'")) return { status: 1 };
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "";
  if (command.includes("'sandbox' 'list'")) return "my-assistant Ready";
  if (command.includes("'provider' 'get'")) return "Provider: discord-bridge";
  if (command.includes("'forward' 'list'")) return "18789 -> my-assistant:18789";
  if (command.includes("sandbox exec") && command.includes("curl")) return "ok";
  return "";
};
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: args[1][1], env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.DISCORD_BOT_TOKEN = "test-discord-token-value";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token-value";
  process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-test-telegram-token";
  const sandboxName = await createSandbox(null, "gpt-5.4");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      // Verify providers were created with the right credential keys
      const providerCommands = payload.commands.filter((e) =>
        e.command.includes("'provider' 'create'"),
      );
      const discordProvider = providerCommands.find((e) =>
        e.command.includes("my-assistant-discord-bridge"),
      );
      assert.ok(discordProvider, "expected my-assistant-discord-bridge provider create command");
      assert.match(discordProvider.command, /'--credential' 'DISCORD_BOT_TOKEN'/);

      const slackProvider = providerCommands.find((e) =>
        e.command.includes("my-assistant-slack-bridge"),
      );
      assert.ok(slackProvider, "expected my-assistant-slack-bridge provider create command");
      assert.match(slackProvider.command, /'--credential' 'SLACK_BOT_TOKEN'/);

      const telegramProvider = providerCommands.find((e) =>
        e.command.includes("my-assistant-telegram-bridge"),
      );
      assert.ok(telegramProvider, "expected my-assistant-telegram-bridge provider create command");
      assert.match(telegramProvider.command, /'--credential' 'TELEGRAM_BOT_TOKEN'/);

      // Verify sandbox create includes --provider flags for all three
      const createCommand = payload.commands.find((e) => e.command.includes("'sandbox' 'create'"));
      assert.ok(createCommand, "expected sandbox create command");
      assert.match(createCommand.command, /'--provider' 'my-assistant-discord-bridge'/);
      assert.match(createCommand.command, /'--provider' 'my-assistant-slack-bridge'/);
      assert.match(createCommand.command, /'--provider' 'my-assistant-telegram-bridge'/);

      // Verify real token values are NOT in the sandbox create command
      assert.doesNotMatch(createCommand.command, /test-discord-token-value/);
      assert.doesNotMatch(createCommand.command, /xoxb-test-slack-token-value/);
      assert.doesNotMatch(createCommand.command, /123456:ABC-test-telegram-token/);

      // Verify blocked credentials are NOT in the sandbox spawn environment
      assert.ok(createCommand.env, "expected env to be captured from spawn call");
      assert.equal(
        createCommand.env.DISCORD_BOT_TOKEN,
        undefined,
        "DISCORD_BOT_TOKEN must not be in sandbox env",
      );
      assert.equal(
        createCommand.env.SLACK_BOT_TOKEN,
        undefined,
        "SLACK_BOT_TOKEN must not be in sandbox env",
      );
      assert.equal(
        createCommand.env.TELEGRAM_BOT_TOKEN,
        undefined,
        "TELEGRAM_BOT_TOKEN must not be in sandbox env",
      );
      assert.equal(
        createCommand.env.NVIDIA_API_KEY,
        undefined,
        "NVIDIA_API_KEY must not be in sandbox env",
      );

      // Belt-and-suspenders: raw token values must not appear anywhere in env
      const envString = JSON.stringify(createCommand.env);
      assert.ok(
        !envString.includes("test-discord-token-value"),
        "Discord token value must not leak into sandbox env",
      );
      assert.ok(
        !envString.includes("xoxb-test-slack-token-value"),
        "Slack token value must not leak into sandbox env",
      );
      assert.ok(
        !envString.includes("123456:ABC-test-telegram-token"),
        "Telegram token value must not leak into sandbox env",
      );
    },
  );

  it("aborts onboard when a messaging provider upsert fails", { timeout: 60_000 }, async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-provider-fail-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "provider-upsert-fail.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

runner.run = (command, opts = {}) => {
  // Fail all provider create and update calls
  if (command.includes("'provider'")) {
    return { status: 1, stdout: "", stderr: "gateway unreachable" };
  }
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("'sandbox' 'get'")) return "";
  if (command.includes("'sandbox' 'list'")) return "";
  return "";
};
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.DISCORD_BOT_TOKEN = "test-discord-token-value";
  await createSandbox(null, "gpt-5.4");
  // Should not reach here
  console.log("ERROR_DID_NOT_EXIT");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.notEqual(result.status, 0, "expected non-zero exit when provider upsert fails");
    assert.ok(
      !result.stdout.includes("ERROR_DID_NOT_EXIT"),
      "onboard should have aborted before reaching sandbox create",
    );
  });

  it(
    "reuses sandbox when messaging providers already exist in gateway",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-reuse-providers-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "reuse-with-providers.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  // Existing sandbox that is ready
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "my-assistant";
  if (command.includes("'sandbox' 'list'")) return "my-assistant Ready";
  // All messaging providers already exist in gateway
  if (command.includes("'provider' 'get'")) return "Provider: exists";
  if (command.includes("'forward' 'list'")) return "18789 -> my-assistant:18789";
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.DISCORD_BOT_TOKEN = "test-discord-token";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.equal(payload.sandboxName, "my-assistant", "should reuse existing sandbox");
      assert.ok(
        payload.commands.every((entry) => !entry.command.includes("'sandbox' 'create'")),
        "should NOT recreate sandbox when providers already exist in gateway",
      );
      assert.ok(
        payload.commands.every((entry) => !entry.command.includes("'sandbox' 'delete'")),
        "should NOT delete sandbox when providers already exist in gateway",
      );

      // Providers should still be upserted on reuse (credential refresh).
      // Since the mock reports providers as existing (run returns status 0),
      // upsertProvider issues 'update' rather than 'create'.
      const providerUpserts = payload.commands.filter((entry) =>
        entry.command.includes("'provider' 'update'"),
      );
      assert.ok(
        providerUpserts.some((e) => e.command.includes("my-assistant-discord-bridge")),
        "should upsert discord provider on reuse to refresh credentials",
      );
      assert.ok(
        providerUpserts.some((e) => e.command.includes("my-assistant-slack-bridge")),
        "should upsert slack provider on reuse to refresh credentials",
      );
    },
  );

  it(
    "non-interactive exits with error when existing sandbox is not ready",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-noninteractive-notready-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "noninteractive-notready.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const childProcess = require("node:child_process");

runner.run = (command) => {
  if (command.includes("'sandbox' 'delete'")) {
    throw new Error("unexpected sandbox delete");
  }
  return { status: 0 };
};
runner.runCapture = (command) => {
  // Existing sandbox that is NOT ready
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "my-assistant";
  if (command.includes("'sandbox' 'list'")) return "my-assistant NotReady";
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });
childProcess.spawn = () => {
  throw new Error("unexpected sandbox create");
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log("ERROR_DID_NOT_EXIT");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const env = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      };
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.notEqual(result.status, 0, "expected non-zero exit for not-ready sandbox");
      assert.ok(
        !result.stdout.includes("ERROR_DID_NOT_EXIT"),
        "should have exited before reaching sandbox create",
      );
      const output = (result.stdout || "") + (result.stderr || "");
      assert.ok(
        output.includes("--recreate-sandbox") || output.includes("NEMOCLAW_RECREATE_SANDBOX"),
        "should hint about --recreate-sandbox flag",
      );
    },
  );

  it(
    "recreate-sandbox flag forces deletion and recreation of a ready sandbox",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-recreate-flag-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "recreate-flag.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "my-assistant";
  if (command.includes("'sandbox' 'list'")) return "my-assistant Ready";
  if (command.includes("'forward' 'list'")) return "";
  if (command.includes("sandbox exec") && command.includes("curl")) return "ok";
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;

const preflight = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "preflight.js"))});
preflight.checkPortAvailable = async () => ({ ok: true });

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: args[1][1], env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_RECREATE_SANDBOX = "1";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.ok(
        payload.commands.some((entry) => entry.command.includes("'sandbox' 'delete'")),
        "should delete existing sandbox when --recreate-sandbox is set",
      );
      assert.ok(
        payload.commands.some((entry) => entry.command.includes("'sandbox' 'create'")),
        "should create a new sandbox when --recreate-sandbox is set",
      );
    },
  );

  it(
    "interactive mode prompts before reusing an existing ready sandbox",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-interactive-reuse-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "interactive-reuse.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const credentials = require(${credentialsPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "my-assistant";
  if (command.includes("'sandbox' 'list'")) return "my-assistant Ready";
  if (command.includes("'forward' 'list'")) return "18789 -> my-assistant:18789";
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });

// Mock prompt to return "y" (reuse)
credentials.prompt = async () => "y";

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      // Run WITHOUT NEMOCLAW_NON_INTERACTIVE to exercise interactive path
      const env = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      };
      delete env["NEMOCLAW_NON_INTERACTIVE"];
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.equal(payload.sandboxName, "my-assistant", "should reuse when user answers y");
      assert.ok(
        payload.commands.every((entry) => !entry.command.includes("'sandbox' 'create'")),
        "should NOT recreate sandbox when user chooses to reuse",
      );
      assert.ok(
        payload.commands.every((entry) => !entry.command.includes("'sandbox' 'delete'")),
        "should NOT delete sandbox when user chooses to reuse",
      );
      assert.ok(
        result.stdout.includes("already exists"),
        "should show 'already exists' message in interactive mode",
      );
    },
  );

  it(
    "interactive mode deletes and recreates sandbox when user declines reuse",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-interactive-decline-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "interactive-decline.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "my-assistant";
  if (command.includes("'sandbox' 'list'")) return "my-assistant Ready";
  if (command.includes("'forward' 'list'")) return "";
  if (command.includes("sandbox exec") && command.includes("curl")) return "ok";
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;

const preflight = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "preflight.js"))});
preflight.checkPortAvailable = async () => ({ ok: true });

// Mock prompt to return "n" (decline reuse)
credentials.prompt = async () => "n";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: args[1][1], env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      // Run WITHOUT NEMOCLAW_NON_INTERACTIVE to exercise interactive path
      const env = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      };
      delete env["NEMOCLAW_NON_INTERACTIVE"];
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.ok(
        payload.commands.some((entry) => entry.command.includes("'sandbox' 'delete'")),
        "should delete existing sandbox when user declines reuse",
      );
      assert.ok(
        payload.commands.some((entry) => entry.command.includes("'sandbox' 'create'")),
        "should create a new sandbox when user declines reuse",
      );
      assert.ok(
        result.stdout.includes("already exists"),
        "should show 'already exists' message before prompting",
      );
    },
  );

  it(
    "interactive mode auto-recreates when existing sandbox is not ready",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-interactive-notready-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "interactive-notready.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
let sandboxDeleted = false;
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  if (command.includes("'sandbox' 'delete'")) sandboxDeleted = true;
  return { status: 0 };
};
runner.runCapture = (command) => {
  // Existing sandbox that is NOT ready initially, becomes Ready after recreation
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "my-assistant";
  if (command.includes("'sandbox' 'list'")) {
    return sandboxDeleted ? "my-assistant Ready" : "my-assistant NotReady";
  }
  if (command.includes("'forward' 'list'")) return "";
  if (command.includes("sandbox exec") && command.includes("curl")) return "ok";
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;

const preflight = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "preflight.js"))});
preflight.checkPortAvailable = async () => ({ ok: true });

// User confirms recreation when prompted
credentials.prompt = async () => "y";

const fakeSpawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: args[1][1], env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};
childProcess.spawn = fakeSpawn;

// Also patch spawn inside the compiled sandbox-create-stream module.
// It imports spawn at load time from "node:child_process", so patching the
// childProcess object above does not reach it. Patch the cached module
// directly so streamSandboxCreate (called by createSandbox) doesn't spawn
// a real bash process that tries to hit a live gateway.
const sandboxCreateStreamMod = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "sandbox-create-stream.js"))});
const _origStreamCreate = sandboxCreateStreamMod.streamSandboxCreate;
sandboxCreateStreamMod.streamSandboxCreate = (command, env, options = {}) => {
  return _origStreamCreate(command, env, { ...options, spawnImpl: fakeSpawn });
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      // Run WITHOUT NEMOCLAW_NON_INTERACTIVE to exercise interactive path
      const env = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      };
      delete env["NEMOCLAW_NON_INTERACTIVE"];
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.ok(
        payload.commands.some((entry) => entry.command.includes("'sandbox' 'delete'")),
        "should delete not-ready sandbox after user confirms",
      );
      assert.ok(
        payload.commands.some((entry) => entry.command.includes("'sandbox' 'create'")),
        "should recreate sandbox when existing one is not ready",
      );
      assert.ok(result.stdout.includes("not ready"), "should mention sandbox is not ready");
    },
  );

  it("upsertProvider creates a new provider and returns ok on success", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-upsert-provider-create-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "upsert-provider-create.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = `
const runner = require(${runnerPath});
const commands = [];
runner.run = (command, opts = {}) => {
  commands.push(command);
  // First call is provider-get (not found), second is provider-create (success)
  if (command.includes("'provider' 'get'")) return { status: 1, stdout: "", stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};
const { upsertProvider } = require(${onboardPath});
const result = upsertProvider("discord-bridge", "generic", "DISCORD_BOT_TOKEN", null, { DISCORD_BOT_TOKEN: "fake" });
console.log(JSON.stringify({ result, commands }));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.deepEqual(payload.result, { ok: true });
    assert.equal(payload.commands.length, 2);
    assert.match(payload.commands[0], /'provider' 'get'/);
    assert.match(payload.commands[1], /'provider' 'create' '--name' 'discord-bridge'/);
    assert.match(payload.commands[1], /'--credential' 'DISCORD_BOT_TOKEN'/);
  });

  it("upsertProvider does not add its own log line on top of runner output (#1506)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-upsert-no-dup-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "upsert-no-dup.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = `
const runner = require(${runnerPath});
runner.run = (command, opts = {}) => {
  // First call is provider-get (not found)
  if (command.includes("'provider' 'get'")) return { status: 1, stdout: "", stderr: "" };
  // Simulate runner passthrough: writeRedactedResult writes stdout to terminal
  process.stdout.write("✓ Created provider test-bridge\\n");
  return { status: 0, stdout: "✓ Created provider test-bridge", stderr: "" };
};
const { upsertProvider } = require(${onboardPath});
upsertProvider("test-bridge", "generic", "TEST_TOKEN", null, { TEST_TOKEN: "tok" });
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
    });

    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout
      .split("\n")
      .filter((l) => l.includes("Created provider test-bridge"));
    assert.equal(lines.length, 1, `Expected 1 log line but got ${lines.length}: ${result.stdout}`);
  });

  it("upsertProvider updates existing provider instead of creating (#1155)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-upsert-provider-update-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "upsert-provider-update.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = `
const runner = require(${runnerPath});
const commands = [];
runner.run = (command, opts = {}) => {
  commands.push(command);
  // provider-get succeeds (provider exists), then update succeeds
  return { status: 0, stdout: "", stderr: "" };
};
const { upsertProvider } = require(${onboardPath});
const result = upsertProvider("inference", "openai", "NVIDIA_API_KEY", "https://integrate.api.nvidia.com/v1");
console.log(JSON.stringify({ result, commands }));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.deepEqual(payload.result, { ok: true });
    assert.equal(payload.commands.length, 2);
    assert.match(payload.commands[0], /'provider' 'get'/);
    assert.match(payload.commands[1], /'provider' 'update'/);
    assert.match(
      payload.commands[1],
      /'--config' 'OPENAI_BASE_URL=https:\/\/integrate.api.nvidia.com\/v1'/,
    );
  });

  it("upsertProvider returns error details when create or update fails", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-upsert-provider-fail-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "upsert-provider-fail.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = `
const runner = require(${runnerPath});
runner.run = (command, opts = {}) => {
  // provider-get says not found, then create fails
  if (command.includes("'provider' 'get'")) return { status: 1, stdout: "", stderr: "" };
  return { status: 1, stdout: "", stderr: "gateway unreachable" };
};
const { upsertProvider } = require(${onboardPath});
const result = upsertProvider("bad-provider", "generic", "SOME_KEY", null);
console.log(JSON.stringify(result));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(payload.ok, false);
    assert.equal(payload.status, 1);
    assert.match(payload.message, /gateway unreachable/);
  });

  it("providerExistsInGateway returns true when provider exists", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-provider-exists-true-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "provider-exists-true.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = `
const runner = require(${runnerPath});
runner.run = (command) => {
  return { status: 0, stdout: "Provider: discord-bridge", stderr: "" };
};
const { providerExistsInGateway } = require(${onboardPath});
console.log(JSON.stringify({ exists: providerExistsInGateway("discord-bridge") }));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(payload.exists, true);
  });

  it("hydrateCredentialEnv writes stored credentials into process.env for host-side bridges", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hydrate-cred-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "hydrate-cred.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = `
const credentials = require(${credentialsPath});
// Mock getCredential to return a stored value
credentials.getCredential = (name) => name === "TELEGRAM_BOT_TOKEN" ? "stored-telegram-token" : null;
const { hydrateCredentialEnv } = require(${onboardPath});

// Should return null for falsy input
const nullResult = hydrateCredentialEnv(null);

// Should hydrate from stored credential and set process.env
delete process.env.TELEGRAM_BOT_TOKEN;
const hydrated = hydrateCredentialEnv("TELEGRAM_BOT_TOKEN");

// Should return null when credential is not stored
const missing = hydrateCredentialEnv("NONEXISTENT_KEY");

console.log(JSON.stringify({
  nullResult,
  hydrated,
  envSet: process.env.TELEGRAM_BOT_TOKEN,
  missing,
}));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(payload.nullResult, null, "should return null for null input");
    assert.equal(
      payload.hydrated,
      "stored-telegram-token",
      "should return stored credential value",
    );
    assert.equal(
      payload.envSet,
      "stored-telegram-token",
      "should set process.env with stored value",
    );
    assert.equal(payload.missing, null, "should return null when credential is not stored");
  });

  it("providerExistsInGateway returns false when provider is missing", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-provider-exists-false-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "provider-exists-false.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = `
const runner = require(${runnerPath});
runner.run = (command) => {
  return { status: 1, stdout: "", stderr: "provider not found" };
};
const { providerExistsInGateway } = require(${onboardPath});
console.log(JSON.stringify({ exists: providerExistsInGateway("nonexistent") }));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(payload.exists, false);
  });

  it("continues once the sandbox is Ready even if the create stream never closes", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-create-ready-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-ready-check.js");
    const payloadPath = path.join(tmpDir, "payload.json");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");

const commands = [];
let sandboxListCalls = 0;
const keepAlive = setInterval(() => {}, 1000);
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "";
  if (command.includes("'sandbox' 'list'")) {
    sandboxListCalls += 1;
    return sandboxListCalls >= 2 ? "my-assistant Ready" : "my-assistant Pending";
  }
  if (command.includes("sandbox exec 'my-assistant' curl -sf http://localhost:18789/")) return "ok";
  if (command.includes("'forward' 'list'")) return "18789 -> my-assistant:18789";
  return "";
};
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.unrefCalls = 0;
  child.stdout.destroyCalls = 0;
  child.stderr.destroyCalls = 0;
  child.stdout.destroy = () => {
    child.stdout.destroyCalls += 1;
  };
  child.stderr.destroy = () => {
    child.stderr.destroyCalls += 1;
  };
  child.unref = () => {
    child.unrefCalls += 1;
  };
  child.kill = (signal) => {
    child.killCalls.push(signal);
    process.nextTick(() => child.emit("close", signal === "SIGTERM" ? 0 : 1));
    return true;
  };
  commands.push({ command: args[1][1], env: args[2]?.env || null, child });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4");
  const createCommand = commands.find((entry) => entry.command.includes("'sandbox' 'create'"));
  fs.writeFileSync(${JSON.stringify(payloadPath)}, JSON.stringify({
    sandboxName,
    sandboxListCalls,
    killCalls: createCommand.child.killCalls,
    unrefCalls: createCommand.child.unrefCalls,
    stdoutDestroyCalls: createCommand.child.stdout.destroyCalls,
    stderrDestroyCalls: createCommand.child.stderr.destroyCalls,
  }));
  clearInterval(keepAlive);
})().catch((error) => {
  clearInterval(keepAlive);
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
      timeout: 15000,
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
    assert.equal(payload.sandboxName, "my-assistant");
    assert.ok(payload.sandboxListCalls >= 2);
    assert.deepEqual(payload.killCalls, ["SIGTERM"]);
    assert.equal(payload.unrefCalls, 1);
    assert.equal(payload.stdoutDestroyCalls, 1);
    assert.equal(payload.stderrDestroyCalls, 1);
  });

  it("restores the dashboard forward when onboarding reuses an existing ready sandbox", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-reuse-forward-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "reuse-sandbox-forward.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "my-assistant";
  if (command.includes("'sandbox' 'list'")) return "my-assistant Ready";
  if (command.includes("'forward' 'list'")) return "18789 -> my-assistant:18789";
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.CHAT_UI_URL = "https://chat.example.com";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(payload.sandboxName, "my-assistant");
    assert.ok(
      payload.commands.some((entry) =>
        entry.command.includes("'forward' 'start' '--background' '0.0.0.0:18789' 'my-assistant'"),
      ),
      "expected dashboard forward restore on sandbox reuse",
    );
    assert.ok(
      payload.commands.every((entry) => !entry.command.includes("'sandbox' 'create'")),
      "did not expect sandbox create when reusing existing sandbox",
    );
  });

  it("prints resume guidance when sandbox image upload times out", () => {
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      printSandboxCreateRecoveryHints(
        [
          "  Pushing image openshell/sandbox-from:123 into gateway nemoclaw",
          "  [progress] Uploaded to gateway",
          "Error: failed to read image export stream",
          "Timeout error",
        ].join("\n"),
      );
    } finally {
      console.error = originalError;
    }

    const joined = errors.join("\n");
    assert.match(joined, /Hint: image upload into the OpenShell gateway timed out\./);
    assert.match(joined, /Recovery: nemoclaw onboard --resume/);
    assert.match(
      joined,
      /Progress reached the gateway upload stage, so resume may be able to reuse existing gateway state\./,
    );
  });

  it("prints resume guidance when sandbox image upload resets after transfer progress", () => {
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      printSandboxCreateRecoveryHints(
        [
          "  Pushing image openshell/sandbox-from:123 into gateway nemoclaw",
          "  [progress] Uploaded to gateway",
          "Error: Connection reset by peer",
        ].join("\n"),
      );
    } finally {
      console.error = originalError;
    }

    const joined = errors.join("\n");
    assert.match(joined, /Hint: the image push\/import stream was interrupted\./);
    assert.match(joined, /Recovery: nemoclaw onboard --resume/);
    assert.match(
      joined,
      /The image appears to have reached the gateway before the stream failed\./,
    );
  });

  it("accepts gateway inference when system inference is separately not configured", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-inference-get-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "inference-get-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("inference") && command.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
      "",
      "System inference:",
      "",
      "  Not configured",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;
process.env.OPENAI_API_KEY = "sk-secret-value";
process.env.OPENSHELL_GATEWAY = "nemoclaw";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = JSON.parse(result.stdout.trim().split("\n").pop());
    // gateway select + provider get + provider update + inference set
    assert.equal(commands.length, 4);
  });

  it("accepts gateway inference output that omits the Route line", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-inference-route-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "inference-route-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("inference") && command.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
      "",
      "System inference:",
      "",
      "  Not configured",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;
process.env.OPENAI_API_KEY = "sk-secret-value";
process.env.OPENSHELL_GATEWAY = "nemoclaw";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = JSON.parse(result.stdout.trim().split("\n").pop());
    // gateway select + provider get + provider update + inference set
    assert.equal(commands.length, 4);
  });

  it(
    "filters messaging providers to only enabledChannels when provided",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-enabled-channels-filter-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "enabled-channels-filter.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
      const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "preflight.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  // provider-get returns not-found so messaging providers are created fresh
  if (command.includes("'provider' 'get'")) return { status: 1 };
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "";
  if (command.includes("'sandbox' 'list'")) return "my-assistant Ready";
  if (command.includes("sandbox exec 'my-assistant' curl -sf http://localhost:18789/")) return "ok";
  if (command.includes("'forward' 'list'")) return "18789 -> my-assistant:18789";
  return "";
};
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: args[1][1], env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.DISCORD_BOT_TOKEN = "test-discord-token-value";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token-value";
  process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-test-telegram-token";
  // Only enable telegram — discord and slack should be filtered out
  const sandboxName = await createSandbox(
    null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, ["telegram"],
  );
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      // Only telegram provider should be created
      const providerCommands = payload.commands.filter((e) =>
        e.command.includes("'provider' 'create'"),
      );
      const telegramProvider = providerCommands.find((e) =>
        e.command.includes("my-assistant-telegram-bridge"),
      );
      assert.ok(telegramProvider, "expected telegram provider to be created");

      // Discord and slack providers should NOT be created
      const discordProvider = providerCommands.find((e) =>
        e.command.includes("my-assistant-discord-bridge"),
      );
      assert.ok(!discordProvider, "discord provider should be filtered out");

      const slackProvider = providerCommands.find((e) =>
        e.command.includes("my-assistant-slack-bridge"),
      );
      assert.ok(!slackProvider, "slack provider should be filtered out");

      // Sandbox create should only have the telegram --provider flag
      const createCommand = payload.commands.find((e) => e.command.includes("'sandbox' 'create'"));
      assert.ok(createCommand, "expected sandbox create command");
      assert.match(createCommand.command, /'--provider' 'my-assistant-telegram-bridge'/);
      assert.doesNotMatch(createCommand.command, /my-assistant-discord-bridge/);
      assert.doesNotMatch(createCommand.command, /my-assistant-slack-bridge/);
    },
  );

  it(
    "creates no messaging providers when enabledChannels is empty",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-enabled-channels-empty-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "enabled-channels-empty.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
      const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "preflight.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "";
  if (command.includes("'sandbox' 'list'")) return "my-assistant Ready";
  if (command.includes("sandbox exec 'my-assistant' curl -sf http://localhost:18789/")) return "ok";
  if (command.includes("'forward' 'list'")) return "18789 -> my-assistant:18789";
  return "";
};
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: args[1][1], env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.DISCORD_BOT_TOKEN = "test-discord-token-value";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token-value";
  process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-test-telegram-token";
  // Empty array — user deselected all channels
  const sandboxName = await createSandbox(
    null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, [],
  );
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      // No messaging providers should be created at all
      const providerCommands = payload.commands.filter((e) =>
        e.command.includes("'provider' 'create'"),
      );
      assert.equal(
        providerCommands.length,
        0,
        "no providers should be created when enabledChannels is empty",
      );

      // Sandbox create should have no --provider flags for messaging bridges
      const createCommand = payload.commands.find((e) => e.command.includes("'sandbox' 'create'"));
      assert.ok(createCommand, "expected sandbox create command");
      assert.doesNotMatch(createCommand.command, /discord-bridge/);
      assert.doesNotMatch(createCommand.command, /slack-bridge/);
      assert.doesNotMatch(createCommand.command, /telegram-bridge/);
    },
  );

  it(
    "non-interactive setupMessagingChannels returns channels with tokens",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-messaging-noninteractive-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "messaging-noninteractive.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
runner.run = () => ({ status: 0 });
runner.runCapture = () => "";

const { setupMessagingChannels } = require(${onboardPath});

(async () => {
  // Only set telegram and slack tokens — discord should be absent
  process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-test-telegram-token";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token";
  const result = await setupMessagingChannels();
  console.log(JSON.stringify(result));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const outputLine = result.stdout.trim().split("\n").pop();
      const channels = JSON.parse(outputLine);

      // Should return only the channels that have tokens set
      assert.ok(Array.isArray(channels), "expected an array return value");
      assert.ok(channels.includes("telegram"), "expected telegram in returned channels");
      assert.ok(channels.includes("slack"), "expected slack in returned channels");
      assert.ok(!channels.includes("discord"), "discord should not be in returned channels");
    },
  );

  it(
    "non-interactive setupMessagingChannels returns empty array when no tokens set",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-messaging-no-tokens-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "messaging-no-tokens.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
runner.run = () => ({ status: 0 });
runner.runCapture = () => "";

const { setupMessagingChannels } = require(${onboardPath});

(async () => {
  // No messaging tokens set
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  const result = await setupMessagingChannels();
  console.log(JSON.stringify(result));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
          TELEGRAM_BOT_TOKEN: "",
          DISCORD_BOT_TOKEN: "",
          SLACK_BOT_TOKEN: "",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const outputLine = result.stdout.trim().split("\n").pop();
      const channels = JSON.parse(outputLine);

      assert.ok(Array.isArray(channels), "expected an array return value");
      assert.equal(channels.length, 0, "expected empty array when no tokens are set");
    },
  );

  it("uses the custom Dockerfile parent directory as build context when --from is given", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-from-dockerfile-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-from.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

    // Create a minimal custom Dockerfile in a temporary directory
    const customBuildDir = path.join(tmpDir, "custom-image");
    fs.mkdirSync(customBuildDir, { recursive: true });
    fs.writeFileSync(
      path.join(customBuildDir, "Dockerfile"),
      [
        "FROM ubuntu:22.04",
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-super-49b-v1",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-super-49b-v1",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1",
        "ARG NEMOCLAW_INFERENCE_API=openai-completions",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_BUILD_ID=default",
        "RUN echo done",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(customBuildDir, "extra.txt"), "extra build context file");

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const customDockerfilePath = JSON.stringify(path.join(customBuildDir, "Dockerfile"));

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "";
  if (command.includes("'sandbox' 'list'")) return "my-assistant Ready";
  if (command.includes("sandbox exec 'my-assistant' curl -sf http://localhost:18789/")) return "ok";
  if (command.includes("'forward' 'list'")) return "18789 -> my-assistant:18789";
  return "";
};
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: args[1][1], env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4", "openai-api", null, "my-assistant", null, null, ${customDockerfilePath});
  // Verify the staged build context contains the extra file from the custom dir
  const createCmd = commands.find((e) => e.command.includes("'sandbox' 'create'"));
  const fromMatch = createCmd && createCmd.command.match(/--from['\s]+'([^']+)'/);
  let stagedDir = null;
  let hasExtraFile = false;
  if (fromMatch) {
    const dockerfilePath = fromMatch[1];
    stagedDir = require("node:path").dirname(dockerfilePath);
    hasExtraFile = fs.existsSync(require("node:path").join(stagedDir, "extra.txt"));
  }
  console.log(JSON.stringify({ sandboxName, hasExtraFile }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payloadLine = result.stdout
      .trim()
      .split("\n")
      .slice()
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
    const payload = JSON.parse(payloadLine);
    assert.equal(payload.sandboxName, "my-assistant");
    assert.equal(
      payload.hasExtraFile,
      true,
      "extra.txt from custom build context should be staged",
    );
  });

  it("exits with an error when the --from Dockerfile path does not exist", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-from-missing-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-missing.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const missingPath = JSON.stringify(path.join(tmpDir, "does-not-exist", "Dockerfile"));

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});

runner.run = () => ({ status: 0 });
runner.runCapture = () => "";
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  await createSandbox(null, "gpt-5.4", "openai-api", null, "my-assistant", null, null, ${missingPath});
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 1, "should exit 1 when fromDockerfile path is missing");
    assert.match(result.stderr, /Custom Dockerfile not found/);
  });

  it("re-prompts on invalid sandbox names instead of exiting in interactive mode", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );
    // Extract the promptValidatedSandboxName function body
    const fnMatch = source.match(
      /async function promptValidatedSandboxName\(\)\s*\{([\s\S]*?)\n\}/,
    );
    assert.ok(fnMatch, "promptValidatedSandboxName function not found");
    const fnBody = fnMatch[1];
    // Verify the bounded retry loop exists within this function
    assert.match(fnBody, /MAX_ATTEMPTS/);
    assert.match(fnBody, /for\s*\(let attempt/);
    assert.match(fnBody, /Please try again/);
    // Exits after too many invalid attempts
    assert.match(fnBody, /Too many invalid attempts/);
    // Non-interactive still exits within this function
    assert.match(fnBody, /isNonInteractive\(\)/);
    assert.match(fnBody, /process\.exit\(1\)/);
  });

  it("regression #1881: registry.updateSandbox(model/provider) is called AFTER createSandbox", () => {
    // updateSandbox() silently no-ops when the entry does not exist yet.
    // This asserts that the model/provider update comes AFTER createSandbox()
    // returns, not before registerSandbox() is called (the original bug).
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );
    const createSandboxPos = source.indexOf("sandboxName = await createSandbox(");
    assert.ok(createSandboxPos !== -1, "createSandbox call not found in onboard.ts");
    const updateAfterCreate = source.indexOf(
      "registry.updateSandbox(sandboxName, { model, provider })",
      createSandboxPos,
    );
    assert.ok(
      updateAfterCreate !== -1,
      "registry.updateSandbox(model, provider) must appear AFTER createSandbox() — regression #1881",
    );
  });

  // ── Base image digest pinning (#1904) ──────────────────────────

  it("patchStagedDockerfile rewrites ARG BASE_IMAGE when baseImageRef is provided", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-base-image-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        "ARG NEMOCLAW_BUILD_ID=default",
      ].join("\n"),
    );

    const fakeRef =
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:19999",
        "build-pin",
        "openai-api",
        null,
        null,
        [],
        {},
        {},
        fakeRef,
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(patched, /^ARG BASE_IMAGE=ghcr\.io\/nvidia\/nemoclaw\/sandbox-base@sha256:a{64}$/m);
      // Model patching still works alongside base image pinning
      assert.match(patched, /^ARG NEMOCLAW_MODEL=gpt-5\.4$/m);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("patchStagedDockerfile preserves ARG BASE_IMAGE when baseImageRef is null", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-base-image-null-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        "ARG NEMOCLAW_BUILD_ID=default",
      ].join("\n"),
    );

    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:19999",
        "build-nopin",
        "openai-api",
        null,
        null,
        [],
        {},
        {},
        null,
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(
        patched,
        /^ARG BASE_IMAGE=ghcr\.io\/nvidia\/nemoclaw\/sandbox-base:latest$/m,
        "BASE_IMAGE should remain unchanged when baseImageRef is null",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("patchStagedDockerfile is safe when Dockerfile has no ARG BASE_IMAGE line", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-no-base-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        "ARG NEMOCLAW_BUILD_ID=default",
      ].join("\n"),
    );

    const fakeRef =
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:19999",
        "build-nobase",
        "openai-api",
        null,
        null,
        [],
        {},
        {},
        fakeRef,
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      // No ARG BASE_IMAGE in original, so the ref should not appear
      assert.ok(!patched.includes("ARG BASE_IMAGE="), "Should not inject BASE_IMAGE when line is absent");
      // Other patching should still work
      assert.match(patched, /^ARG NEMOCLAW_MODEL=gpt-5\.4$/m);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("regression #1904: BASE_IMAGE must reference sandbox-base, not openshell-community", () => {
    // This is the exact bug that broke all e2e tests in PR #1937:
    // the code read a digest from blueprint.yaml (openshell-community registry)
    // and applied it to nemoclaw/sandbox-base (different registry).
    // Verify that patchStagedDockerfile only writes refs to sandbox-base.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-regression-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        "ARG NEMOCLAW_BUILD_ID=default",
      ].join("\n"),
    );

    const correctRef =
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:19999",
        "build-regression",
        "openai-api",
        null,
        null,
        [],
        {},
        {},
        correctRef,
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      const baseLine = patched.split("\n").find((l) => l.startsWith("ARG BASE_IMAGE="));
      assert.ok(baseLine, "ARG BASE_IMAGE line must exist");
      assert.ok(
        baseLine.includes("nemoclaw/sandbox-base"),
        `BASE_IMAGE must reference nemoclaw/sandbox-base, got: ${baseLine}`,
      );
      assert.ok(
        !baseLine.includes("openshell-community"),
        `BASE_IMAGE must NOT reference openshell-community — regression #1937. Got: ${baseLine}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("patchStagedDockerfile does NOT overwrite custom --from BASE_IMAGE that differs from sandbox-base", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-custom-base-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    const customBase = "my-registry.example.com/my-custom-image:v2";
    fs.writeFileSync(
      dockerfilePath,
      [
        `ARG BASE_IMAGE=${customBase}`,
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        "ARG NEMOCLAW_BUILD_ID=default",
      ].join("\n"),
    );

    const sandboxRef =
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:19999",
        "build-custom",
        "openai-api",
        null,
        null,
        [],
        {},
        {},
        sandboxRef,
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      const baseLine = patched.split("\n").find((l) => l.startsWith("ARG BASE_IMAGE="));
      assert.ok(baseLine, "ARG BASE_IMAGE line must exist");
      assert.ok(
        baseLine.includes(customBase),
        `Custom --from BASE_IMAGE must be preserved, got: ${baseLine}`,
      );
      assert.ok(
        !baseLine.includes("sandbox-base"),
        `Custom --from BASE_IMAGE must NOT be overwritten with sandbox-base, got: ${baseLine}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("regression #1904: pullAndResolveBaseImageDigest uses sandbox-base registry", () => {
    // Structural check: verify the constant matches the Dockerfile default
    // and does NOT reference the openshell-community registry.
    assert.ok(
      SANDBOX_BASE_IMAGE.includes("nemoclaw/sandbox-base"),
      `SANDBOX_BASE_IMAGE must reference nemoclaw/sandbox-base, got: ${SANDBOX_BASE_IMAGE}`,
    );
    assert.ok(
      !SANDBOX_BASE_IMAGE.includes("openshell-community"),
      `SANDBOX_BASE_IMAGE must NOT reference openshell-community, got: ${SANDBOX_BASE_IMAGE}`,
    );
  });

  it("regression #1904: createSandbox calls pullAndResolveBaseImageDigest before patchStagedDockerfile", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );
    const pullPos = source.indexOf("pullAndResolveBaseImageDigest()");
    assert.ok(pullPos !== -1, "pullAndResolveBaseImageDigest() call not found in onboard.ts");
    const patchPos = source.indexOf("patchStagedDockerfile(", pullPos);
    assert.ok(
      patchPos > pullPos,
      "pullAndResolveBaseImageDigest must be called BEFORE patchStagedDockerfile — regression #1904",
    );
  });
});
