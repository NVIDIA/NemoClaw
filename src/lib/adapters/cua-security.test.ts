// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  CUA_REQUIRED_TASK_OPERATIONS,
  CUA_TARGET_OPERATIONS,
  CUA_UNTRUSTED_INPUTS,
  type CuaRuntimeReadiness,
  type CuaSecurityAttestation,
  type CuaTargetAttachment,
} from "../cua/contract";
import {
  CuaSecurityAdapterInvocationError,
  type CuaSecurityAdapterRequest,
  ProcessCuaSecurityAdapter,
} from "./cua-security";

const temporaryDirectories: string[] = [];
const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
const component = (name: string, value: string) => ({
  name,
  version: "1.0.0",
  digest: digest(value),
  owner: "fixture",
});

const runtime: CuaRuntimeReadiness = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "runtime-readiness",
  mode: "standalone",
  status: "available",
  components: {
    runtime: component("runtime", "1"),
    sandboxImage: component("sandbox", "2"),
    policy: component("policy", "3"),
    taskProtocol: component("protocol", "4"),
  },
  inference: { provider: "managed-provider", model: "managed-model" },
  commands: { interactive: true, headless: true, version: true, smoke: true },
  limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
  requiredCapabilities: ["browser", "computer", "terminal"],
  targetOperations: CUA_TARGET_OPERATIONS,
  taskOperations: CUA_REQUIRED_TASK_OPERATIONS,
};

const target: CuaTargetAttachment = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "target-attachment",
  status: "attached",
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

function request(): CuaSecurityAdapterRequest {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "security-adapter-request",
    operation: "security.verify",
    sandboxName: "alpha",
    runtime,
    target,
  };
}

function attestation(): CuaSecurityAttestation {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "security-attestation",
    status: "enforced",
    bindings: {
      targetIdentityDigest: target.target!.identityDigest,
      components: {
        runtime: runtime.components.runtime,
        sandboxImage: runtime.components.sandboxImage,
        targetImage: target.target!.image,
        serviceBundle: target.target!.serviceBundle,
        policy: runtime.components.policy,
        taskProtocol: runtime.components.taskProtocol,
      },
      inference: runtime.inference,
      capabilities: target.target!.capabilities.map(({ id, protocolVersion }) => ({
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
      retention: "until-target-reset-or-destroy",
      cleanupOperations: CUA_ARTIFACT_CLEANUP_OPERATIONS,
      backup: "excluded",
    },
    authority: {
      fixtureScope: "synthetic-local",
      externalSideEffects: "denied",
      untrustedInputs: CUA_UNTRUSTED_INPUTS,
      mayExpand: false,
    },
    verifier: component("security-verifier", "8"),
  };
}

function executable(source: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-security-adapter-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "adapter.mjs");
  fs.writeFileSync(filePath, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
  return filePath;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("process CUA security adapter (#7754)", () => {
  it("accepts only a schema-validated content-free security attestation", () => {
    const expected = attestation();
    const adapterPath = executable(`
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (request.kind !== "security-adapter-request") process.exit(2);
process.stdout.write(${JSON.stringify(JSON.stringify(expected))});
`);

    expect(new ProcessCuaSecurityAdapter(adapterPath).execute(request())).toEqual(expected);
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

    expect(() => adapter.execute(request())).toThrowError(CuaSecurityAdapterInvocationError);
    try {
      adapter.execute(request());
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
    const unsafe = { ...attestation(), endpoint: "https://host.invalid" };
    const adapterPath = executable(
      `process.stdout.write(${JSON.stringify(JSON.stringify(unsafe))});`,
    );

    expect(() => new ProcessCuaSecurityAdapter(adapterPath).execute(request())).toThrow(
      "invalid lifecycle record",
    );
  });
});
