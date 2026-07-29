// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CUA_LIFECYCLE_SCHEMA_VERSION,
  type CuaRuntimeReadiness,
  type CuaTargetAttachment,
  type CuaTaskEvidenceIndex,
} from "../cua/contract";
import {
  CuaTaskAdapterInvocationError,
  type CuaTaskAdapterRequest,
  ProcessCuaTaskAdapter,
} from "./cua-task";

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
  inference: { provider: "fixture", model: "fixture-model" },
  commands: { interactive: true, headless: true, version: true, smoke: true },
  limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
  requiredCapabilities: ["browser", "computer", "terminal"],
  targetOperations: [
    "target.attach",
    "target.status",
    "target.health",
    "target.detach",
    "target.reset",
    "target.destroy",
  ],
  taskOperations: [
    "task.start",
    "task.status",
    "task.result",
    "task.events",
    "task.logs",
    "task.plans",
    "task.cancel",
  ],
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
  activeTask: { taskId: "task-1", status: "running" },
};

function request(): CuaTaskAdapterRequest {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "task-adapter-request",
    operation: "task.events",
    sandboxName: "alpha",
    taskId: "task-1",
    mode: null,
    input: null,
    runtime,
    target,
  };
}

function executable(source: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-task-adapter-"));
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

describe("process CUA task adapter (#7752)", () => {
  it("sends one bounded request and accepts a task evidence index", () => {
    const adapterPath = executable(`
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
process.stdout.write(JSON.stringify({
  schemaVersion: request.schemaVersion,
  kind: "task-evidence-index",
  taskId: request.taskId,
  category: "events",
  targetIdentityDigest: request.target.target.identityDigest,
  evidence: [{
    digest: "${digest("8")}",
    classification: "private",
    mediaType: "application/json",
    sizeBytes: 42
  }]
}));
`);

    const record = new ProcessCuaTaskAdapter(adapterPath).execute(
      request(),
    ) as CuaTaskEvidenceIndex;

    expect(record).toMatchObject({
      kind: "task-evidence-index",
      taskId: "task-1",
      category: "events",
    });
    expect(record.evidence).toEqual([
      {
        digest: digest("8"),
        classification: "private",
        mediaType: "application/json",
        sizeBytes: 42,
      },
    ]);
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

  it("rejects a relative executable before starting a process", () => {
    const adapter = new ProcessCuaTaskAdapter("adapter");
    expect(() => adapter.execute(request())).toThrow("path must be absolute");
  });

  it("does not forward unrelated host credential variables", () => {
    vi.stubEnv("CUA_TASK_TEST_AUTHORITY", "private-value");
    const adapterPath = executable(`
if (process.env.CUA_TASK_TEST_AUTHORITY) {
  process.stdout.write("environment-leaked");
  process.exit(0);
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
process.stdout.write(JSON.stringify({
  schemaVersion: request.schemaVersion,
  kind: "task-evidence-index",
  taskId: request.taskId,
  category: "events",
  targetIdentityDigest: request.target.target.identityDigest,
  evidence: []
}));
`);

    expect(new ProcessCuaTaskAdapter(adapterPath).execute(request()).kind).toBe(
      "task-evidence-index",
    );
  });
});
