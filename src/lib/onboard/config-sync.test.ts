// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildSandboxConfigSyncScript, writeSandboxConfigSyncFile } from "./config-sync";

describe("sandbox config sync helpers", () => {
  it("builds a sandbox sync script that records provider selection without rewriting OpenClaw config", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      provider: "compatible-endpoint",
      providerLabel: "Other OpenAI-compatible endpoint",
    });

    expect(script).toMatch(/cat > ~\/\.nemoclaw\/config\.json/);
    expect(script).toContain('"model": "nemotron-3-nano:30b"');
    expect(script).toContain('"credentialEnv": "OPENAI_API_KEY"');
    expect(script).not.toMatch(/cat > ~\/\.openclaw\/openclaw\.json/);
    expect(script).not.toMatch(/openclaw models set/);
    expect(script).toMatch(/config_dir=\/sandbox\/\.openclaw/);
    expect(script).toMatch(/chmod -R g\+rwX,o-rwx "\$config_dir"/);
    expect(script).toMatch(/find "\$config_dir" -type d -exec chmod g\+s \{\} \+/);
    expect(script).toMatch(/chmod 2770 "\$config_dir"/);
    expect(script).toMatch(
      /chmod 660 "\$config_dir\/openclaw\.json" "\$config_dir\/\.config-hash"/,
    );
    expect(script).toMatch(/\[ "\$config_dir_owner" != "root" \]/);
    expect(script).toMatch(/^\s*exit$/m);
  });

  it("keeps Bedrock Runtime adapter credentials out of sandbox selection config", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      profile: "inference-local",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      provider: "compatible-anthropic-endpoint",
      providerLabel: "Other Anthropic-compatible endpoint",
    });

    expect(script).toContain('"endpointUrl": "https://inference.local/v1"');
    expect(script).toContain('"credentialEnv": "COMPATIBLE_ANTHROPIC_API_KEY"');
    expect(script).not.toContain("NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN");
    expect(script).not.toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(script).not.toContain("adapter-token");
    expect(script).not.toContain("bedrock-bearer");
    expect(script).not.toContain("bedrock-runtime.us-east-1.amazonaws.com");
  });

  it("writes sandbox sync scripts to a mkdtemp-backed temp file", () => {
    const scriptFile = writeSandboxConfigSyncFile("echo test");
    try {
      expect(scriptFile).toMatch(/nemoclaw-sync.*\.sh$/);
      expect(fs.readFileSync(scriptFile, "utf8")).toBe("echo test\n");
      const parentDir = path.dirname(scriptFile);
      expect(parentDir).not.toBe(os.tmpdir());
      expect(parentDir).toContain("nemoclaw-sync");
      if (process.platform !== "win32") {
        const stat = fs.statSync(scriptFile);
        expect(stat.mode & 0o777).toBe(0o600);
      }
    } finally {
      const parentDir = path.dirname(scriptFile);
      if (parentDir !== os.tmpdir() && path.basename(parentDir).startsWith("nemoclaw-sync-")) {
        fs.rmSync(parentDir, { recursive: true, force: true });
      }
    }
  });
});
