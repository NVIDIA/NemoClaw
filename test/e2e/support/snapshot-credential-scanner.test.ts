// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { SUPPORTED_CREDENTIAL_ENV_NAMES } from "../../../src/lib/security/credential-env.ts";

import {
  MODELS_JSON_CREDENTIAL_ENV_REFERENCES,
  modelsJsonContainsCredentialLeak,
  scanSnapshotCredentialLeaks,
  snapshotFileContainsCredentialLeak,
} from "../live/snapshot-credential-scanner.ts";

describe("snapshot credential scanner", () => {
  it("keeps required provider aliases in the shared credential inventory", () => {
    for (const name of [
      "NVIDIA_API_KEY",
      "OPENROUTER_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "AWS_BEARER_TOKEN_BEDROCK",
      "COMPATIBLE_ANTHROPIC_API_KEY",
    ]) {
      expect(SUPPORTED_CREDENTIAL_ENV_NAMES.has(name), name).toBe(true);
    }
  });

  it("accepts only non-secret environment and secret-reference markers in models.json", () => {
    const body = JSON.stringify({
      providers: {
        compatible: { apiKey: "COMPATIBLE_API_KEY" },
        braced: { apiKey: "${OPENAI_API_KEY}" },
        managed: { apiKey: "secretref-managed" },
        header: { headers: { Authorization: "secretref-env:MODEL_PROVIDER_TOKEN" } },
        proxyInjected: { apiKey: "unused" },
        openShell: { apiKey: "openshell:resolve:env:NVIDIA_INFERENCE_API_KEY" },
        empty: { apiKey: "" },
      },
    });

    expect(modelsJsonContainsCredentialLeak(body)).toBe(false);
  });

  it.each([
    ...MODELS_JSON_CREDENTIAL_ENV_REFERENCES,
  ])("preserves the allowed bare and braced models.json reference marker %s", (name) => {
    expect(
      modelsJsonContainsCredentialLeak(JSON.stringify({ providers: { bare: { apiKey: name } } })),
    ).toBe(false);
    expect(
      modelsJsonContainsCredentialLeak(
        JSON.stringify({ providers: { braced: { apiKey: `\${${name}}` } } }),
      ),
    ).toBe(false);
  });

  it.each([
    ["NVIDIA key", { apiKey: "nvapi-concrete-secret" }],
    ["OpenAI-shaped key", { apiKey: "sk-concrete-secret" }],
    ["bearer token", { Authorization: "Bearer concrete-token" }],
    ["arbitrary credential", { apiKey: "opaque-concrete-value" }],
    ["unrecognized uppercase value", { apiKey: "ARBITRARY_VALUE" }],
    ["structured value", { apiKey: { source: "env", id: "OPENAI_API_KEY" } }],
  ])("rejects a concrete %s in models.json", (_label, provider) => {
    expect(
      modelsJsonContainsCredentialLeak(JSON.stringify({ providers: { test: provider } })),
    ).toBe(true);
  });

  it.each([
    "access_token",
    "secret_key",
    "bearer_token",
    "secretKey",
    "apikey",
  ])("rejects opaque values under the credential field %s", (field) => {
    expect(
      modelsJsonContainsCredentialLeak(
        JSON.stringify({ providers: { test: { [field]: "opaque-concrete-value" } } }),
      ),
    ).toBe(true);
  });

  it("rejects credential assignments and malformed models.json", () => {
    expect(
      modelsJsonContainsCredentialLeak(
        JSON.stringify({ note: "export OPENAI_API_KEY=concrete-secret" }),
      ),
    ).toBe(true);
    expect(
      modelsJsonContainsCredentialLeak(
        JSON.stringify({ nested: { arbitraryField: "Bearer concrete-token" } }),
      ),
    ).toBe(true);
    expect(modelsJsonContainsCredentialLeak('{"providers":')).toBe(true);
  });

  it.each([
    ...SUPPORTED_CREDENTIAL_ENV_NAMES,
  ])("rejects an opaque assignment for the supported credential name %s", (name) => {
    expect(snapshotFileContainsCredentialLeak("runtime.env", `${name}=opaque-value`)).toBe(true);
    expect(snapshotFileContainsCredentialLeak("runtime.env", `export ${name}=opaque-value`)).toBe(
      true,
    );
  });

  it("preserves the existing non-model file boundaries", () => {
    expect(snapshotFileContainsCredentialLeak("openclaw.json", '{"apiKey":"unused"}')).toBe(false);
    expect(
      snapshotFileContainsCredentialLeak("openclaw.json", '{"value":"nvapi-concrete-secret"}'),
    ).toBe(true);
    expect(snapshotFileContainsCredentialLeak("settings.json", '{"apiKey":"opaque"}')).toBe(true);
    expect(snapshotFileContainsCredentialLeak("runtime.env", "OPENAI_API_KEY=concrete")).toBe(true);
    expect(
      snapshotFileContainsCredentialLeak("package-lock.json", '{"apiKey":"sk-lock-metadata"}'),
    ).toBe(false);
  });

  it("walks nested snapshot files and reports only credential-bearing paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-credential-scan-"));
    try {
      const nested = path.join(root, "agents", "main", "agent");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(
        path.join(nested, "models.json"),
        JSON.stringify({ providers: { compatible: { apiKey: "COMPATIBLE_API_KEY" } } }),
      );
      fs.writeFileSync(path.join(root, "safe.json"), JSON.stringify({ enabled: true }));
      fs.writeFileSync(path.join(root, "leaked.env"), "OPENAI_API_KEY=concrete\n");

      expect(scanSnapshotCredentialLeaks(root)).toEqual([path.join(root, "leaked.env")]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
