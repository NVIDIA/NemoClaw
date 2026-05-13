// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
});
