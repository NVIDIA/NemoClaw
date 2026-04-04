// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSandboxConfigSyncScript,
  classifySandboxCreateFailure,
  getGatewayReuseState,
  getPortConflictServiceHints,
  getFutureShellPathHint,
  getSandboxInferenceConfig,
  getInstalledOpenshellVersion,
  getRequestedModelHint,
  getRequestedProviderHint,
  getRequestedSandboxNameHint,
  getResumeConfigConflicts,
  getResumeSandboxConflict,
  getSandboxStateFromOutputs,
  getStableGatewayImageRef,
  isGatewayHealthy,
  classifyValidationFailure,
  isLoopbackHostname,
  normalizeProviderBaseUrl,
  patchStagedDockerfile,
  printSandboxCreateRecoveryHints,
  resolveDashboardForwardTarget,
  shouldIncludeBuildContextPath,
  writeSandboxConfigSyncFile,
} from "../bin/lib/onboard";
import { buildWebSearchDockerConfig } from "../dist/lib/web-search";

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
        "ARG NEMOCLAW_WEB_CONFIG_B64=e30=",
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
        "ARG NEMOCLAW_WEB_CONFIG_B64=e30=",
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
        "ARG NEMOCLAW_WEB_CONFIG_B64=e30=",
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
      const expected = buildWebSearchDockerConfig({ fetchEnabled: true }, "brv-test-key");
      assert.match(
        patched,
        new RegExp(
          `^ARG NEMOCLAW_WEB_CONFIG_B64=${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "m",
        ),
      );
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
    ).toBe("active-unnamed");
    expect(
      getGatewayReuseState(
        "Gateway status: Connected",
        "",
        "Gateway Info\n\n  Gateway: openshell\n  Gateway endpoint: https://127.0.0.1:8080",
      ),
    ).toBe("foreign-active");
    expect(getGatewayReuseState("", "")).toBe("missing");
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

  it("passes credential names to openshell without embedding secret values in argv", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-inference-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-inference-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));

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
    assert.equal(commands.length, 3);
    assert.match(commands[0].command, /gateway' 'select' 'nemoclaw'/);
    assert.match(commands[1].command, /'--credential' 'NVIDIA_API_KEY'/);
    assert.doesNotMatch(commands[1].command, /nvapi-secret-value/);
    assert.match(commands[1].command, /provider' 'create'/);
    assert.match(commands[2].command, /inference' 'set'/);
  });

  it("detects when the live inference route already matches the requested provider and model", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-inference-ready-"));
    const fakeOpenshell = path.join(tmpDir, "openshell");
    const scriptPath = path.join(tmpDir, "inference-ready-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));

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
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));

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
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));

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
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));

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
    assert.equal(commands.length, 3);
    assert.match(commands[0].command, /gateway' 'select' 'nemoclaw'/);
    assert.match(commands[1].command, /'--type' 'anthropic'/);
    assert.match(commands[1].command, /'--credential' 'ANTHROPIC_API_KEY'/);
    assert.doesNotMatch(commands[1].command, /sk-ant-secret-value/);
    assert.match(commands[2].command, /'--provider' 'anthropic-prod'/);
  });

  it("updates OpenAI-compatible providers without passing an unsupported --type flag", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-openai-update-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-openai-update-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});

const commands = [];
let callIndex = 0;
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  callIndex += 1;
  return { status: callIndex === 2 ? 1 : 0 };
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
    assert.match(commands[1].command, /provider' 'create'/);
    assert.match(commands[2].command, /provider' 'update' 'openai-api'/);
    assert.doesNotMatch(commands[2].command, /'--type'/);
    assert.match(commands[3].command, /inference' 'set' '--no-verify'/);
  });

  it("re-prompts for credentials when openshell inference set fails with authorization errors", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-apply-auth-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-inference-auth-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "credentials.js"));

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
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "credentials.js"));

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
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "lib", "onboard.js"),
      "utf-8",
    );

    assert.match(source, /return \["--connect-timeout", "10", "--max-time", "60"\];/);
    assert.match(source, /failure\.curlStatus === 2/);
    assert.match(source, /local curl invocation error/);
  });

  it("suppresses expected provider-create AlreadyExists noise when update succeeds", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "lib", "onboard.js"),
      "utf-8",
    );

    assert.match(source, /stdio: \["ignore", "pipe", "pipe"\]/);
    assert.match(source, /console\.log\(`✓ Created provider \$\{name\}`\)/);
    assert.match(source, /console\.log\(`✓ Updated provider \$\{name\}`\)/);
  });

  it("starts the sandbox step before prompting for the sandbox name", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "lib", "onboard.js"),
      "utf-8",
    );

    assert.match(
      source,
      /startRecordedStep\("sandbox", \{ sandboxName, provider, model \}\);\s*sandboxName = await createSandbox\(\s*gpu,\s*model,\s*provider,\s*preferredInferenceApi,\s*sandboxName,\s*webSearchConfig,\s*\);/,
    );
  });

  it("prints numbered step headers even when onboarding skips resumed steps", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "lib", "onboard.js"),
      "utf-8",
    );

    assert.match(source, /const ONBOARD_STEP_INDEX = \{/);
    assert.match(source, /function skippedStepMessage\(stepName, detail, reason = "resume"\)/);
    assert.match(source, /step\(stepInfo\.number, 7, stepInfo\.title\);/);
    assert.match(source, /skippedStepMessage\("openclaw", sandboxName\)/);
    assert.match(
      source,
      /skippedStepMessage\("policies", \(recordedPolicyPresets \|\| \[\]\)\.join\(", "\)\)/,
    );
  });

  it("surfaces sandbox-create phases and silence heartbeats during long image operations", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "lib", "onboard.js"),
      "utf-8",
    );

    assert.match(source, /function setPhase\(nextPhase\)/);
    assert.match(source, /Building sandbox image\.\.\./);
    assert.match(source, /Uploading image into OpenShell gateway\.\.\./);
    assert.match(source, /Creating sandbox in gateway\.\.\./);
    assert.match(source, /Still building sandbox image\.\.\. \(\$\{elapsed\}s elapsed\)/);
    assert.match(
      source,
      /Still uploading image into OpenShell gateway\.\.\. \(\$\{elapsed\}s elapsed\)/,
    );
  });

  it("hydrates stored provider credentials when setupInference runs without process env set", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-resume-cred-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-resume-credential-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "credentials.js"));

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
    assert.equal(payload.commands[1].env.OPENAI_API_KEY, "sk-stored-secret");
    assert.doesNotMatch(payload.commands[1].command, /sk-stored-secret/);
  });

  it("drops stale local sandbox registry entries when the live sandbox is gone", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-stale-sandbox-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "stale-sandbox-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));

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
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "credentials.js"));

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
  if (command.includes("sandbox exec my-assistant curl -sf http://localhost:18789/")) return "ok";
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
      payload.commands.some((entry) =>
        entry.command.includes("'forward' 'start' '--background' '18789' 'my-assistant'"),
      ),
      "expected default loopback dashboard forward",
    );
  });

  it("binds the dashboard forward to 0.0.0.0 when CHAT_UI_URL points to a remote host", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-remote-forward-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-remote-forward.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "credentials.js"));

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
  if (command.includes("sandbox exec my-assistant curl -sf http://localhost:18789/")) return "ok";
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

  it("continues once the sandbox is Ready even if the create stream never closes", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-create-ready-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-ready-check.js");
    const payloadPath = path.join(tmpDir, "payload.json");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "credentials.js"));

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
  if (command.includes("sandbox exec my-assistant curl -sf http://localhost:18789/")) return "ok";
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));

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
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));

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
    assert.equal(commands.length, 3);
  });

  it("accepts gateway inference output that omits the Route line", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-inference-route-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "inference-route-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));

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
    assert.equal(commands.length, 3);
  });

  it("re-prompts on invalid sandbox names instead of exiting in interactive mode", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "lib", "onboard.js"),
      "utf-8",
    );
    // Extract the promptValidatedSandboxName function body
    const fnMatch = source.match(
      /async function promptValidatedSandboxName\(\)\s*\{([\s\S]*?)\n\}/,
    );
    assert.ok(fnMatch, "promptValidatedSandboxName function not found");
    const fnBody = fnMatch[1];
    // Verify the retry loop exists within this function
    assert.match(fnBody, /while\s*\(true\)/);
    assert.match(fnBody, /Please try again/);
    // Non-interactive still exits within this function
    assert.match(fnBody, /isNonInteractive\(\)/);
    assert.match(fnBody, /process\.exit\(1\)/);
  });
});
