// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { buildExportConfig } from "../../../src/lib/domain/config/export-document.ts";
import type { VerifiedExportSource } from "../../../src/lib/domain/config/export-evidence.ts";
import {
  parseNemoClawConfigDocumentName,
  parseNemoClawConfigDocumentUid,
} from "../../../src/lib/config/model.ts";
import { describe, expect, it, vi } from "vitest";

import {
  assertBraveConfig,
  assertBraveExport,
  completeBraveConfigExport,
} from "../live/brave-search-helpers.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { isPodmanConfigExportRefusal } from "../fixtures/phases/config-export-validation.ts";

const VERSIONED_PLACEHOLDER = "openshell:resolve:env:v12590243949725316565_BRAVE_API_KEY";
const UNVERSIONED_PLACEHOLDER = "openshell:resolve:env:BRAVE_API_KEY";
const SYNTHETIC_SECRET = "synthetic-brave-secret";
const INTERNAL_TRANSPORT = "openshell:resolve:env";

function unicodeEscape(value: string): string {
  return [...value]
    .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .join("");
}

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
  it("returns the expected public spec without comparing generated document identity (#10904)", () => {
    const document = exportedBraveConfig();
    expect(assertBraveExport(YAML.stringify(document), ["synthetic-secret"])).toEqual(
      document.spec,
    );
  });

  it.each([
    ["base64 credential", Buffer.from(SYNTHETIC_SECRET, "utf8").toString("base64")],
    ["escaped credential", unicodeEscape(SYNTHETIC_SECRET)],
    ["base64 transport", Buffer.from(INTERNAL_TRANSPORT, "utf8").toString("base64")],
    ["escaped transport", unicodeEscape(INTERNAL_TRANSPORT)],
  ])("rejects %s material without echoing it (#10904)", (_case, value) => {
    const validExport = YAML.stringify(exportedBraveConfig());
    let error: unknown;
    try {
      assertBraveExport(`${validExport}\n# ${value}\n`, [SYNTHETIC_SECRET]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(SYNTHETIC_SECRET);
  });

  it("requires the expected Brave integration for this live scenario (#10904)", () => {
    const document = exportedBraveConfig();
    Object.assign(document.spec.sandboxes[0]!, { integrations: undefined });
    expect(() => assertBraveExport(YAML.stringify(document), [])).toThrow();
  });
});

const diagnostic = JSON.stringify({
  error: {
    oclif: { exit: 2 },
    message:
      "Config export failed (unsupported).\nV1alpha1 export currently supports the Docker runtime; Podman compatibility is deferred.",
  },
});
const refusal = { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: diagnostic };

it.each([
  { name: "stderr refusal", result: {}, outputExists: false, accepted: true },
  {
    name: "stdout refusal",
    result: { stdout: diagnostic, stderr: "" },
    outputExists: false,
    accepted: true,
  },
  { name: "published output", result: {}, outputExists: true, accepted: false },
  {
    name: "malformed diagnostic",
    result: { stderr: "synthetic-secret" },
    outputExists: false,
    accepted: false,
  },
  { name: "timeout", result: { timedOut: true }, outputExists: false, accepted: false },
  { name: "signal", result: { signal: "SIGTERM" as const }, outputExists: false, accepted: false },
  { name: "successful export", result: { exitCode: 0 }, outputExists: false, accepted: false },
  { name: "non-JSON exit status", result: { exitCode: 2 }, outputExists: false, accepted: false },
  {
    name: "another unsupported feature",
    result: {
      stderr: JSON.stringify({
        error: { message: "Config export failed (unsupported).\nOther unsupported feature." },
      }),
    },
    outputExists: false,
    accepted: false,
  },
])("classifies $name as Podman export refusal evidence", ({ result, outputExists, accepted }) => {
  expect(isPodmanConfigExportRefusal({ ...refusal, ...result }, outputExists)).toBe(accepted);
});

it.each(["docker", "podman"] as const)(
  "selects the supported Brave export checks for %s",
  async (runtime) => {
    const verifyDockerExport = vi.fn();
    const writeJson = vi.fn();
    await completeBraveConfigExport(
      runtime,
      { writeJson } as unknown as ArtifactSink,
      verifyDockerExport,
    );
    expect(verifyDockerExport).toHaveBeenCalledTimes(runtime === "docker" ? 1 : 0);
    expect(writeJson.mock.calls).toEqual(
      runtime === "docker"
        ? []
        : [
            [
              "brave-config-export-evidence.json",
              {
                sandboxName: process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-brave-search",
                runtimeProvider: "podman",
                classification: "expected-refusal",
                refusalCategory: "unsupported",
                outputPublished: false,
              },
            ],
          ],
    );
  },
);
