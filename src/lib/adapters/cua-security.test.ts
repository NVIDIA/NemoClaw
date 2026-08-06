// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CUA_ARTIFACT_CLEANUP_OPERATIONS,
  CUA_DENIED_DESTINATIONS,
  CUA_LIFECYCLE_SCHEMA_VERSION,
  CUA_MATERIAL_EXCLUSIONS,
  CUA_PRIVATE_MATERIALS,
  CUA_TASK_OPERATIONS,
  CUA_TARGET_OPERATIONS,
  CUA_UNTRUSTED_INPUTS,
  type CuaRuntimeReadiness,
  type CuaSecurityAttestation,
  type CuaTargetAttachment,
  getCuaRuntimeReadinessDigest,
} from "../cua/contract";
import {
  CuaSecurityAdapterInvocationError,
  type CuaSecurityAdapterRequest,
  ProcessCuaSecurityAdapter,
} from "./cua-security";

const temporaryDirectories: string[] = [];
const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
const appliedPolicy = { revision: 17, digest: digest("a") } as const;
const component = (name: string, value: string) => ({
  name,
  version: "1.0.0",
  digest: digest(value),
  owner: "fixture",
});

const runtime: CuaRuntimeReadiness = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "runtime-readiness",
  agent: "nemocua",
  mode: "standalone",
  status: "available",
  sourceRevision: "a".repeat(40),
  sourceClean: true,
  runtimeManifestDigest: digest("a"),
  providerAuthorityDigest: digest("0"),
  qualification: {
    state: "qualified",
    candidateSourceRevision: "b".repeat(40),
    environmentDigest: digest("c"),
    receiptDigest: digest("d"),
    bundleReceiptDigest: digest("e"),
  },
  components: {
    openshell: component("openshell", "0"),
    runtime: component("runtime", "1"),
    sandboxImage: component("sandbox", "2"),
    targetAdapter: component("target-adapter", "9"),
    policy: component("policy", "3"),
    taskProtocol: component("protocol", "4"),
    securityVerifier: component("security-verifier", "8"),
  },
  inference: {
    provider: "managed-provider",
    model: "managed-model",
    routeDigest: digest("f"),
  },
  commands: { interactive: true, headless: true, version: true, smoke: true },
  limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
  requiredCapabilities: ["browser", "computer", "terminal"],
  targetOperations: CUA_TARGET_OPERATIONS,
  taskOperations: CUA_TASK_OPERATIONS,
  securityOperations: ["security.status", "security.verify"],
};

const target: CuaTargetAttachment = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "target-attachment",
  status: "attached",
  runtimeReadinessDigest: getCuaRuntimeReadinessDigest(runtime),
  target: {
    identityDigest: digest("5"),
    platform: "fixture-linux-amd64",
    image: component("target", "6"),
    serviceBundle: component("services", "7"),
    capabilities: [
      { id: "browser", protocolVersion: "1.0.0", health: "healthy" },
      { id: "computer", protocolVersion: "1.0.0", health: "healthy" },
      { id: "terminal", protocolVersion: "1.0.0", health: "healthy" },
    ],
  },
  activeTask: null,
};

function request(
  verifierDigest = runtime.components.securityVerifier.digest,
): CuaSecurityAdapterRequest {
  const requestRuntime = {
    ...runtime,
    components: {
      ...runtime.components,
      securityVerifier: {
        ...runtime.components.securityVerifier,
        digest: verifierDigest,
      },
    },
  };
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "security-adapter-request",
    operation: "security.verify",
    sandboxName: "alpha",
    appliedPolicy,
    runtime: requestRuntime,
    target: {
      ...target,
      runtimeReadinessDigest: getCuaRuntimeReadinessDigest(requestRuntime),
    },
  };
}

function attestation(adapterRequest = request()): CuaSecurityAttestation {
  const requestTarget = adapterRequest.target.target!;
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "security-attestation",
    status: "enforced",
    bindings: {
      runtimeReadinessDigest: getCuaRuntimeReadinessDigest(adapterRequest.runtime),
      targetIdentityDigest: requestTarget.identityDigest,
      components: {
        openshell: adapterRequest.runtime.components.openshell,
        runtime: adapterRequest.runtime.components.runtime,
        sandboxImage: adapterRequest.runtime.components.sandboxImage,
        targetImage: requestTarget.image,
        serviceBundle: requestTarget.serviceBundle,
        policy: adapterRequest.runtime.components.policy,
        taskProtocol: adapterRequest.runtime.components.taskProtocol,
      },
      inference: adapterRequest.runtime.inference,
      appliedPolicy: adapterRequest.appliedPolicy,
      capabilities: requestTarget.capabilities.map(({ id, protocolVersion }) => ({
        id,
        protocolVersion,
      })),
    },
    network: {
      defaultAction: "deny",
      managedInference: "only",
      targetServices: ["browser", "computer", "terminal"],
      deniedDestinations: CUA_DENIED_DESTINATIONS,
    },
    materialBoundary: {
      delivery: "host-side-secret-boundary",
      sandboxMaterial: "absent",
      excludedFrom: CUA_MATERIAL_EXCLUSIONS,
    },
    isolation: {
      runAs: "non-root",
      privileged: false,
      hostDockerSocket: false,
      hostDesktop: false,
      broadWritableHostMounts: false,
    },
    artifacts: {
      materials: CUA_PRIVATE_MATERIALS,
      classification: "private",
      contentIdentity: "sha256",
      access: "owner-only",
      metadata: "bounded",
      retention: "until-target-detach-or-destroy",
      cleanupOperations: CUA_ARTIFACT_CLEANUP_OPERATIONS,
      backup: "excluded",
    },
    authority: {
      fixtureScope: "synthetic-local",
      externalSideEffects: "denied",
      untrustedInputs: CUA_UNTRUSTED_INPUTS,
      mayExpand: false,
    },
    verifier: adapterRequest.runtime.components.securityVerifier,
  };
}

function executable(source: string, shebang = `#!${process.execPath}`): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-security-adapter-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "adapter.mjs");
  fs.writeFileSync(filePath, `${shebang}\n${source}`, { mode: 0o700 });
  return filePath;
}

function executableDigest(filePath: string): string {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function validAdapterSource(extraField = ""): string {
  return `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (request.kind !== "security-adapter-request") process.exit(2);
const target = request.target.target;
process.stdout.write(JSON.stringify({
  schemaVersion: request.schemaVersion,
  kind: "security-attestation",
  status: "enforced",
  bindings: {
    runtimeReadinessDigest: request.target.runtimeReadinessDigest,
    targetIdentityDigest: target.identityDigest,
    components: {
      openshell: request.runtime.components.openshell,
      runtime: request.runtime.components.runtime,
      sandboxImage: request.runtime.components.sandboxImage,
      targetImage: target.image,
      serviceBundle: target.serviceBundle,
      policy: request.runtime.components.policy,
      taskProtocol: request.runtime.components.taskProtocol,
    },
    inference: request.runtime.inference,
    appliedPolicy: request.appliedPolicy,
    capabilities: target.capabilities.map(({ id, protocolVersion }) => ({ id, protocolVersion })),
  },
  network: ${JSON.stringify(attestation().network)},
  materialBoundary: ${JSON.stringify(attestation().materialBoundary)},
  isolation: ${JSON.stringify(attestation().isolation)},
  artifacts: ${JSON.stringify(attestation().artifacts)},
  authority: ${JSON.stringify(attestation().authority)},
  verifier: request.runtime.components.securityVerifier,
  ${extraField}
}));
`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("process CUA security adapter (#7754)", () => {
  it("accepts only a schema-validated content-free security attestation", () => {
    const adapterPath = executable(validAdapterSource());
    const adapterRequest = request(executableDigest(adapterPath));
    const adapter = new ProcessCuaSecurityAdapter(adapterPath);

    expect(adapter.execute(adapterRequest)).toEqual(attestation(adapterRequest));
    expect(adapter.executableDigest).toBe(executableDigest(adapterPath));
  });

  it("requires the fixed target channel when invoking through the qualification runner", () => {
    const adapterPath = executable(validAdapterSource());
    const adapterRequest = request(executableDigest(adapterPath));
    const markerPath = path.join(path.dirname(adapterPath), "runner-invocation");
    const runnerPath = executable(`
import fs from "node:fs";
import { spawnSync } from "node:child_process";
if (process.argv[2] !== "--require-target-channel") process.exit(124);
if (process.argv[3] !== "--artifact-sha256") process.exit(123);
if (!/^[0-9a-f]{64}$/.test(process.argv[4])) process.exit(122);
if (process.argv[5] !== "--") process.exit(121);
const snapshot = process.argv[6];
const expectedDigest = ${JSON.stringify(executableDigest(adapterPath).slice("sha256:".length))};
if (process.argv[4] !== expectedDigest) process.exit(120);
fs.writeFileSync(${JSON.stringify(markerPath)}, snapshot, { flag: "wx" });
const result = spawnSync(snapshot, [], { stdio: "inherit" });
process.exit(result.status ?? 125);
`);
    const adapter = new ProcessCuaSecurityAdapter(adapterPath, {
      qualificationArtifactRunner: runnerPath,
    });

    expect(adapter.execute(adapterRequest)).toEqual(attestation(adapterRequest));
    const invokedPath = fs.readFileSync(markerPath, "utf8");
    expect(invokedPath).not.toBe(adapterPath);
    expect(invokedPath).toContain("nemoclaw-cua-security-verifier-");
    expect(fs.existsSync(invokedPath)).toBe(false);
  });

  it("does not forward host authority variables or copy private stderr", () => {
    vi.stubEnv("CUA_SECURITY_TEST_AUTHORITY", "private-value");
    const adapterPath = executable(`
if (process.env.CUA_SECURITY_TEST_AUTHORITY) {
  process.stdout.write("environment-leaked");
  process.exit(0);
}
process.stderr.write("private-security-diagnostic");
    process.stdout.write("not-json");
`);
    const adapter = new ProcessCuaSecurityAdapter(adapterPath);
    const adapterRequest = request(executableDigest(adapterPath));

    expect(() => adapter.execute(adapterRequest)).toThrowError(CuaSecurityAdapterInvocationError);
    try {
      adapter.execute(adapterRequest);
    } catch (error) {
      expect(String(error)).not.toContain("private-security-diagnostic");
      expect(String(error)).not.toContain("private-value");
    }
  });

  it("rejects a relative verifier path before starting a process", () => {
    expect(() => new ProcessCuaSecurityAdapter("adapter").execute(request())).toThrow(
      "path must be absolute",
    );
  });

  it("rejects additional runtime-authored authority fields", () => {
    const adapterPath = executable(validAdapterSource('endpoint: "https://host.invalid",'));
    const adapterRequest = request(executableDigest(adapterPath));

    expect(() => new ProcessCuaSecurityAdapter(adapterPath).execute(adapterRequest)).toThrow(
      "invalid lifecycle record",
    );
  });

  it("rejects an unregistered verifier even when it returns a valid attestation", () => {
    const adapterPath = executable(validAdapterSource());

    expect(() => new ProcessCuaSecurityAdapter(adapterPath).execute(request())).toThrow(
      "does not match runtime readiness",
    );
  });

  it("rejects a symlink before starting the verifier", () => {
    const adapterPath = executable(validAdapterSource());
    const symlinkPath = path.join(path.dirname(adapterPath), "adapter-link.mjs");
    fs.symlinkSync(adapterPath, symlinkPath);

    expect(() =>
      new ProcessCuaSecurityAdapter(symlinkPath).execute(request(executableDigest(adapterPath))),
    ).toThrow("unavailable");
  });

  it("uses an isolated home and a fixed trusted path", () => {
    vi.stubEnv("HOME", "/host-private-home");
    vi.stubEnv("PATH", "/host-private-bin");
    const adapterPath = executable(`
if (
  process.env.HOME === "/host-private-home" ||
  !process.env.HOME?.includes("nemoclaw-cua-security-verifier-") ||
  process.env.PATH !== "/usr/bin:/bin" ||
  process.env.TMPDIR === process.env.HOME
) {
  process.stdout.write("environment-leaked");
  process.exit(0);
}
${validAdapterSource()}
`);
    const adapterRequest = request(executableDigest(adapterPath));

    expect(new ProcessCuaSecurityAdapter(adapterPath).execute(adapterRequest)).toEqual(
      attestation(adapterRequest),
    );
  });

  it("rejects an env-resolved interpreter before host PATH can select it", () => {
    const maliciousDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cua-security-path-"),
    );
    temporaryDirectories.push(maliciousDirectory);
    const markerPath = path.join(maliciousDirectory, "interpreter-ran");
    const maliciousNode = path.join(maliciousDirectory, "node");
    fs.writeFileSync(maliciousNode, `#!/bin/sh\ntouch ${JSON.stringify(markerPath)}\n`, {
      mode: 0o700,
    });
    vi.stubEnv("PATH", maliciousDirectory);
    const adapterPath = executable(validAdapterSource(), "#!/usr/bin/env node");
    const adapterRequest = request(executableDigest(adapterPath));

    expect(() => new ProcessCuaSecurityAdapter(adapterPath).execute(adapterRequest)).toThrow(
      "unavailable",
    );
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("rejects a replaced verifier before its replacement can run", () => {
    const adapterPath = executable(validAdapterSource());
    const markerPath = path.join(path.dirname(adapterPath), "replacement-ran");
    const adapterRequest = request(executableDigest(adapterPath));
    const adapter = new ProcessCuaSecurityAdapter(adapterPath);
    expect(adapter.execute(adapterRequest)).toEqual(attestation(adapterRequest));

    fs.writeFileSync(
      adapterPath,
      `#!${process.execPath}\nimport fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerPath)}, "ran");`,
      { mode: 0o700 },
    );

    expect(() => adapter.execute(adapterRequest)).toThrow("does not match runtime readiness");
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(adapter.executableDigest).toBeNull();
  });
});
