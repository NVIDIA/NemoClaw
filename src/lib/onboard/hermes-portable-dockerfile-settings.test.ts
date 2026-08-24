// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { renderHermesPortableDockerfileBuildSettings } from "./dockerfile-patch";

const DOCKERFILE = [
  "ARG TARGETARCH",
  "FROM scratch",
  "ARG NEMOCLAW_MODEL=old",
  "ARG NEMOCLAW_INFERENCE_PROVIDER_ID=old",
  "ARG NEMOCLAW_UPSTREAM_PROVIDER=old",
  "ARG NEMOCLAW_INFERENCE_BASE_URL=old",
  "ARG NEMOCLAW_INFERENCE_API=old",
  "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive",
  "ARG CHAT_UI_URL=http://127.0.0.1:18789",
  "",
].join("\n");

const SETTINGS = {
  model: "qwen3-vl:4b",
  provider: "ollama-local",
  preferredInferenceApi: "openai-completions",
  toolDisclosure: "direct",
} as const;

describe("Hermes portable Dockerfile settings", () => {
  it("renders schema-5 settings through the shared inference owner (#9203)", () => {
    const rendered = renderHermesPortableDockerfileBuildSettings(DOCKERFILE, SETTINGS);

    expect(rendered).toContain("ARG NEMOCLAW_MODEL=qwen3-vl:4b");
    expect(rendered).toContain("ARG NEMOCLAW_INFERENCE_PROVIDER_ID=inference");
    expect(rendered).toContain("ARG NEMOCLAW_UPSTREAM_PROVIDER=ollama-local");
    expect(rendered).toContain("ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1");
    expect(rendered).toContain("ARG NEMOCLAW_INFERENCE_API=openai-completions");
    expect(rendered).toContain("ARG NEMOCLAW_TOOL_DISCLOSURE=direct");
    expect(rendered).toContain("ARG CHAT_UI_URL=\n");
    expect(rendered).toContain("ARG TARGETARCH=amd64\nFROM scratch");
  });

  it("rejects injected or incomplete schema-5 settings (#9203)", () => {
    expect(() =>
      renderHermesPortableDockerfileBuildSettings(DOCKERFILE, {
        ...SETTINGS,
        model: "qwen3-vl:4b\nRUN false",
      }),
    ).toThrow("model build setting is invalid");
    expect(() =>
      renderHermesPortableDockerfileBuildSettings(
        DOCKERFILE.replace("ARG CHAT_UI_URL=http://127.0.0.1:18789\n", ""),
        SETTINGS,
      ),
    ).toThrow("must declare exactly one CHAT_UI_URL");
  });

  it("rejects an incomplete portable target architecture contract (#9203)", () => {
    expect(() =>
      renderHermesPortableDockerfileBuildSettings(
        DOCKERFILE.replace("ARG TARGETARCH\n", ""),
        SETTINGS,
      ),
    ).toThrow("must declare one unpinned global TARGETARCH");
    expect(() =>
      renderHermesPortableDockerfileBuildSettings(
        DOCKERFILE.replace("ARG TARGETARCH\n", "ARG TARGETARCH=amd64\n"),
        SETTINGS,
      ),
    ).toThrow("must declare one unpinned global TARGETARCH");
    expect(() =>
      renderHermesPortableDockerfileBuildSettings(
        DOCKERFILE.replace("FROM scratch\n", ""),
        SETTINGS,
      ),
    ).toThrow("must declare at least one build stage");
  });
});
