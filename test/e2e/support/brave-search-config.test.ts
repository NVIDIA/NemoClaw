// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { buildExportConfig } from "../../../src/lib/domain/config/export-document.ts";
import type { VerifiedExportSource } from "../../../src/lib/domain/config/export-evidence.ts";
import {
  parseNemoClawConfigDocumentName,
  parseNemoClawConfigDocumentUid,
} from "../../../src/lib/config/model.ts";
import { describe, expect, it } from "vitest";

import { assertBraveConfig, assertBraveExport } from "../live/brave-search-helpers.ts";

const VERSIONED_PLACEHOLDER = "openshell:resolve:env:v12590243949725316565_BRAVE_API_KEY";
const UNVERSIONED_PLACEHOLDER = "openshell:resolve:env:BRAVE_API_KEY";

function openClawConfig(apiKey?: unknown, retiredApiKey?: unknown): string {
  return JSON.stringify({
    tools: {
      web: {
        search: { enabled: true, provider: "brave", apiKey: retiredApiKey },
      },
    },
    plugins: { entries: { brave: { config: { webSearch: { apiKey } } } } },
  });
}

describe("Brave Search E2E configuration assertion", () => {
  it.each([
    ["versioned", VERSIONED_PLACEHOLDER],
    ["unversioned", UNVERSIONED_PLACEHOLDER],
  ])("returns a %s credential placeholder from the Brave plugin configuration", (_case, value) => {
    expect(assertBraveConfig(openClawConfig(value))).toBe(value);
  });

  it.each([
    ["missing", undefined],
    ["raw", "test-raw-brave-key"],
    ["wrong-provider", "openshell:resolve:env:TAVILY_API_KEY"],
    ["noncanonical-prefix", "openshell:resolve:env:OTHER_BRAVE_API_KEY"],
    ["malformed-version-prefix", "openshell:resolve:env:vABC_BRAVE_API_KEY"],
  ])("rejects a %s Brave Search credential value", (_case, apiKey) => {
    expect(() => assertBraveConfig(openClawConfig(apiKey))).toThrow();
  });

  it("rejects a credential from the retired inline search configuration", () => {
    expect(() =>
      assertBraveConfig(openClawConfig(VERSIONED_PLACEHOLDER, "test-raw-brave-key")),
    ).toThrow();
  });
});

function exportedBraveConfig() {
  return buildExportConfig(
    {
      sandboxName: "alpha",
      agent: "openclaw",
      runtime: { provider: "docker", imageRef: "nvcr.io/nvidia/nemoclaw@sha256:" + "a".repeat(64) },
      gateway: { name: "nemoclaw", port: 8080 },
      inference: {
        provider: "nvidia-prod",
        model: "test-model",
        api: "openai-completions",
        endpoint: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      },
      webSearch: {
        provider: "brave",
        agentRefs: ["primary"],
        credential: { env: "BRAVE_API_KEY" },
      },
      policy: {
        version: 1,
        network_policies: {
          brave: {
            name: "brave",
            endpoints: [{ host: "api.search.brave.com", port: 443 }],
            binaries: [{ path: "/usr/bin/node" }],
          },
        },
      },
    } as unknown as VerifiedExportSource,
    {
      documentName: parseNemoClawConfigDocumentName("alpha"),
      documentUid: parseNemoClawConfigDocumentUid("11111111-1111-4111-8111-111111111111"),
    },
  );
}

describe("Brave Search E2E export assertion", () => {
  it("returns the validated public spec without comparing generated document identity (#10904)", () => {
    const document = exportedBraveConfig();
    expect(assertBraveExport(YAML.stringify(document), ["synthetic-secret"])).toEqual(
      document.spec,
    );
  });

  it.each(["synthetic-brave-secret", "synthetic-inference-secret"])(
    "rejects leaked %s before parsing without echoing it (#10904)",
    (secret) => {
      let error: unknown;
      try {
        assertBraveExport(`invalid: [${secret}`, [secret]);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(secret);
    },
  );

  it("validates the whole document, including fields outside the integration (#10904)", () => {
    const document = exportedBraveConfig();
    Object.assign(document, { unexpected: true });
    expect(() => assertBraveExport(YAML.stringify(document), [])).toThrow();
  });

  it("requires the expected Brave integration even when the document schema allows its absence (#10904)", () => {
    const document = exportedBraveConfig();
    Object.assign(document.spec.sandboxes[0]!, { integrations: undefined });
    expect(() => assertBraveExport(YAML.stringify(document), [])).toThrow();
  });
});
