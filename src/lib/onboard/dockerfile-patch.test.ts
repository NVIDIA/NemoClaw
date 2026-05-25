// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  encodeDockerJsonArg,
  isValidProxyHost,
  isValidProxyPort,
  patchStagedDockerfile,
} from "../../../dist/lib/onboard/dockerfile-patch";

const tmpRoots: string[] = [];

function dockerfileWith(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-patch-test-"));
  tmpRoots.push(dir);
  const file = path.join(dir, "Dockerfile");
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.NEMOCLAW_PROXY_HOST;
  delete process.env.NEMOCLAW_PROXY_PORT;
});

describe("dockerfile patch helpers", () => {
  it("encodes Docker JSON ARG values as base64 JSON", () => {
    expect(Buffer.from(encodeDockerJsonArg({ supportsStore: false }), "base64").toString("utf-8")).toBe(
      JSON.stringify({ supportsStore: false }),
    );
    expect(Buffer.from(encodeDockerJsonArg(null), "base64").toString("utf-8")).toBe("{}");
    expect(Buffer.from(encodeDockerJsonArg(false), "base64").toString("utf-8")).toBe("false");
  });

  it("validates proxy host and port values", () => {
    expect(isValidProxyHost("host.docker.internal")).toBe(true);
    expect(isValidProxyHost("10.200.0.1")).toBe(true);
    expect(isValidProxyHost("bad:ipv6::host")).toBe(false);
    expect(isValidProxyPort("1")).toBe(true);
    expect(isValidProxyPort("65535")).toBe(true);
    expect(isValidProxyPort("0")).toBe(false);
    expect(isValidProxyPort("70000")).toBe(false);
  });

  it("patches base image, inference, proxy, and messaging args", () => {
    process.env.NEMOCLAW_PROXY_HOST = "host.docker.internal";
    process.env.NEMOCLAW_PROXY_PORT = "3128";
    const dockerfilePath = dockerfileWith(
      [
        "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
        "ARG NEMOCLAW_MODEL=old",
        "ARG NEMOCLAW_PROVIDER_KEY=old",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=old",
        "ARG CHAT_UI_URL=old",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=old",
        "ARG NEMOCLAW_INFERENCE_API=old",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=old",
        "ARG NEMOCLAW_BUILD_ID=old",
        "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
        "ARG NEMOCLAW_PROXY_HOST=old",
        "ARG NEMOCLAW_PROXY_PORT=old",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        "ARG NEMOCLAW_DISABLE_DEVICE_AUTH=0",
        "ARG NEMOCLAW_MESSAGING_CHANNELS_B64=old",
        "ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=old",
        "ARG NEMOCLAW_DISCORD_GUILDS_B64=old",
        "ARG NEMOCLAW_TELEGRAM_CONFIG_B64=old",
      ].join("\n"),
    );

    patchStagedDockerfile(
      dockerfilePath,
      "custom-model",
      "https://chat.example",
      "build-1",
      "compatible-endpoint",
      null,
      { fetchEnabled: true },
      ["telegram"],
      { telegram: ["123"] },
      { discord: ["456"] },
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abc",
      { requireMention: true },
      {},
      true,
    );

    const patched = fs.readFileSync(dockerfilePath, "utf-8");
    expect(patched).toContain("ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abc");
    expect(patched).toContain("ARG NEMOCLAW_MODEL=custom-model");
    expect(patched).toContain("ARG NEMOCLAW_PROVIDER_KEY=inference");
    expect(patched).toContain("ARG NEMOCLAW_PRIMARY_MODEL_REF=inference/custom-model");
    expect(patched).toContain("ARG CHAT_UI_URL=https://chat.example");
    expect(patched).toContain("ARG NEMOCLAW_INFERENCE_COMPAT_B64=");
    expect(patched).toContain("ARG NEMOCLAW_BUILD_ID=build-1");
    expect(patched).toContain("ARG NEMOCLAW_DARWIN_VM_COMPAT=1");
    expect(patched).toContain("ARG NEMOCLAW_PROXY_HOST=host.docker.internal");
    expect(patched).toContain("ARG NEMOCLAW_PROXY_PORT=3128");
    expect(patched).toContain("ARG NEMOCLAW_WEB_SEARCH_ENABLED=1");
    expect(patched).toContain("ARG NEMOCLAW_DISABLE_DEVICE_AUTH=1");
    expect(patched).not.toContain("ARG NEMOCLAW_MESSAGING_CHANNELS_B64=old");
    expect(patched).not.toContain("ARG NEMOCLAW_TELEGRAM_CONFIG_B64=old");
  });

  it("uses the shared sandbox inference mapping", () => {
    const dockerfilePath = dockerfileWith(
      [
        "ARG NEMOCLAW_MODEL=old",
        "ARG NEMOCLAW_PROVIDER_KEY=old",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=old",
        "ARG CHAT_UI_URL=old",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=old",
        "ARG NEMOCLAW_INFERENCE_API=old",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=old",
        "ARG NEMOCLAW_BUILD_ID=old",
        "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
      ].join("\n"),
    );

    patchStagedDockerfile(
      dockerfilePath,
      "moonshotai/kimi-k2.6",
      "https://chat.example",
      "build-1",
      "hermes-provider",
    );

    const patched = fs.readFileSync(dockerfilePath, "utf-8");
    const compat = patched.match(/^ARG NEMOCLAW_INFERENCE_COMPAT_B64=(.+)$/m)?.[1];
    expect(patched).toContain("ARG NEMOCLAW_PROVIDER_KEY=inference");
    expect(patched).toContain("ARG NEMOCLAW_PRIMARY_MODEL_REF=inference/moonshotai/kimi-k2.6");
    expect(compat).toBeDefined();
    expect(Buffer.from(compat || "", "base64").toString("utf-8")).toBe(
      JSON.stringify({ supportsStore: false }),
    );
  });

  it("can override the sandbox inference base URL for Docker GPU host networking", () => {
    const dockerfilePath = dockerfileWith(
      [
        "ARG NEMOCLAW_MODEL=old",
        "ARG NEMOCLAW_PROVIDER_KEY=old",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=old",
        "ARG CHAT_UI_URL=old",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=old",
        "ARG NEMOCLAW_INFERENCE_API=old",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=old",
        "ARG NEMOCLAW_BUILD_ID=old",
        "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
      ].join("\n"),
    );

    patchStagedDockerfile(
      dockerfilePath,
      "qwen2.5:7b",
      "https://chat.example",
      "build-1",
      "ollama-local",
      null,
      null,
      [],
      {},
      {},
      null,
      {},
      {},
      false,
      "http://127.0.0.1:11434/v1",
    );

    const patched = fs.readFileSync(dockerfilePath, "utf-8");
    expect(patched).toContain("ARG NEMOCLAW_INFERENCE_BASE_URL=http://127.0.0.1:11434/v1");
  });

  it("strips CR/LF from Dockerfile ARG interpolations", () => {
    const dockerfilePath = dockerfileWith(
      [
        "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
        "ARG NEMOCLAW_MODEL=old",
        "ARG NEMOCLAW_PROVIDER_KEY=old",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=old",
        "ARG CHAT_UI_URL=old",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=old",
        "ARG NEMOCLAW_INFERENCE_API=old",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=old",
        "ARG NEMOCLAW_BUILD_ID=old",
        "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
      ].join("\n"),
    );

    patchStagedDockerfile(
      dockerfilePath,
      "model\nRUN touch /tmp/model-pwn",
      "https://chat.example\r\nRUN touch /tmp/chat-pwn",
      "build-1\nRUN touch /tmp/build-pwn",
      "compatible-endpoint",
      "openai-responses\nRUN touch /tmp/api-pwn",
      null,
      [],
      {},
      {},
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abc\nRUN touch /tmp/base-pwn",
    );

    const patched = fs.readFileSync(dockerfilePath, "utf-8");
    expect(patched).not.toMatch(/\r|\nRUN touch/);
    expect(patched).toContain("ARG NEMOCLAW_MODEL=modelRUN touch /tmp/model-pwn");
    expect(patched).toContain("ARG CHAT_UI_URL=https://chat.exampleRUN touch /tmp/chat-pwn");
    expect(patched).toContain("ARG NEMOCLAW_BUILD_ID=build-1RUN touch /tmp/build-pwn");
    expect(patched).toContain("ARG NEMOCLAW_INFERENCE_API=openai-responsesRUN touch /tmp/api-pwn");
    expect(patched).toContain(
      "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abcRUN touch /tmp/base-pwn",
    );
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
        "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
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
      assert.match(patched, /^ARG NEMOCLAW_DARWIN_VM_COMPAT=0$/m);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("patches the staged Dockerfile for macOS VM rootfs ownership compatibility", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-darwin-vm-"));
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
        "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
      ].join("\n"),
    );

    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:19999",
        "build-123",
        "openai-api",
        null,
        null,
        [],
        {},
        {},
        null,
        {},
        {},
        true,
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(patched, /^ARG NEMOCLAW_DARWIN_VM_COMPAT=1$/m);
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

  it("#1737: patches the staged Dockerfile with Telegram mention-only config", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-tg-mention-"));
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
        "ARG NEMOCLAW_TELEGRAM_CONFIG_B64=e30=",
        "ARG NEMOCLAW_BUILD_ID=default",
      ].join("\n"),
    );

    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:19999",
        "build-tg-mention",
        "openai-api",
        null,
        null,
        ["telegram"],
        {},
        {},
        null,
        { requireMention: true },
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      const line = patched
        .split("\n")
        .find((l) => l.startsWith("ARG NEMOCLAW_TELEGRAM_CONFIG_B64="));
      assert.ok(line, "expected telegram config build arg");
      const encoded = line.split("=")[1];
      const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      assert.deepEqual(decoded, { requireMention: true });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("#1737: patches the staged Dockerfile with Telegram open-group config when requireMention=false", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-tg-open-"));
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
        "ARG NEMOCLAW_TELEGRAM_CONFIG_B64=e30=",
        "ARG NEMOCLAW_BUILD_ID=default",
      ].join("\n"),
    );

    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:19999",
        "build-tg-open",
        "openai-api",
        null,
        null,
        ["telegram"],
        {},
        {},
        null,
        { requireMention: false },
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      const line = patched
        .split("\n")
        .find((l) => l.startsWith("ARG NEMOCLAW_TELEGRAM_CONFIG_B64="));
      assert.ok(line, "expected telegram config build arg");
      const encoded = line.split("=")[1];
      const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      assert.deepEqual(decoded, { requireMention: false });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("#1737: preserves default Telegram group-open behavior when telegramConfig is empty", () => {
    // Backward compatibility guard: the ARG default stays at e30= ({} base64)
    // and patchStagedDockerfile does not rewrite it when no config is passed.
    // The Dockerfile Python generator reads empty config as requireMention=false
    // which maps to groupPolicy=open (matches pre-#1737 behavior).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-tg-empty-"));
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
        "ARG NEMOCLAW_TELEGRAM_CONFIG_B64=e30=",
        "ARG NEMOCLAW_BUILD_ID=default",
      ].join("\n"),
    );

    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:19999",
        "build-tg-default",
        "openai-api",
        null,
        null,
        ["telegram"],
        {},
        {},
        null,
        {},
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(patched, /^ARG NEMOCLAW_TELEGRAM_CONFIG_B64=e30=$/m);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

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
      assert.match(
        patched,
        /^ARG BASE_IMAGE=ghcr\.io\/nvidia\/nemoclaw\/sandbox-base@sha256:a{64}$/m,
      );
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
      assert.ok(
        !patched.includes("ARG BASE_IMAGE="),
        "Should not inject BASE_IMAGE when line is absent",
      );
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

  it("regression #2421: bakes NEMOCLAW_INFERENCE_INPUTS into the staged Dockerfile when env is set", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-inputs-"));
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
        "ARG NEMOCLAW_INFERENCE_INPUTS=text",
      ].join("\n"),
    );

    const prior = process.env.NEMOCLAW_INFERENCE_INPUTS;
    process.env.NEMOCLAW_INFERENCE_INPUTS = "text,image";
    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:18789",
        "build-inputs",
        "openai-api",
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(patched, /^ARG NEMOCLAW_INFERENCE_INPUTS=text,image$/m);
    } finally {
      if (prior === undefined) {
        delete process.env.NEMOCLAW_INFERENCE_INPUTS;
      } else {
        process.env.NEMOCLAW_INFERENCE_INPUTS = prior;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("regression #2421: rejects malformed NEMOCLAW_INFERENCE_INPUTS and keeps default", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-inputs-bad-"),
    );
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    const baseDockerfile = [
      "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
      "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
      "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
      "ARG CHAT_UI_URL=http://127.0.0.1:18789",
      "ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1",
      "ARG NEMOCLAW_INFERENCE_API=openai-completions",
      "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
      "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
      "ARG NEMOCLAW_BUILD_ID=default",
      "ARG NEMOCLAW_INFERENCE_INPUTS=text",
    ].join("\n");

    const prior = process.env.NEMOCLAW_INFERENCE_INPUTS;
    try {
      // Cases that must all leave the default untouched.
      const rejectCases = [
        undefined,
        "audio",
        "text,",
        "Text,Image",
        "text, image",
        'text"\nRUN rm -rf /',
      ];
      for (const [index, value] of rejectCases.entries()) {
        fs.writeFileSync(dockerfilePath, baseDockerfile);
        if (value === undefined) {
          delete process.env.NEMOCLAW_INFERENCE_INPUTS;
        } else {
          process.env.NEMOCLAW_INFERENCE_INPUTS = value;
        }
        patchStagedDockerfile(
          dockerfilePath,
          "gpt-5.4",
          "http://127.0.0.1:18789",
          `build-inputs-reject-${index}`,
          "openai-api",
        );
        assert.match(
          fs.readFileSync(dockerfilePath, "utf8"),
          /^ARG NEMOCLAW_INFERENCE_INPUTS=text$/m,
          `value="${String(value)}" should not change the ARG default`,
        );
      }
    } finally {
      if (prior === undefined) {
        delete process.env.NEMOCLAW_INFERENCE_INPUTS;
      } else {
        process.env.NEMOCLAW_INFERENCE_INPUTS = prior;
      }
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

  it("#2281: bakes NEMOCLAW_AGENT_TIMEOUT env into the staged Dockerfile", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-timeout-"));
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
        "ARG NEMOCLAW_AGENT_TIMEOUT=600",
      ].join("\n"),
    );

    const priorTimeout = process.env.NEMOCLAW_AGENT_TIMEOUT;
    process.env.NEMOCLAW_AGENT_TIMEOUT = "1800";
    try {
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:18789",
        "build-timeout",
        "openai-api",
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(patched, /^ARG NEMOCLAW_AGENT_TIMEOUT=1800$/m);
    } finally {
      if (priorTimeout === undefined) {
        delete process.env.NEMOCLAW_AGENT_TIMEOUT;
      } else {
        process.env.NEMOCLAW_AGENT_TIMEOUT = priorTimeout;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("#2880: bakes NEMOCLAW_AGENT_HEARTBEAT_EVERY env into the staged Dockerfile", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-heartbeat-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    const baseDockerfile = [
      "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
      "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
      "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
      "ARG CHAT_UI_URL=http://127.0.0.1:18789",
      "ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1",
      "ARG NEMOCLAW_INFERENCE_API=openai-completions",
      "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
      "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
      "ARG NEMOCLAW_BUILD_ID=default",
      "ARG NEMOCLAW_AGENT_HEARTBEAT_EVERY=",
    ].join("\n");

    const prior = process.env.NEMOCLAW_AGENT_HEARTBEAT_EVERY;
    try {
      // Valid duration values bake in.
      for (const value of ["0m", "30m", "5m", "1h", "30s"]) {
        fs.writeFileSync(dockerfilePath, baseDockerfile);
        process.env.NEMOCLAW_AGENT_HEARTBEAT_EVERY = value;
        patchStagedDockerfile(
          dockerfilePath,
          "gpt-5.4",
          "http://127.0.0.1:18789",
          `build-heartbeat-${value}`,
          "openai-api",
        );
        assert.match(
          fs.readFileSync(dockerfilePath, "utf8"),
          new RegExp(`^ARG NEMOCLAW_AGENT_HEARTBEAT_EVERY=${value}$`, "m"),
          `value="${value}" should bake into the ARG line`,
        );
      }

      // Cases that must all leave the empty default untouched (regex rejects
      // these so the OpenClaw default cadence is preserved).
      const rejectCases = [undefined, "", "30 minutes", "5", "5x", "fast"];
      for (const [index, value] of rejectCases.entries()) {
        fs.writeFileSync(dockerfilePath, baseDockerfile);
        if (value === undefined) {
          delete process.env.NEMOCLAW_AGENT_HEARTBEAT_EVERY;
        } else {
          process.env.NEMOCLAW_AGENT_HEARTBEAT_EVERY = value;
        }
        patchStagedDockerfile(
          dockerfilePath,
          "gpt-5.4",
          "http://127.0.0.1:18789",
          `build-heartbeat-reject-${index}`,
          "openai-api",
        );
        assert.match(
          fs.readFileSync(dockerfilePath, "utf8"),
          /^ARG NEMOCLAW_AGENT_HEARTBEAT_EVERY=$/m,
          `value="${String(value)}" should not change the empty ARG default`,
        );
      }
    } finally {
      if (prior === undefined) {
        delete process.env.NEMOCLAW_AGENT_HEARTBEAT_EVERY;
      } else {
        process.env.NEMOCLAW_AGENT_HEARTBEAT_EVERY = prior;
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

});
