// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../index.js";
import { readNativeRoute } from "./native-route.js";

function config(
  apiKey: OpenClawConfig[string],
  baseUrl = "https://native.example/v1",
): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary: "inference/vendor/model" } } },
    models: { providers: { inference: { baseUrl, apiKey } } },
  };
}

describe("native OpenClaw route", () => {
  it.each(["openai", "anthropic", "gemini", "ollama", "vllm", "nim-local", "ncp", "custom"])(
    "reads the native %s provider without a provider-label table",
    (provider) => {
      const native: OpenClawConfig = {
        agents: { defaults: { model: `${provider}/native-model` } },
        models: { providers: { [provider]: { baseUrl: "https://native.example/v1" } } },
      };
      expect(readNativeRoute(native)).toMatchObject({
        model: `${provider}/native-model`,
        provider,
        endpoint: "https://native.example/v1",
        managedModel: undefined,
      });
    },
  );

  it.each(["${EDITED_KEY}", { source: "env", provider: "default", id: "EDITED_KEY" }])(
    "reports only a native environment reference",
    (apiKey) => {
      expect(readNativeRoute(config(apiKey))).toMatchObject({
        credentialEnv: "EDITED_KEY",
        credential: "$EDITED_KEY (set via env var)",
      });
    },
  );

  it.each([
    "private-literal",
    "${bad-ref}",
    { source: "file", id: "/private/token" },
    { source: "env", id: "unsafe\nvalue" },
  ])("does not reveal non-environment credentials", (apiKey) => {
    const route = readNativeRoute(config(apiKey));
    expect(route.credential).toBe("(configured)");
    expect(route.credentialEnv).toBeUndefined();
    expect(JSON.stringify(route)).not.toContain("private");
    expect(JSON.stringify(route)).not.toContain("unsafe");
  });

  it("removes credentials, query values and fragments from endpoint display", () => {
    expect(
      readNativeRoute(config("", "https://user:password@native.example/v1?token=secret#secret")),
    ).toMatchObject({ endpoint: "https://native.example/v1", credential: "(not configured)" });
  });

  it.each(["not-a-url-secret", "file:///private/token"])(
    "does not echo an invalid endpoint",
    (url) => {
      expect(readNativeRoute(config(undefined, url)).endpoint).toBe("(configured)");
    },
  );

  it.each([{}, { agents: { defaults: { model: {} } } }, { agents: { defaults: { model: null } } }])(
    "does not choose a default primary or credential",
    (native) =>
      expect(readNativeRoute(native)).toMatchObject({
        model: "(not configured)",
        provider: "(not configured)",
        managedModel: undefined,
        credentialEnv: undefined,
        endpoint: "(not configured)",
      }),
  );

  it("does not register an inference provider absent from native configuration", () => {
    expect(
      readNativeRoute({ agents: { defaults: { model: "inference/model" } } }).managedModel,
    ).toBeUndefined();
  });
});
