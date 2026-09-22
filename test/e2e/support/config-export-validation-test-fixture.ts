// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type ConfigExportDocument,
  type ConfigExportEvidenceEnvelope,
  type ConfigExportValidationDependencies,
  ConfigExportValidationPhaseFixture,
} from "../fixtures/phases/config-export-validation.ts";
import type { NemoClawInstance } from "../fixtures/phases/onboarding.ts";
import { SecretStore } from "../fixtures/secrets.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { listTargets } from "../registry/registry.ts";
import type { NemoClawInstanceManifest, TargetDefinition } from "../registry/types.ts";

export const IMAGE_REF = `nvcr.io/nvidia/nemoclaw@sha256:${"a".repeat(64)}`;
export const SOURCE_REVISION = "b".repeat(40);
export const SECRET = "fixture-secret-value";
export const ENCODED_SECRET = Buffer.from(SECRET, "utf8").toString("base64");
export const DIAGNOSTIC_SECRET_REPRESENTATIONS = [
  { name: "literal", value: SECRET },
  { name: "wrapped-literal", value: `${SECRET.slice(0, 7)}\n# ${SECRET.slice(7)}` },
  {
    name: "escaped-literal",
    value: `\\u${SECRET.charCodeAt(0).toString(16).padStart(4, "0")}${SECRET.slice(1)}`,
  },
  { name: "base64", value: ENCODED_SECRET },
  {
    name: "wrapped-base64",
    value: `${ENCODED_SECRET.slice(0, 12)}\n# ${ENCODED_SECRET.slice(12)}`,
  },
  {
    name: "escaped-base64",
    value: `\\u${ENCODED_SECRET.charCodeAt(0).toString(16).padStart(4, "0")}${ENCODED_SECRET.slice(1)}`,
  },
] as const;
export const INTERNAL_TRANSPORT = "openshell:resolve:env:KEY";
export const ENCODED_INTERNAL_TRANSPORT = Buffer.from(INTERNAL_TRANSPORT, "utf8").toString(
  "base64",
);
export const INTERNAL_TRANSPORT_REPRESENTATIONS = [
  {
    name: "escaped",
    value: [...INTERNAL_TRANSPORT]
      .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  },
  { name: "base64", value: ENCODED_INTERNAL_TRANSPORT },
  {
    name: "base64url",
    value: Buffer.from("openshell:resolve:env:ÿ", "utf8")
      .toString("base64")
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_"),
  },
  {
    name: "wrapped-base64",
    value: `${ENCODED_INTERNAL_TRANSPORT.slice(0, 16)}\n# ${ENCODED_INTERNAL_TRANSPORT.slice(16)}`,
  },
] as const;
export const POLICY = {
  version: 1,
  network_policies: {
    inference: {
      name: "inference",
      endpoints: [{ host: "inference.example", port: 443 }],
      binaries: [{ path: "/usr/bin/openclaw" }],
    },
  },
};
export const createdDirectories: string[] = [];
export const artifactDirectories: string[] = [];

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function target(
  expectation: TargetDefinition["configExport"]["expectation"],
): TargetDefinition {
  return {
    ...listTargets().find((entry) => entry.id === "ubuntu-repo-cloud-openclaw")!,
    configExport:
      expectation === "expected-refusal"
        ? { expectation, failureCategory: "unsupported" }
        : { expectation },
  };
}

function manifest(
  features?: Record<string, unknown>,
  credentialRefs = ["NVIDIA_INFERENCE_API_KEY"],
): NemoClawInstanceManifest {
  return {
    apiVersion: "nemoclaw.io/v1",
    kind: "NemoClawInstance",
    metadata: { name: "openclaw" },
    spec: {
      setup: { install: {}, runtime: {}, platform: {} },
      onboarding: {
        agent: "openclaw",
        provider: "nvidia",
        modelRoute: "inference-local",
        policyTier: "personal",
        messaging: [],
        ...(features ? { features } : {}),
      },
      state: { credentialRefs },
    },
  };
}

export function document(
  overrides: {
    model?: string;
    observability?: boolean;
    credentialReference?: string;
  } = {},
): ConfigExportDocument {
  return {
    apiVersion: "nemoclaw.nvidia.com/v1alpha1",
    kind: "NemoClawConfig",
    metadata: {
      name: "export",
      uid: "123e4567-e89b-42d3-a456-426614174000",
    },
    spec: {
      gateway: { management: "managed", endpoint: "http://127.0.0.1:8080" },
      inferenceProviders: [
        {
          name: "hosted-compatible-endpoint",
          provider: "openai",
          api: "openai-completions",
          endpoint: "https://inference.example/v1",
          credential: { env: overrides.credentialReference ?? "NVIDIA_INFERENCE_API_KEY" },
        },
      ],
      sandboxes: [
        {
          name: "sandbox",
          runtime: { provider: "docker" },
          network: { policy: { explicit: POLICY } },
          harness: {
            kind: "openclaw",
            ...(overrides.observability
              ? {
                  observability: {
                    otlp: {
                      enabled: true,
                      endpoint: "http://host.openshell.internal:4318",
                      serviceName: "openclaw",
                      sampleRate: 1,
                    },
                  },
                }
              : {}),
          },
          agent: {
            name: "primary",
            inference: {
              routes: [
                {
                  name: "primary",
                  providerRef: "hosted-compatible-endpoint",
                  overrides: { model: overrides.model ?? "nvidia/model" },
                },
              ],
            },
          },
        },
      ],
    },
  } as unknown as ConfigExportDocument;
}

export function instance(expectedFailure = false): NemoClawInstance {
  return {
    onboarding: "cloud-openclaw",
    sandboxName: "sandbox",
    agent: "openclaw",
    provider: "nvidia",
    providerEnv: "cloud",
    gatewayUrl: "http://127.0.0.1:18789",
    result: {} as NemoClawInstance["result"],
    ...(expectedFailure
      ? {
          expectedFailure: {
            phase: "onboarding" as const,
            errorClass: "policy-presets-required" as const,
          },
        }
      : {}),
  };
}

export function searchDocument(
  provider: "brave" | "tavily",
  agent: "openclaw" | "hermes" = "openclaw",
): ConfigExportDocument {
  const value = document();
  const sandbox = value.spec.sandboxes[0]!;
  const name = `${provider}-search` as const;
  return {
    ...value,
    spec: {
      ...value.spec,
      sandboxes: [
        {
          ...sandbox,
          harness: { kind: agent },
          integrations: {
            [name]: {
              kind: "webSearch",
              provider,
              credential: { env: provider === "brave" ? "BRAVE_API_KEY" : "TAVILY_API_KEY" },
            },
          },
          agent: { ...sandbox.agent, integrationRefs: [name] },
        },
      ],
    },
  };
}

export function dependencies(
  options: {
    credentialRefs?: string[];
    features?: Record<string, unknown>;
    parsedDocument?: ConfigExportDocument;
    searchProvider?: "brave" | "tavily";
    removeDirectory?: (directory: string) => void;
  } = {},
): ConfigExportValidationDependencies {
  return {
    closeFile: fs.closeSync,
    inspectFile: (filePath) => {
      const stat = fs.lstatSync(filePath);
      return {
        device: stat.dev,
        inode: stat.ino,
        isFile: stat.isFile(),
        linkCount: stat.nlink,
        size: stat.size,
      };
    },
    inspectOpenFile: (file) => {
      const stat = fs.fstatSync(file);
      return {
        device: stat.dev,
        inode: stat.ino,
        isFile: stat.isFile(),
        linkCount: stat.nlink,
        size: stat.size,
      };
    },
    loadManifest: (filePath) => ({
      filePath,
      document: manifest(options.features, options.credentialRefs),
    }),
    loadRegistry: () => ({
      defaultSandbox: "sandbox",
      sandboxes: {
        sandbox: {
          name: "sandbox",
          agent: "openclaw",
          openshellDriver: "docker",
          gatewayName: "nemoclaw",
          provider: "compatible-endpoint",
          preferredInferenceApi: "openai-completions",
          endpointUrl: "https://inference.example/v1",
          model: "nvidia/model",
          credentialEnv: "NVIDIA_INFERENCE_API_KEY",
          webSearchEnabled: options.searchProvider !== undefined,
          webSearchProvider: options.searchProvider ?? null,
          workload: {
            schemaVersion: 1,
            kind: "managed-image",
            reference: IMAGE_REF,
            platform: "linux/amd64",
            release: "test",
            sourceRevision: SOURCE_REVISION,
            sourceCohort: "test",
            capabilityContractVersion: 1,
            startupProfileContractVersion: 1,
            encodedProfile: "profile",
            startupProfileSha256: `sha256:${"c".repeat(64)}`,
            credentialProxyReplayRequired: true,
            shared: true,
          },
        },
      },
    }),
    makeTempDirectory: (prefix) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      createdDirectories.push(directory);
      return directory;
    },
    now: vi.fn().mockReturnValueOnce(100).mockReturnValue(125),
    openFileNoFollow: (filePath) =>
      fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
    parseConfig: () => options.parsedDocument ?? document(),
    producer: () => ({
      sourceRevision: SOURCE_REVISION,
      cliVersion: "0.1.0",
      cliArtifactSha256: "d".repeat(64),
    }),
    readOpenFile: (file, limitBytes) => {
      const buffer = Buffer.alloc(limitBytes + 1);
      const bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
      return buffer.subarray(0, bytesRead).toString("utf8");
    },
    removeDirectory:
      options.removeDirectory ??
      ((directory) => fs.rmSync(directory, { force: true, recursive: true })),
  };
}

export function successfulHost(raw: string) {
  return {
    command: vi.fn(
      async (): Promise<
        Pick<ShellProbeResult, "exitCode" | "signal" | "timedOut" | "stdout" | "stderr">
      > => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: `Version: 1\n---\n${JSON.stringify(POLICY)}`,
        stderr: "",
      }),
    ),
    nemoclaw: vi.fn(async (args: string[]) => {
      const outputPath = args.at(args.indexOf("--output") + 1)!;
      fs.writeFileSync(outputPath, raw, "utf8");
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    }),
    openshellCommandPath: "openshell",
  };
}

export function refusalHost(
  message = "Config export failed (unsupported).\nThe source cannot be exported.",
) {
  return {
    command: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: `Version: 1\n---\n${JSON.stringify(POLICY)}`,
      stderr: "",
    })),
    nemoclaw: vi.fn(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: message,
    })),
    openshellCommandPath: "openshell",
  };
}

export function fixture(
  options: {
    artifacts?: ArtifactSink;
    dependencies?: ConfigExportValidationDependencies;
    host?: ReturnType<typeof successfulHost> | HostCliClient;
    secret?: string;
  } = {},
) {
  const writes: ConfigExportEvidenceEnvelope[] = [];
  const artifacts =
    options.artifacts ??
    ({
      writeJson: vi.fn(async (_name: string, value: ConfigExportEvidenceEnvelope) => {
        writes.push(value);
        return "evidence.json";
      }),
    } as unknown as ArtifactSink);
  const cleanup = new CleanupRegistry();
  const host = options.host ?? successfulHost(JSON.stringify(document()));
  const secrets = new SecretStore(
    options.secret ? { FIXTURE_API_KEY: options.secret } : {},
    (message) => {
      throw new Error(message);
    },
  );
  return {
    cleanup,
    host,
    phase: new ConfigExportValidationPhaseFixture(
      host as never,
      secrets,
      cleanup,
      artifacts,
      options.dependencies ?? dependencies(),
    ),
    writes,
  };
}

export async function captureFailure(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected the config export validation operation to fail");
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
  for (const directory of artifactDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});
