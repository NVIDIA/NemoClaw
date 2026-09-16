// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import {
  CONFIG_EXPORT_EVIDENCE_CONTRACT,
  type ConfigExportDocument,
  type ConfigExportEvidenceEnvelope,
  type ConfigExportValidationDependencies,
  ConfigExportValidationPhaseFixture,
  parseConfigExport,
} from "../fixtures/phases/config-export-validation.ts";
import type { NemoClawInstance } from "../fixtures/phases/onboarding.ts";
import { SecretStore } from "../fixtures/secrets.ts";
import { listTargets } from "../registry/registry.ts";
import type { NemoClawInstanceManifest, TargetDefinition } from "../registry/types.ts";

const IMAGE_REF = `nvcr.io/nvidia/nemoclaw@sha256:${"a".repeat(64)}`;
const SOURCE_REVISION = "b".repeat(40);
const SECRET = "fixture-secret-value";
const POLICY = { network_policies: { inference: { endpoints: ["inference.local"] } } };
const createdDirectories: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function target(expectation: TargetDefinition["configExport"]["expectation"]): TargetDefinition {
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

function document(overrides: { observability?: boolean } = {}): ConfigExportDocument {
  return {
    apiVersion: "nemoclaw.nvidia.com/v1",
    kind: "NemoClawConfig",
    metadata: {
      name: "export",
      uid: "123e4567-e89b-42d3-a456-426614174000",
    },
    spec: {
      gateway: { management: "nemoclaw", name: "nemoclaw", port: 8080 },
      inferenceProviders: [
        {
          name: "hosted-compatible-endpoint",
          provider: "compatible-endpoint",
          api: "openai-completions",
          endpoint: "https://inference.example/v1",
          credential: { env: "NVIDIA_INFERENCE_API_KEY" },
        },
      ],
      sandboxes: [
        {
          name: "sandbox",
          runtime: { provider: "docker", image: { ref: IMAGE_REF } },
          network: { policy: { explicit: POLICY } },
          agents: [
            {
              name: "primary",
              type: "openclaw",
              inference: {
                routes: [
                  {
                    name: "primary",
                    providerRef: "hosted-compatible-endpoint",
                    overrides: { model: "nvidia/model" },
                  },
                ],
              },
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
          ],
        },
      ],
    },
  } as ConfigExportDocument;
}

function instance(expectedFailure = false): NemoClawInstance {
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

function dependencies(
  options: {
    credentialRefs?: string[];
    features?: Record<string, unknown>;
    parsedDocument?: ConfigExportDocument;
    removeDirectory?: (directory: string) => void;
  } = {},
): ConfigExportValidationDependencies {
  return {
    exists: fs.existsSync,
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
    parseConfig: () => options.parsedDocument ?? document(),
    producer: () => ({
      sourceRevision: SOURCE_REVISION,
      cliVersion: "0.1.0",
      cliArtifactSha256: "d".repeat(64),
    }),
    readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
    readPolicy: async () => ({ ok: true, value: { document: JSON.stringify(POLICY) } }),
    removeDirectory:
      options.removeDirectory ??
      ((directory) => fs.rmSync(directory, { force: true, recursive: true })),
  };
}

function successfulHost(raw: string) {
  return {
    nemoclaw: vi.fn(async (args: string[]) => {
      const outputPath = args.at(args.indexOf("--output") + 1)!;
      fs.writeFileSync(outputPath, raw, "utf8");
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    }),
  };
}

function refusalHost(
  message = "Config export failed (unsupported).\nV1 export requires OpenClaw or Hermes.",
) {
  return {
    nemoclaw: vi.fn(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: message,
    })),
  };
}

function fixture(
  options: {
    artifacts?: ArtifactSink;
    dependencies?: ConfigExportValidationDependencies;
    host?: ReturnType<typeof successfulHost>;
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
      { openshell: vi.fn() } as never,
      secrets,
      cleanup,
      artifacts,
      options.dependencies ?? dependencies(),
    ),
    writes,
  };
}

async function captureFailure(operation: Promise<unknown>): Promise<Error> {
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
});

describe("automatic config export validation phase", () => {
  it("publishes only the validated byte count and digest after cleanup passes (#11485)", async () => {
    const raw = `${JSON.stringify(document())}\n`;
    const independentDependencies = dependencies();
    independentDependencies.parseConfig = parseConfigExport;
    const test = fixture({
      dependencies: independentDependencies,
      host: successfulHost(raw),
    });

    const evidence = await test.phase.from(target("required"), instance());

    expect(evidence).toMatchObject({
      contract: CONFIG_EXPORT_EVIDENCE_CONTRACT,
      classification: "success",
      passed: true,
      command: { exitCode: 0, signal: null, timedOut: false, outputPublished: true },
      cleanup: { registeredBeforeExport: true, succeeded: true },
      export: { byteLength: Buffer.byteLength(raw, "utf8"), sha256: sha256(raw) },
      security: { knownSecretsAbsent: true, internalTransportsAbsent: true },
    });
    expect(evidence.export).not.toHaveProperty("bytes");
    expect(evidence.verifications.every((entry) => entry.passed)).toBe(true);
    expect(evidence.producer).toEqual({
      sourceRevision: SOURCE_REVISION,
      cliVersion: "0.1.0",
      cliArtifactSha256: "d".repeat(64),
    });
    expect(evidence.elapsedMs).toBe(25);
    expect(createdDirectories.every((directory) => !fs.existsSync(directory))).toBe(true);
    expect((await test.cleanup.runAll()).failures).toEqual([]);
  });

  it("fails when export omits an enabled scenario feature (#11485)", async () => {
    const test = fixture({ dependencies: dependencies({ features: { observability: true } }) });

    await captureFailure(test.phase.from(target("required"), instance()));
    expect(test.writes.at(-1)).toMatchObject({ classification: "failure", passed: false });
    expect(test.writes.at(-1)?.verifications).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "enabledFeatures", passed: false })]),
    );
    expect(test.writes.at(-1)).not.toHaveProperty("export");
  });

  it("fails when live credentials are not declared by the target manifest (#11485)", async () => {
    const test = fixture({ dependencies: dependencies({ credentialRefs: [] }) });

    await captureFailure(test.phase.from(target("required"), instance()));
    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "observation",
    });
    expect(test.writes.at(-1)).not.toHaveProperty("export");
  });

  it("withholds export metadata when a known fixture secret leaks (#11485)", async () => {
    const test = fixture({
      host: successfulHost(`${JSON.stringify(document())}\n# ${SECRET}\n`),
      secret: SECRET,
    });

    await captureFailure(test.phase.from(target("required"), instance()));
    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      security: { knownSecretsAbsent: false },
    });
    expect(test.writes.at(-1)).not.toHaveProperty("export");
    expect(JSON.stringify(test.writes.at(-1))).not.toContain(SECRET);
  });

  it("withholds export metadata when an internal credential transport leaks (#11485)", async () => {
    const test = fixture({
      host: successfulHost(`${JSON.stringify(document())}\n# openshell:resolve:env:KEY\n`),
    });

    await captureFailure(test.phase.from(target("required"), instance()));
    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "security",
      security: { internalTransportsAbsent: false },
    });
    expect(test.writes.at(-1)).not.toHaveProperty("export");
  });

  it("classifies invalid exported configuration as verification failure (#11485)", async () => {
    const invalid = dependencies();
    invalid.parseConfig = () => {
      throw new Error("invalid exported configuration");
    };
    const test = fixture({ dependencies: invalid });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "verification",
      command: { exitCode: 0, timedOut: false, outputPublished: true },
    });
    expect(test.writes.at(-1)).not.toHaveProperty("export");
  });

  it("distinguishes a command timeout from an exporter refusal (#11485)", async () => {
    const host = {
      nemoclaw: vi.fn(async () => ({
        exitCode: null,
        signal: "SIGTERM" as const,
        timedOut: true,
        stdout: "",
        stderr: "",
      })),
    };
    const test = fixture({ host: host as unknown as ReturnType<typeof successfulHost> });

    await captureFailure(test.phase.from(target("expected-refusal"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "transport",
      command: {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        outputPublished: false,
      },
      expectedRefusalCategory: "unsupported",
      observedRefusalCategory: "unclassified",
    });
  });

  it("accepts an expected refusal only when no file is published (#11485)", async () => {
    const host = refusalHost();
    const test = fixture({ host: host as ReturnType<typeof successfulHost> });

    const evidence = await test.phase.from(target("expected-refusal"), instance());

    expect(evidence).toMatchObject({
      classification: "expected-refusal",
      passed: true,
      expectedRefusalCategory: "unsupported",
      observedRefusalCategory: "unsupported",
      command: { exitCode: 1, timedOut: false, outputPublished: false },
      cleanup: { succeeded: true },
    });
    expect(evidence).not.toHaveProperty("export");
  });

  it("rejects an expected refusal that publishes a file (#11485)", async () => {
    const host = {
      nemoclaw: vi.fn(async (args: string[]) => {
        const outputPath = args.at(args.indexOf("--output") + 1)!;
        fs.writeFileSync(outputPath, "unexpected", "utf8");
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "Config export failed (unsupported).",
        };
      }),
    };
    const test = fixture({ host });

    await captureFailure(test.phase.from(target("expected-refusal"), instance()));
    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "export",
    });
  });

  it("rejects an unrelated command failure as expected-refusal coverage (#11485)", async () => {
    const host = refusalHost("gateway transport timed out");
    const test = fixture({ host: host as ReturnType<typeof successfulHost> });

    await captureFailure(test.phase.from(target("expected-refusal"), instance()));
    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "export",
      expectedRefusalCategory: "unsupported",
      observedRefusalCategory: "unclassified",
    });
  });

  it("records no usable sandbox without invoking export (#11485)", async () => {
    const host = refusalHost();
    const test = fixture({ host: host as ReturnType<typeof successfulHost> });

    const evidence = await test.phase.from(target("no-usable-sandbox"), instance(true));

    expect(evidence).toMatchObject({ classification: "no-usable-sandbox", passed: true });
    expect(host.nemoclaw).not.toHaveBeenCalled();
  });

  it("classifies cleanup failure and withholds passing export metadata (#11485)", async () => {
    const test = fixture({
      dependencies: dependencies({
        removeDirectory: () => {
          throw new Error("owned cleanup failed");
        },
      }),
    });

    await captureFailure(test.phase.from(target("required"), instance()));
    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      passed: false,
      failureStage: "cleanup",
      cleanup: { succeeded: false, diagnostic: "owned cleanup failed" },
    });
    expect(test.writes.at(-1)).not.toHaveProperty("export");
  });

  it("preserves the primary failure when cleanup also fails (#11485)", async () => {
    const invalid = dependencies({
      removeDirectory: () => {
        throw new Error("owned cleanup failed");
      },
    });
    invalid.parseConfig = () => {
      throw new Error("invalid exported configuration");
    };
    const test = fixture({ dependencies: invalid });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "verification",
      diagnostic: "invalid exported configuration",
      cleanup: { succeeded: false, diagnostic: "owned cleanup failed" },
    });
  });

  it("redacts bounded refusal diagnostics before evidence publication (#11485)", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "config-export-evidence-"));
    createdDirectories.push(artifactRoot);
    const artifacts = new ArtifactSink(artifactRoot, [SECRET]);
    const host = refusalHost(`Config export failed (unsupported). ${SECRET}`);
    const test = fixture({
      artifacts,
      host: host as ReturnType<typeof successfulHost>,
      secret: SECRET,
    });

    await test.phase.from(target("expected-refusal"), instance());

    const stored = fs.readFileSync(
      path.join(artifactRoot, "config-export-evidence.v1.json"),
      "utf8",
    );
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain("[REDACTED]");
  });
});
