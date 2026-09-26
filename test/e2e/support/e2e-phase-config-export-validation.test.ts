// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../../../src/lib/onboard/managed-startup/profile.ts";
import {
  EXPECTED_NATIVE_SETTINGS,
  PINNED_CONSUMER_EVIDENCE,
} from "./config-export-consumer-evidence-fixture.ts";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { HostCliClient } from "../fixtures/clients/host.ts";
import {
  CONFIG_EXPORT_EVIDENCE_CONTRACT,
  type ConfigExportDocument,
  type ConfigExportEvidenceEnvelope,
  type ConfigExportValidationDependencies,
  ConfigExportValidationPhaseFixture,
  parseConfigExport,
} from "../fixtures/phases/config-export-validation.ts";
import type { NemoClawInstance } from "../fixtures/phases/onboarding.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import { SecretStore } from "../fixtures/secrets.ts";
import { ShellProbe, type ShellProbeResult } from "../fixtures/shell-probe.ts";
import { listTargets } from "../registry/registry.ts";
import type { NemoClawInstanceManifest, TargetDefinition } from "../registry/types.ts";

const IMAGE_REF = `nvcr.io/nvidia/nemoclaw@sha256:${"a".repeat(64)}`;
const SOURCE_REVISION = "b".repeat(40);
const ENCODED_PROFILE = encodeManagedStartupProfile(managedStartupE2eProfile("openclaw"));
const SECRET = "fixture-secret-value";
const ENCODED_SECRET = Buffer.from(SECRET, "utf8").toString("base64");
const DIAGNOSTIC_SECRET_REPRESENTATIONS = [
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
const INTERNAL_TRANSPORT = "openshell:resolve:env:KEY";
const ENCODED_INTERNAL_TRANSPORT = Buffer.from(INTERNAL_TRANSPORT, "utf8").toString("base64");
const INTERNAL_TRANSPORT_REPRESENTATIONS = [
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
const POLICY = {
  version: 1,
  network_policies: {
    inference: {
      name: "inference",
      endpoints: [{ host: "inference.example", port: 443 }],
      binaries: [{ path: "/usr/bin/openclaw" }],
    },
  },
};
const createdDirectories: string[] = [];
const artifactDirectories: string[] = [];

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

function document(
  overrides: {
    model?: string;
    observability?: boolean;
    credentialReference?: string;
    gatewayEndpoint?: string;
  } = {},
): ConfigExportDocument {
  const gatewayEndpoint = overrides.gatewayEndpoint ?? "http://127.0.0.1:8080";
  return {
    apiVersion: "nemoclaw.nvidia.com/v1alpha1",
    kind: "NemoClawConfig",
    metadata: {
      name: "export",
      uid: "123e4567-e89b-42d3-a456-426614174000",
    },
    spec: {
      gateway: { management: "managed", endpoint: gatewayEndpoint },
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
            encodedProfile: ENCODED_PROFILE,
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
    validateWithPinnedV1: () => PINNED_CONSUMER_EVIDENCE,
  };
}

function successfulHost(raw: string) {
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

function refusalHost(
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

function fixture(
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
      writeText: vi.fn(async () => "config-export.yaml"),
      redact: (text: string) => text,
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
  for (const directory of artifactDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});
describe("automatic config export validation phase", () => {
  it.each([
    {
      hosted: "1",
      provider: "compatible-endpoint",
      credential: "COMPATIBLE_API_KEY",
      passed: true,
    },
    {
      hosted: "0",
      provider: "compatible-endpoint",
      credential: "COMPATIBLE_API_KEY",
      passed: false,
    },
    { hosted: "1", provider: "nvidia-prod", credential: "COMPATIBLE_API_KEY", passed: false },
    {
      hosted: "1",
      provider: "compatible-endpoint",
      credential: "UNDECLARED_API_KEY",
      passed: false,
    },
  ])(
    "binds the hosted adapter credential: hosted=$hosted provider=$provider credential=$credential (#11485)",
    async ({ hosted, provider, credential, passed }) => {
      const exported = document({ credentialReference: credential });
      const deps = dependencies({ parsedDocument: exported });
      const registry = deps.loadRegistry();
      registry.sandboxes.sandbox!.provider = provider;
      registry.sandboxes.sandbox!.credentialEnv = credential;
      deps.loadRegistry = () => registry;
      const test = fixture({
        dependencies: deps,
        host: successfulHost(JSON.stringify(exported)),
      });
      vi.stubEnv("NEMOCLAW_E2E_USE_HOSTED_INFERENCE", hosted);
      try {
        await test.phase.from(target("required"), instance()).catch(() => undefined);
        expect(test.writes.at(-1)).toMatchObject({
          passed,
          ...(passed
            ? { classification: "success" }
            : {
                failureStage: "observation",
                diagnostic: "the live credential reference is not declared by the target manifest",
              }),
        });
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
  it.each(["required", "expected-refusal"] as const)(
    "preserves the isolated runtime environment for %s subprocesses (#11485)",
    async (expectation) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "config-export-runtime-env-"));
      createdDirectories.push(directory);
      const cliPath = path.join(directory, "fixture-cli.cjs");
      fs.writeFileSync(
        cliPath,
        `#!${process.execPath}
const fs = require("node:fs");
if (process.env.HOME !== ${JSON.stringify(process.env.HOME)} ||
    process.env.XDG_CONFIG_HOME !== ${JSON.stringify(directory)} ||
    process.env.NEMOCLAW_GATEWAY_RUNTIME !== "docker" ||
    process.env.UNDECLARED_API_KEY !== undefined) {
  process.stderr.write("The child cannot find the selected sandbox runtime.");
  process.exit(1);
}
if (process.argv.includes("--output")) {
  if (${JSON.stringify(expectation)} === "expected-refusal") {
    process.stderr.write("Config export failed (unsupported). Unsupported agent.");
    process.exit(1);
  }
  fs.writeFileSync(process.argv[process.argv.indexOf("--output") + 1], ${JSON.stringify(JSON.stringify(document()))});
} else {
  process.stdout.write(${JSON.stringify(`Version: 1\n---\n${JSON.stringify(POLICY)}`)});
}
`,
        { mode: 0o700 },
      );
      const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
      const progress = startTestProgress(
        "runtime environment",
        ["validate export", "verify evidence"],
        { logLine: () => undefined },
      );
      const host = new HostCliClient(
        new ShellProbe({
          artifacts,
          progress,
          redact: (text) => text,
          signal: new AbortController().signal,
        }),
        { cliPath, openshellPath: cliPath },
      );
      vi.stubEnv("XDG_CONFIG_HOME", directory);
      vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "docker");
      vi.stubEnv("UNDECLARED_API_KEY", "ambient-secret-must-not-reach-child");
      try {
        progress.phase("validate export");
        const test = fixture({ artifacts, host });
        const evidence = await test.phase.from(target(expectation), instance());
        progress.phase("verify evidence");
        expect(evidence).toMatchObject({
          passed: true,
          classification: expectation === "required" ? "success" : "expected-refusal",
        });
      } finally {
        vi.unstubAllEnvs();
        progress.stop();
      }
    },
  );
  it("publishes exact bytes only when pinned native settings match (#11485)", async () => {
    const raw = `${JSON.stringify(
      document({ gatewayEndpoint: "http://127.0.0.1:8080/export-evidence" }),
    )}\n`;
    const publishedExport = {
      bytes: raw,
      byteLength: Buffer.byteLength(raw, "utf8"),
      sha256: sha256(raw),
    };
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-export-evidence-"));
    artifactDirectories.push(artifactRoot);
    const independentDependencies = dependencies();
    independentDependencies.parseConfig = parseConfigExport;
    const test = fixture({
      artifacts: new ArtifactSink(artifactRoot),
      dependencies: independentDependencies,
      host: successfulHost(raw),
    });
    const evidence = await test.phase.from(target("required"), instance());
    const persistedEvidence = JSON.parse(
      fs.readFileSync(path.join(artifactRoot, "config-export-evidence.v1.json"), "utf8"),
    ) as ConfigExportEvidenceEnvelope;
    expect(evidence).toMatchObject({
      contract: CONFIG_EXPORT_EVIDENCE_CONTRACT,
      classification: "success",
      passed: true,
      command: { exitCode: 0, signal: null, timedOut: false, outputPublished: true },
      cleanup: { registeredBeforeExport: true, succeeded: true },
      export: publishedExport,
      security: { knownSecretsAbsent: true, internalTransportsAbsent: true },
      consumer: {
        passed: true,
        expected: PINNED_CONSUMER_EVIDENCE,
        actual: PINNED_CONSUMER_EVIDENCE,
      },
    });
    expect(fs.readFileSync(path.join(artifactRoot, "config-export.yaml"), "utf8")).toBe(raw);
    expect(persistedEvidence.export).toEqual(publishedExport);
    expect(persistedEvidence.verifications.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "sandboxName",
        "agent",
        "runtimeProvider",
        "imageRef",
        "inferenceProvider",
        "inferenceApi",
        "inferenceEndpoint",
        "model",
        "credentialReference",
        "routeName",
        "policySha256",
        "enabledFeatures",
        "routeProviderReference",
        "sourceRegistryUnchanged",
      ]),
    );
    expect(persistedEvidence.verifications.filter((entry) => !entry.passed)).toEqual([]);
    expect(evidence.producer).toEqual({
      sourceRevision: SOURCE_REVISION,
      cliVersion: "0.1.0",
      cliArtifactSha256: "d".repeat(64),
    });
    expect(evidence.elapsedMs).toBe(25);
    expect(createdDirectories.every((directory) => !fs.existsSync(directory))).toBe(true);
    expect((await test.cleanup.runAll()).failures).toEqual([]);
    const mismatched = dependencies();
    mismatched.validateWithPinnedV1 = () => ({
      ...PINNED_CONSUMER_EVIDENCE,
      compiledSandboxes: 2,
      openclawNativeSettings: {
        sandbox: {
          ...EXPECTED_NATIVE_SETTINGS,
          model: { ...EXPECTED_NATIVE_SETTINGS.model, contextWindow: 32_768 },
        },
      },
      openclawNativeSettingsVerified: 0,
    });
    const rejected = fixture({ dependencies: mismatched });
    await captureFailure(rejected.phase.from(target("required"), instance()));
    expect(rejected.writes.at(-1)).toMatchObject({
      failureStage: "verification",
      consumer: { passed: false },
    });
    expect(rejected.writes.at(-1)?.verifications).toContainEqual(
      expect.objectContaining({ id: "consumerNativeSettings", passed: false }),
    );
    expect(rejected.writes.at(-1)).not.toHaveProperty("export");
  });
  it("observes effective policy through the fixture-owned OpenShell boundary (#11485)", async () => {
    const test = fixture();
    const evidence = await test.phase.from(target("required"), instance());
    expect(test.host.command).toHaveBeenCalledWith(
      "openshell",
      ["policy", "get", "-g", "nemoclaw", "--full", "sandbox"],
      expect.objectContaining({
        captureLimitBytes: 1024 * 1024,
        persistArtifacts: false,
        timeoutMs: 60_000,
      }),
    );
    expect(evidence.verifications).toContainEqual(
      expect.objectContaining({ id: "policySha256", passed: true }),
    );
    expect(evidence).toMatchObject({ classification: "success", passed: true });
  });
  it("fails before export when the effective policy cannot be observed (#11485)", async () => {
    const host = successfulHost(JSON.stringify(document()));
    host.command.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "policy unavailable",
    });
    const test = fixture({ host });
    await captureFailure(test.phase.from(target("required"), instance()));
    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "observation",
      passed: false,
    });
    expect(test.writes.at(-1)).not.toHaveProperty("export");
    expect(host.nemoclaw).not.toHaveBeenCalled();
  });
  it("rejects truncated policy output even when its tail contains a complete policy (#11485)", async () => {
    const policySuffix = `\n---\n${JSON.stringify(POLICY)}`;
    const retainedTail =
      "x".repeat(1024 * 1024 - Buffer.byteLength(policySuffix, "utf8")) + policySuffix;
    const host = successfulHost(JSON.stringify(document()));
    host.command.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: `[shell-probe omitted 2048 earlier bytes; showing up to the last 1048576 bytes]\n${retainedTail}`,
      stderr: "",
    });
    const test = fixture({ host });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "observation",
      passed: false,
      cleanup: { succeeded: true },
    });
    expect(test.writes.at(-1)).not.toHaveProperty("export");
    expect(host.nemoclaw).not.toHaveBeenCalled();
  });
  it("rejects a truncated policy after redaction shrinks the captured tail (#11485)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "config-export-policy-capture-"));
    createdDirectories.push(directory);
    const openshellPath = path.join(directory, "fake-openshell.cjs");
    const secret = `policy-redaction-canary-${"q".repeat(256)}`;
    const policySuffix = `\n${secret}\n---\n${JSON.stringify(POLICY)}`;
    fs.writeFileSync(
      openshellPath,
      `#!${process.execPath}
const suffix = ${JSON.stringify(policySuffix)};
process.stdout.write("x".repeat(1024 * 1024 + 2048 - Buffer.byteLength(suffix, "utf8")) + suffix);
`,
      { mode: 0o700 },
    );
    const progress = startTestProgress("policy capture", ["observe policy", "validate export"], {
      logLine: () => undefined,
    });
    try {
      const probe = new ShellProbe({
        artifacts: new ArtifactSink(directory, [secret]),
        progress,
        redact: (text) => text,
        signal: new AbortController().signal,
      });
      const capturedHost = new HostCliClient(probe, { openshellPath });
      progress.phase("observe policy");
      const captured = await capturedHost.command(openshellPath, [], {
        captureLimitBytes: 1024 * 1024,
        persistArtifacts: false,
        redactionValues: [secret],
      });
      expect(captured.exitCode).toBe(0);
      expect(captured.stdout).toMatch(/^\[shell-probe omitted \d+ earlier bytes;/u);
      expect(Buffer.byteLength(captured.stdout, "utf8")).toBeLessThan(1024 * 1024);
      expect(captured.stdout).not.toContain(secret);

      const host = successfulHost(JSON.stringify(document()));
      host.command.mockResolvedValueOnce(captured);
      const test = fixture({ host, secret });
      progress.phase("validate export");

      await captureFailure(test.phase.from(target("required"), instance()));

      expect(test.writes.at(-1)).toMatchObject({
        classification: "failure",
        failureStage: "observation",
        passed: false,
        cleanup: { succeeded: true },
      });
      expect(test.writes.at(-1)).not.toHaveProperty("export");
      expect(host.nemoclaw).not.toHaveBeenCalled();
    } finally {
      progress.stop();
    }
  });
  it("rejects unsafe registry endpoints without retaining credential material (#11485)", async () => {
    const credentialCanary = "credential-canary-value";
    const unsafeDependencies = dependencies();
    const loadRegistry = unsafeDependencies.loadRegistry;
    unsafeDependencies.loadRegistry = () => {
      const registry = loadRegistry();
      return {
        ...registry,
        sandboxes: {
          ...registry.sandboxes,
          sandbox: {
            ...registry.sandboxes.sandbox!,
            endpointUrl: `https://user:${credentialCanary}@inference.example/v1`,
          },
        },
      };
    };
    const test = fixture({ dependencies: unsafeDependencies });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "observation",
      diagnostic: "the live inference endpoint is unsafe",
    });
    expect(JSON.stringify(test.writes.at(-1))).not.toContain(credentialCanary);
    expect(test.host.command).not.toHaveBeenCalled();
    expect(test.host.nemoclaw).not.toHaveBeenCalled();
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
  it("compares exports with deployment state captured before the exporter runs (#11485)", async () => {
    const mutableDependencies = dependencies();
    const loadRegistry = mutableDependencies.loadRegistry;
    let registryModel = "nvidia/model";
    mutableDependencies.loadRegistry = () => {
      const registry = loadRegistry();
      return {
        ...registry,
        sandboxes: {
          ...registry.sandboxes,
          other: { ...registry.sandboxes.sandbox!, name: "other", model: registryModel },
        },
      };
    };
    const mutatedDocument = document({ model: "nvidia/mutated-model" });
    mutableDependencies.parseConfig = () => mutatedDocument;
    const host = {
      ...successfulHost(JSON.stringify(mutatedDocument)),
      nemoclaw: vi.fn(async (args: string[]) => {
        registryModel = "nvidia/mutated-model";
        const outputPath = args.at(args.indexOf("--output") + 1)!;
        fs.writeFileSync(outputPath, JSON.stringify(mutatedDocument), "utf8");
        return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
      }),
    };
    const test = fixture({ dependencies: mutableDependencies, host });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "verification",
      expected: { model: "nvidia/model" },
      observed: { model: "nvidia/mutated-model" },
    });
    expect(test.writes.at(-1)?.verifications).toContainEqual(
      expect.objectContaining({ id: "model", passed: false }),
    );
    expect(test.writes.at(-1)?.verifications).toContainEqual(
      expect.objectContaining({ id: "sourceRegistryUnchanged", passed: false }),
    );
  });
  it("validates the current v1alpha1 Deep Agents document (#11860)", () => {
    const candidate = structuredClone(document());
    const sandbox = candidate.spec.sandboxes[0]!;
    const image = { ref: IMAGE_REF };
    Object.assign(sandbox, { harness: { kind: "deepagents" }, image });
    expect(parseConfigExport(JSON.stringify(candidate)).spec.sandboxes[0]).toMatchObject({
      image: { ref: IMAGE_REF },
      harness: { kind: "deepagents" },
      agent: { name: "primary" },
    });
    const missingImage = structuredClone(candidate);
    Reflect.deleteProperty(missingImage.spec.sandboxes[0]!, "image");
    expect(() => parseConfigExport(JSON.stringify(missingImage))).toThrow(
      "complete v1alpha1 export contract",
    );
    const missingEndpoint = structuredClone(candidate);
    Reflect.deleteProperty(missingEndpoint.spec.gateway, "endpoint");
    expect(() => parseConfigExport(JSON.stringify(missingEndpoint))).toThrow(
      "complete v1alpha1 export contract",
    );
    Object.assign(sandbox, { agents: [sandbox.agent], agent: undefined });
    expect(() => parseConfigExport(JSON.stringify(candidate))).toThrow(
      "complete v1alpha1 export contract",
    );
  });
  it("rejects an export that violates the canonical config schema (#11485)", async () => {
    const valid = document();
    const raw = JSON.stringify({
      ...valid,
      metadata: { ...valid.metadata, name: "Not Valid" },
    });
    const canonicalDependencies = dependencies();
    canonicalDependencies.parseConfig = parseConfigExport;
    const test = fixture({
      dependencies: canonicalDependencies,
      host: successfulHost(raw),
    });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "verification",
    });
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
  it("withholds export metadata when YAML escapes a known fixture secret (#11485)", async () => {
    const escapedSecret = [...SECRET]
      .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
    const raw = `leak: "${escapedSecret}"\n`;
    expect(raw).not.toContain(SECRET);
    const test = fixture({ host: successfulHost(raw), secret: SECRET });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "security",
      security: { knownSecretsAbsent: false },
    });
    expect(test.writes.at(-1)).not.toHaveProperty("export");
    expect(JSON.stringify(test.writes.at(-1))).not.toContain(SECRET);
  });
  it("withholds export metadata when a comment contains a base64 fixture secret (#11485)", async () => {
    const encodedSecret = Buffer.from(SECRET, "utf8").toString("base64");
    const raw = `${JSON.stringify(document())}\n# ${encodedSecret}\n`;
    expect(raw).not.toContain(SECRET);
    const test = fixture({ host: successfulHost(raw), secret: SECRET });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "security",
      security: { knownSecretsAbsent: false },
    });
    expect(test.writes.at(-1)).not.toHaveProperty("export");
    expect(JSON.stringify(test.writes.at(-1))).not.toContain(SECRET);
    expect(JSON.stringify(test.writes.at(-1))).not.toContain(encodedSecret);
  });
  it("withholds export metadata when a comment contains a percent-encoded fixture secret (#11485)", async () => {
    const encodedSecret = [...Buffer.from(SECRET, "utf8")]
      .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
      .join("");
    const raw = `${JSON.stringify(document())}\n# ${encodedSecret}\n`;
    expect(raw).not.toContain(SECRET);
    const test = fixture({ host: successfulHost(raw), secret: SECRET });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "security",
      security: { knownSecretsAbsent: false },
    });
    expect(test.writes.at(-1)).not.toHaveProperty("export");
    expect(JSON.stringify(test.writes.at(-1))).not.toContain(SECRET);
    expect(JSON.stringify(test.writes.at(-1))).not.toContain(encodedSecret);
  });
  it("withholds export metadata when a comment contains a doubly encoded fixture secret (#11485)", async () => {
    const encodedSecret = [...Buffer.from(SECRET, "utf8")]
      .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
      .join("");
    const doublyEncodedSecret = encodedSecret.replace(/%/gu, "%25");
    const raw = `${JSON.stringify(document())}\n# ${doublyEncodedSecret}\n`;
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(encodedSecret);
    const test = fixture({ host: successfulHost(raw), secret: SECRET });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "security",
      security: { knownSecretsAbsent: false },
    });
    expect(test.writes.at(-1)).not.toHaveProperty("export");
    const serializedEvidence = JSON.stringify(test.writes.at(-1));
    expect(serializedEvidence).not.toContain(SECRET);
    expect(serializedEvidence).not.toContain(encodedSecret);
    expect(serializedEvidence).not.toContain(doublyEncodedSecret);
  });
  it.each(["wrapped", "escaped"] as const)(
    "withholds export metadata when a comment contains %s base64 fixture-secret text (#11485)",
    async (representation) => {
      const encodedSecret = Buffer.from(SECRET, "utf8").toString("base64");
      const representedSecret =
        representation === "wrapped"
          ? `${encodedSecret.slice(0, 12)}\n# ${encodedSecret.slice(12)}`
          : `\\u${encodedSecret.charCodeAt(0).toString(16).padStart(4, "0")}${encodedSecret.slice(1)}`;
      const raw = `${JSON.stringify(document())}\n# ${representedSecret}\n`;
      expect(raw).not.toContain(SECRET);
      expect(raw).not.toContain(encodedSecret);
      const test = fixture({ host: successfulHost(raw), secret: SECRET });

      await captureFailure(test.phase.from(target("required"), instance()));

      expect(test.writes.at(-1)).toMatchObject({
        classification: "failure",
        failureStage: "security",
        security: { knownSecretsAbsent: false },
      });
      expect(test.writes.at(-1)).not.toHaveProperty("export");
      expect(JSON.stringify(test.writes.at(-1))).not.toContain(SECRET);
    },
  );
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
  it("withholds export metadata when YAML escapes an internal credential transport (#11485)", async () => {
    const escapedTransport = [..."openshell:resolve:env:KEY"]
      .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
    const raw = `transport: "${escapedTransport}"\n`;
    expect(raw).not.toMatch(/openshell:resolve:env:/u);
    const test = fixture({ host: successfulHost(raw) });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "security",
      security: { internalTransportsAbsent: false },
    });
    expect(test.writes.at(-1)).not.toHaveProperty("export");
  });
  it.each(INTERNAL_TRANSPORT_REPRESENTATIONS)(
    "withholds export metadata when a comment contains an $name internal credential transport (#11485)",
    async ({ value }) => {
      const raw = `${JSON.stringify(document())}\n# ${value}\n`;
      expect(raw).not.toContain(INTERNAL_TRANSPORT);
      const test = fixture({ host: successfulHost(raw) });

      await captureFailure(test.phase.from(target("required"), instance()));

      expect(test.writes.at(-1)).toMatchObject({
        classification: "failure",
        failureStage: "security",
        security: { internalTransportsAbsent: false },
      });
      expect(test.writes.at(-1)).not.toHaveProperty("export");
    },
  );
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
  it("classifies a command launch failure after observation as transport failure (#11485)", async () => {
    const host = {
      ...successfulHost(JSON.stringify(document())),
      nemoclaw: vi.fn().mockRejectedValue(new Error("config export launch failed")),
    };
    const test = fixture({ host });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "transport",
      expected: { model: "nvidia/model" },
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
        stderr: "Config export failed (unsupported).",
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
    });
    expect(test.writes.at(-1)).not.toHaveProperty("observedRefusalCategory");
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
  it.each([
    {
      outputKind: "file",
      publish: (outputPath: string) => fs.writeFileSync(outputPath, "unexpected", "utf8"),
    },
    {
      outputKind: "dangling symbolic link",
      publish: (outputPath: string) =>
        fs.symlinkSync(path.join(path.dirname(outputPath), "missing.yaml"), outputPath),
    },
  ])("rejects an expected refusal that publishes a $outputKind (#11485)", async ({ publish }) => {
    const host = {
      ...successfulHost("unexpected"),
      nemoclaw: vi.fn(async (args: string[]) => {
        const outputPath = args.at(args.indexOf("--output") + 1)!;
        publish(outputPath);
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
      passed: false,
      command: { exitCode: 1, outputPublished: true },
      cleanup: { succeeded: true },
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
  it.each([
    { stream: "stdout", tail: "stdout end" },
    { stream: "stderr", tail: "Config export failed (unsupported)." },
  ])(
    "bounds exporter $stream while retaining an actionable failure (#11485)",
    async ({ stream, tail }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-export-capture-"));
      createdDirectories.push(directory);
      const cliPath = path.join(directory, "fake-nemoclaw.cjs");
      const openshellPath = path.join(directory, "fake-openshell.cjs");
      fs.writeFileSync(
        openshellPath,
        `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`Version: 1\n---\n${JSON.stringify(POLICY)}`)});\n`,
        { mode: 0o700 },
      );
      fs.writeFileSync(
        cliPath,
        `#!${process.execPath}
process.stdout.write("stdout start\\n" + "x".repeat(128 * 1024) + "\\nstdout end");
process.stderr.write("stderr start\\n" + "x".repeat(128 * 1024) + "\\nConfig export failed (unsupported).");
process.exitCode = 1;
`,
        { mode: 0o700 },
      );
      const artifacts = new ArtifactSink(directory);
      const progress = startTestProgress(
        "config export capture",
        ["run export", "verify evidence"],
        {
          logLine: () => undefined,
        },
      );
      try {
        const probe = new ShellProbe({
          artifacts,
          progress,
          redact: (text) => text,
          signal: new AbortController().signal,
        });
        const host = new HostCliClient(probe, { cliPath, openshellPath });
        const execution = vi.spyOn(host, "nemoclaw");
        const test = fixture({ artifacts, host });
        progress.phase("run export");

        await captureFailure(test.phase.from(target("required"), instance()));

        progress.phase("verify evidence");
        expect(execution).toHaveBeenCalledOnce();
        const result = await execution.mock.results[0]!.value;
        const output = stream === "stdout" ? result.stdout : result.stderr;
        expect(
          fs.existsSync(artifacts.pathFor(`shell/config-export-automatic.${stream}.txt`)),
        ).toBe(false);
        const [notice, ...body] = output.split("\n");
        expect(notice).toMatch(/^\[shell-probe omitted \d+ earlier bytes;/u);
        expect(Buffer.byteLength(body.join("\n"), "utf8")).toBeLessThanOrEqual(64 * 1024);
        expect(output).not.toContain(`${stream} start`);
        expect(output.endsWith(tail)).toBe(true);
        const evidence = JSON.parse(
          fs.readFileSync(artifacts.pathFor("config-export-evidence.v1.json"), "utf8"),
        ) as ConfigExportEvidenceEnvelope;
        expect(evidence).toMatchObject({
          classification: "failure",
          failureStage: "export",
          command: { exitCode: 1, signal: null, timedOut: false, outputPublished: false },
          cleanup: { succeeded: true },
        });
        expect(evidence.diagnostic).toHaveLength(2_048);
        expect(evidence.diagnostic).toContain("[shell-probe omitted");
        expect(evidence).not.toHaveProperty("export");
      } finally {
        progress.stop();
      }
    },
  );
  it("rejects and removes an oversized export file without retaining its bytes (#11485)", async () => {
    const oversizedDirectory = { path: "" };
    const base = dependencies();
    const test = fixture({
      dependencies: {
        ...base,
        makeTempDirectory: (prefix) => {
          const directory = base.makeTempDirectory(prefix);
          oversizedDirectory.path = directory;
          return directory;
        },
      },
      host: successfulHost("x".repeat(1024 * 1024 + 1)),
    });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      passed: false,
      failureStage: "export",
      cleanup: { succeeded: true },
      diagnostic: "config export output exceeds the 1048576-byte limit",
    });
    expect(test.writes.at(-1)).not.toHaveProperty("export");
    expect(test.writes.at(-1)?.diagnostic?.length).toBeLessThanOrEqual(2_048);
    expect(fs.existsSync(oversizedDirectory.path)).toBe(false);
  });
  it("rejects a hard-linked output before reading or publishing its bytes (#11485)", async () => {
    const exportDirectory = { path: "" };
    const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-export-hard-link-"));
    createdDirectories.push(outsideDirectory);
    const outsidePath = path.join(outsideDirectory, "outside.yaml");
    const raw = JSON.stringify(document());
    fs.writeFileSync(outsidePath, raw, "utf8");
    const base = dependencies();
    const readOpenFile = vi.fn(base.readOpenFile);
    const host = successfulHost(raw);
    host.nemoclaw.mockImplementation(async (args: string[]) => {
      const outputPath = args.at(args.indexOf("--output") + 1)!;
      fs.linkSync(outsidePath, outputPath);
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    });
    const test = fixture({
      dependencies: {
        ...base,
        makeTempDirectory: (prefix) => {
          const directory = base.makeTempDirectory(prefix);
          exportDirectory.path = directory;
          return directory;
        },
        readOpenFile,
      },
      host,
    });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      passed: false,
      failureStage: "export",
      cleanup: { succeeded: true },
      diagnostic: "config export output must have exactly one hard link",
    });
    expect(readOpenFile).not.toHaveBeenCalled();
    expect(test.writes.at(-1)).not.toHaveProperty("export");
    expect(fs.existsSync(exportDirectory.path)).toBe(false);
    expect(fs.readFileSync(outsidePath, "utf8")).toBe(raw);
  });
  it("withholds export evidence when a hard link is added during the read (#11485)", async () => {
    const exportDirectory = { path: "" };
    const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-export-link-race-"));
    createdDirectories.push(outsideDirectory);
    const outsidePath = path.join(outsideDirectory, "alias.yaml");
    const raw = JSON.stringify(document());
    const base = dependencies();
    const test = fixture({
      dependencies: {
        ...base,
        makeTempDirectory: (prefix) => {
          const directory = base.makeTempDirectory(prefix);
          exportDirectory.path = directory;
          return directory;
        },
        readOpenFile: (file, limitBytes) => {
          const contents = base.readOpenFile(file, limitBytes);
          fs.linkSync(path.join(exportDirectory.path, "config.yaml"), outsidePath);
          return contents;
        },
      },
      host: successfulHost(raw),
    });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      passed: false,
      failureStage: "export",
      cleanup: { succeeded: true },
      diagnostic: "config export output changed while it was being read",
    });
    expect(test.writes.at(-1)).not.toHaveProperty("export");
    expect(fs.existsSync(exportDirectory.path)).toBe(false);
    expect(fs.readFileSync(outsidePath, "utf8")).toBe(raw);
  });
  it("rejects a path replaced after the no-follow file is inspected (#11485)", async () => {
    const exportDirectory = { path: "" };
    const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-export-race-"));
    createdDirectories.push(outsideDirectory);
    const outsidePath = path.join(outsideDirectory, "outside.yaml");
    fs.writeFileSync(outsidePath, SECRET, "utf8");
    const base = dependencies();
    const test = fixture({
      dependencies: {
        ...base,
        makeTempDirectory: (prefix) => {
          const directory = base.makeTempDirectory(prefix);
          exportDirectory.path = directory;
          return directory;
        },
        inspectOpenFile: (file) => {
          const inspected = base.inspectOpenFile(file);
          const outputPath = path.join(exportDirectory.path, "config.yaml");
          fs.unlinkSync(outputPath);
          fs.symlinkSync(outsidePath, outputPath);
          return inspected;
        },
      },
      host: successfulHost(JSON.stringify(document())),
      secret: SECRET,
    });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      passed: false,
      failureStage: "export",
      cleanup: { succeeded: true },
      diagnostic: "config export output changed while it was being read",
    });
    expect(test.writes.at(-1)).not.toHaveProperty("export");
    expect(JSON.stringify(test.writes.at(-1))).not.toContain(SECRET);
    expect(fs.existsSync(exportDirectory.path)).toBe(false);
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
  it.each(DIAGNOSTIC_SECRET_REPRESENTATIONS)(
    "redacts $name secrets from refusal diagnostics before evidence publication (#11485)",
    async ({ value: representedSecret }) => {
      const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "config-export-evidence-"));
      createdDirectories.push(artifactRoot);
      const artifacts = new ArtifactSink(artifactRoot, [SECRET]);
      const host = refusalHost(`Config export failed (unsupported). ${representedSecret}`);
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
      expect(JSON.parse(stored)).toMatchObject({ diagnostic: "[REDACTED]" });
      expect(stored).not.toContain(SECRET);
      expect(stored).not.toContain(ENCODED_SECRET);
    },
  );
  it("redacts encoded secrets from required-export failure diagnostics (#11485)", async () => {
    const host = refusalHost(`export failed: ${ENCODED_SECRET}`);
    const test = fixture({
      host: host as ReturnType<typeof successfulHost>,
      secret: SECRET,
    });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(host.nemoclaw).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ persistArtifacts: false }),
    );
    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "export",
      diagnostic: "[REDACTED]",
    });
    expect(JSON.stringify(test.writes.at(-1))).not.toContain(ENCODED_SECRET);
  });
  it.each([{ name: "literal", value: INTERNAL_TRANSPORT }, ...INTERNAL_TRANSPORT_REPRESENTATIONS])(
    "redacts $name internal credential transports from refusal diagnostics (#11485)",
    async ({ value }) => {
      const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "config-export-evidence-"));
      createdDirectories.push(artifactRoot);
      const artifacts = new ArtifactSink(artifactRoot);
      const host = refusalHost(`Config export failed (unsupported). ${value}`);
      const test = fixture({
        artifacts,
        host: host as ReturnType<typeof successfulHost>,
      });

      await test.phase.from(target("expected-refusal"), instance());

      const stored = fs.readFileSync(
        path.join(artifactRoot, "config-export-evidence.v1.json"),
        "utf8",
      );
      expect(JSON.parse(stored)).toMatchObject({ diagnostic: "[REDACTED]" });
      expect(stored).not.toContain(INTERNAL_TRANSPORT);
      expect(stored).not.toContain(ENCODED_INTERNAL_TRANSPORT);
    },
  );
  it("redacts encoded internal credential transports from required-export failures (#11485)", async () => {
    const host = refusalHost(`export failed: ${ENCODED_INTERNAL_TRANSPORT}`);
    const test = fixture({ host: host as ReturnType<typeof successfulHost> });

    await captureFailure(test.phase.from(target("required"), instance()));

    expect(test.writes.at(-1)).toMatchObject({
      classification: "failure",
      failureStage: "export",
      diagnostic: "[REDACTED]",
    });
    expect(JSON.stringify(test.writes.at(-1))).not.toContain(ENCODED_INTERNAL_TRANSPORT);
  });
});
