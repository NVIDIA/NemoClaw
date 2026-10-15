// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

async function backupWithOpenClawApiKey(
  apiKey: string,
  providerName = "inference",
  baseUrl = "https://integrate.api.nvidia.com/v1",
  otherProviders: Record<string, { apiKey: string; baseUrl: string }> = {},
  additionalConfig: Record<string, unknown> = {},
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-nvidia-backup-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  const nativeRoot = path.join(home, "native-home");
  const configPath = path.join(nativeRoot, ".openclaw", "openclaw.json");
  const config = {
    gateway: { auth: { token: "machine-local-token" }, port: 18789 },
    models: {
      providers: {
        [providerName]: { apiKey, baseUrl, api: "openai-completions" },
        ...otherProviders,
      },
    },
    ...additionalConfig,
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: { alpha: { name: "alpha", provider: "nvidia-prod", model: "old-model" } },
    }),
  );
  const sandboxState = await import("../../src/lib/state/sandbox");
  const backup = sandboxState.backupSandboxState("alpha", {
    nativeStateSource: {
      root: "/sandbox",
      directory: nativeRoot,
      assertCurrent: () => undefined,
    },
  });
  return { home, config, configPath, sandboxState, backup };
}

function cleanup(home: string): void {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(home, { recursive: true, force: true });
}

it("archives the generated NVIDIA inference reference without machine-local auth (#13018)", async () => {
  const result = await backupWithOpenClawApiKey("${NVIDIA_INFERENCE_API_KEY}");
  try {
    expect(result.backup.success, result.backup.error).toBe(true);
    result.sandboxState.inspectNativeSandboxState(
      result.backup.manifest!.backupPath,
      (root: string) => {
        const archived = JSON.parse(
          fs.readFileSync(path.join(root, ".openclaw", "openclaw.json"), "utf8"),
        );
        expect(archived.gateway.port).toBe(18789);
        expect(archived.gateway.auth).toBeUndefined();
        expect(archived.models.providers.inference.apiKey).toBe("${NVIDIA_INFERENCE_API_KEY}");
      },
      ".openclaw/openclaw.json",
    );
    expect(JSON.parse(fs.readFileSync(result.configPath, "utf8"))).toEqual(result.config);
  } finally {
    cleanup(result.home);
  }
});

it("rejects an opaque credential assignment beside the approved NVIDIA reference (#13018)", async () => {
  const result = await backupWithOpenClawApiKey(
    "${NVIDIA_INFERENCE_API_KEY}",
    "inference",
    "https://integrate.api.nvidia.com/v1",
    {},
    { notes: "PASSWORD=abc12345" },
  );
  try {
    expect(result.backup.success).toBe(false);
    expect(result.backup.error).toContain("credential-bearing or uninspectable content");
    expect(result.backup.error).toContain("./.openclaw/openclaw.json");
    const backupRoot = path.join(result.home, ".nemoclaw", "rebuild-backups", "alpha");
    expect(fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : []).toEqual([]);
  } finally {
    cleanup(result.home);
  }
});

it.each(["${NVIDIA_INFERENCE_API_KEY}-extra", "nvapi-real-key-material"])(
  "rejects OpenClaw config with apiKey %s without publishing an archive (#13018)",
  async (apiKey) => {
    const result = await backupWithOpenClawApiKey(apiKey);
    try {
      expect(result.backup.success).toBe(false);
      expect(result.backup.error).toContain("credential-bearing or uninspectable content");
      expect(result.backup.error).toContain("./.openclaw/openclaw.json");
      expect(JSON.parse(fs.readFileSync(result.configPath, "utf8"))).toEqual(result.config);
      const backupRoot = path.join(result.home, ".nemoclaw", "rebuild-backups", "alpha");
      expect(fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : []).toEqual([]);
    } finally {
      cleanup(result.home);
    }
  },
);

it.each([
  ["inference", "https://attacker.example/v1"],
  ["other-provider", "https://integrate.api.nvidia.com/v1"],
])(
  "rejects the NVIDIA reference in provider %s at %s without publishing an archive (#13018)",
  async (providerName, baseUrl) => {
    const result = await backupWithOpenClawApiKey(
      "${NVIDIA_INFERENCE_API_KEY}",
      providerName,
      baseUrl,
    );
    try {
      expect(result.backup.success).toBe(false);
      expect(result.backup.error).toContain("credential-bearing or uninspectable content");
      expect(result.backup.error).toContain("./.openclaw/openclaw.json");
      expect(JSON.parse(fs.readFileSync(result.configPath, "utf8"))).toEqual(result.config);
      const backupRoot = path.join(result.home, ".nemoclaw", "rebuild-backups", "alpha");
      expect(fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : []).toEqual([]);
    } finally {
      cleanup(result.home);
    }
  },
);

it("rejects a second provider using the NVIDIA reference beside the generated route (#13018)", async () => {
  const result = await backupWithOpenClawApiKey(
    "${NVIDIA_INFERENCE_API_KEY}",
    "inference",
    "https://integrate.api.nvidia.com/v1",
    { other: { apiKey: "${NVIDIA_INFERENCE_API_KEY}", baseUrl: "https://attacker.example/v1" } },
  );
  try {
    expect(result.backup.success).toBe(false);
    expect(result.backup.error).toContain("credential-bearing or uninspectable content");
    expect(JSON.parse(fs.readFileSync(result.configPath, "utf8"))).toEqual(result.config);
    const backupRoot = path.join(result.home, ".nemoclaw", "rebuild-backups", "alpha");
    expect(fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : []).toEqual([]);
  } finally {
    cleanup(result.home);
  }
});
