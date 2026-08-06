// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CUA_LIFECYCLE_SCHEMA_VERSION,
  type CuaRuntimeReadiness,
  type CuaTargetAttachment,
  getCuaRuntimeReadinessDigest,
} from "../cua/contract";
import {
  CuaTaskAdapterInvocationError,
  type CuaTaskAdapterRequest,
  ProcessCuaTaskAdapter,
} from "./cua-task";

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
    securityVerifier: component("verifier", "8"),
  },
  inference: { provider: "fixture", model: "fixture-model", routeDigest: digest("f") },
  commands: { interactive: true, headless: true, version: true, smoke: true },
  limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
  requiredCapabilities: ["browser", "computer", "terminal"],
  targetOperations: [
    "target.attach",
    "target.status",
    "target.health",
    "target.detach",
    "target.destroy",
  ],
  taskOperations: ["task.start", "task.status", "task.result", "task.cancel"],
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
  activeTask: { taskId: "task-1", status: "running", appliedPolicy },
};

function request(): CuaTaskAdapterRequest {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "task-adapter-request",
    operation: "task.status",
    sandboxName: "alpha",
    taskId: "task-1",
    mode: null,
    input: null,
    appliedPolicy,
    runtime,
    target,
  };
}

function executable(source: string, shebang = `#!${process.execPath}`): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-task-adapter-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "adapter.mjs");
  fs.writeFileSync(filePath, `${shebang}\n${source}`, { mode: 0o700 });
  return filePath;
}

function executableDigest(filePath: string): string {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("process CUA task adapter (#7752)", () => {
  it("sends one bounded request and accepts task status", () => {
    const adapterPath = executable(`
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
process.stdout.write(JSON.stringify(request.target));
`);

    const adapter = new ProcessCuaTaskAdapter(adapterPath);
    const record = adapter.execute(request()) as CuaTargetAttachment;

    expect(record).toMatchObject({
      kind: "target-attachment",
      status: "attached",
    });
    expect(adapter.executableDigest).toBe(executableDigest(adapterPath));
  });

  it("requires the fixed target channel when invoking through the qualification runner", () => {
    const adapterPath = executable(`
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
process.stdout.write(JSON.stringify({
  schemaVersion: request.schemaVersion,
  kind: "failure",
  operation: request.operation,
  family: "task_timeout",
  retryable: true
}));
`);
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
    const adapter = new ProcessCuaTaskAdapter(adapterPath, {
      qualificationArtifactRunner: runnerPath,
    });

    expect(adapter.execute(request()).kind).toBe("failure");
    const invokedPath = fs.readFileSync(markerPath, "utf8");
    expect(invokedPath).not.toBe(adapterPath);
    expect(invokedPath).toContain("nemoclaw-cua-task-adapter-");
    expect(fs.existsSync(invokedPath)).toBe(false);
  });

  it("does not copy runtime-private stderr into a validation error", () => {
    const adapterPath = executable(`
process.stderr.write("private-runtime-diagnostic");
process.stdout.write("not-json");
`);
    const adapter = new ProcessCuaTaskAdapter(adapterPath);

    expect(() => adapter.execute(request())).toThrowError(CuaTaskAdapterInvocationError);
    try {
      adapter.execute(request());
    } catch (error) {
      expect(String(error)).not.toContain("private-runtime-diagnostic");
    }
  });

  it("rejects a succeeded result without complete capability and independent proof", () => {
    const incompleteResult = {
      schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
      kind: "task-result",
      taskId: "task-1",
      status: "succeeded",
      targetIdentityDigest: target.target!.identityDigest,
      runtimeReadinessDigest: target.runtimeReadinessDigest,
      components: {
        openshell: runtime.components.openshell,
        runtime: runtime.components.runtime,
        sandboxImage: runtime.components.sandboxImage,
        targetImage: target.target!.image,
        serviceBundle: target.target!.serviceBundle,
        policy: runtime.components.policy,
        taskProtocol: runtime.components.taskProtocol,
      },
      inference: runtime.inference,
      appliedPolicy,
      capabilities: target
        .target!.capabilities.filter(({ id }) => id === "browser")
        .map(({ id, protocolVersion }) => ({ id, protocolVersion })),
      agentResult: { status: "succeeded", resultDigest: digest("8") },
      verification: {
        status: "passed",
        checkIds: [],
        evidenceDigests: [],
      },
      receipts: [],
      evidence: [{ digest: digest("8"), classification: "private" }],
    };
    const adapterPath = executable(`
for await (const _chunk of process.stdin) {}
process.stdout.write(${JSON.stringify(JSON.stringify(incompleteResult))});
`);
    const resultRequest = request();
    resultRequest.operation = "task.result";

    expect(() => new ProcessCuaTaskAdapter(adapterPath).execute(resultRequest)).toThrow(
      "the CUA task adapter returned an invalid lifecycle record",
    );
  });

  it("rejects a relative executable before starting a process", () => {
    const adapter = new ProcessCuaTaskAdapter("adapter");
    expect(() => adapter.execute(request())).toThrow("path must be absolute");
  });

  it("does not forward unrelated host credential variables", () => {
    vi.stubEnv("CUA_TASK_TEST_AUTHORITY", "private-value");
    vi.stubEnv("HOME", "/host-private-home");
    vi.stubEnv("PATH", "/host-private-bin");
    const adapterPath = executable(`
if (
  process.env.CUA_TASK_TEST_AUTHORITY ||
  process.env.HOME === "/host-private-home" ||
  !process.env.HOME?.includes("nemoclaw-cua-task-adapter-") ||
  process.env.PATH !== "/usr/bin:/bin" ||
  process.env.TMPDIR === process.env.HOME
) {
  process.stdout.write("environment-leaked");
  process.exit(0);
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
process.stdout.write(JSON.stringify(request.target));
`);

    expect(new ProcessCuaTaskAdapter(adapterPath).execute(request()).kind).toBe(
      "target-attachment",
    );
  });

  it("rejects a symlink without starting its task adapter target", () => {
    const adapterPath = executable(`
process.stdout.write("not-reached");
`);
    const symlinkPath = path.join(path.dirname(adapterPath), "adapter-link.mjs");
    fs.symlinkSync(adapterPath, symlinkPath);

    expect(() => new ProcessCuaTaskAdapter(symlinkPath).execute(request())).toThrow("unavailable");
  });

  it("rejects a replaced task adapter when an immutable digest is required", () => {
    const adapterPath = executable(`
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
process.stdout.write(JSON.stringify({
  schemaVersion: request.schemaVersion,
  kind: "failure",
  operation: request.operation,
  family: "task_timeout",
  retryable: true
}));
`);
    const markerPath = path.join(path.dirname(adapterPath), "replacement-ran");
    const adapter = new ProcessCuaTaskAdapter(adapterPath, {
      expectedDigest: executableDigest(adapterPath),
    });
    expect(adapter.execute(request()).kind).toBe("failure");

    fs.writeFileSync(
      adapterPath,
      `#!${process.execPath}\nimport fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerPath)}, "ran");`,
      { mode: 0o700 },
    );

    expect(() => adapter.execute(request())).toThrow("expected digest");
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(adapter.executableDigest).toBeNull();
  });
});
