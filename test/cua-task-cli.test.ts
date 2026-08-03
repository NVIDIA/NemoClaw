// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "bin", "nemoclaw.js");
const temporaryDirectories: string[] = [];
const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
const component = (name: string, value: string) => ({
  name,
  version: "1.0.0",
  digest: digest(value),
  owner: "fixture",
});

function fixture(): {
  home: string;
  adapterPath: string;
  inputPath: string;
  registryPath: string;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-task-cli-"));
  temporaryDirectories.push(home);
  const stateDirectory = path.join(home, ".nemoclaw");
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const registryPath = path.join(stateDirectory, "sandboxes.json");
  const runtime = {
    schemaVersion: "1.0.0",
    kind: "runtime-readiness",
    mode: "standalone",
    status: "available",
    components: {
      runtime: component("cua-fixture", "1"),
      sandboxImage: component("sandbox-fixture", "2"),
      policy: component("policy-fixture", "3"),
      taskProtocol: component("task-fixture", "4"),
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
      "task.pause",
      "task.cancel",
      "task.guide",
      "task.respond",
    ],
  };
  const target = {
    schemaVersion: "1.0.0",
    kind: "target-attachment",
    status: "attached",
    target: {
      identityDigest: digest("5"),
      platform: "fixture-linux-amd64",
      image: component("desktop-fixture", "6"),
      serviceBundle: component("service-fixture", "7"),
      capabilities: [
        { id: "browser", protocolVersion: "1.0.0", health: "healthy" },
        { id: "computer", protocolVersion: "1.0.0", health: "healthy" },
        { id: "terminal", protocolVersion: "1.0.0", health: "healthy" },
      ],
    },
    activeTask: null,
  };
  const security = {
    schemaVersion: "1.0.0",
    kind: "security-attestation",
    status: "enforced",
    bindings: {
      targetIdentityDigest: target.target.identityDigest,
      components: {
        runtime: runtime.components.runtime,
        sandboxImage: runtime.components.sandboxImage,
        targetImage: target.target.image,
        serviceBundle: target.target.serviceBundle,
        policy: runtime.components.policy,
        taskProtocol: runtime.components.taskProtocol,
      },
      inference: runtime.inference,
      capabilities: target.target.capabilities.map(({ id, protocolVersion }) => ({
        id,
        protocolVersion,
      })),
    },
    network: {
      defaultAction: "deny",
      managedInference: "only",
      targetServices: ["browser", "computer", "terminal"],
      deniedDestinations: [
        "unrelated-internet",
        "cloud-metadata",
        "undeclared-loopback",
        "host-administration",
        "host-desktop",
        "docker-socket",
      ],
    },
    materialBoundary: {
      delivery: "host-side-secret-boundary",
      sandboxMaterial: "absent",
      excludedFrom: [
        "prompt",
        "sandbox-filesystem",
        "arguments",
        "logs",
        "state",
        "diagnostics",
        "backups",
        "public-json",
        "build-logs",
      ],
    },
    isolation: {
      runAs: "non-root",
      privileged: false,
      hostDockerSocket: false,
      hostDesktop: false,
      broadWritableHostMounts: false,
    },
    artifacts: {
      materials: [
        "screenshots",
        "page-content",
        "screen-content",
        "downloads",
        "browser-profiles",
        "cookies",
        "mutable-target-state",
        "task-content",
        "results",
        "logs",
        "documents",
      ],
      classification: "private",
      contentIdentity: "sha256",
      access: "owner-only",
      metadata: "bounded",
      retention: "until-target-reset-or-destroy",
      cleanupOperations: ["target.reset", "target.destroy"],
      backup: "excluded",
    },
    authority: {
      fixtureScope: "synthetic-local",
      externalSideEffects: "denied",
      untrustedInputs: [
        "page-content",
        "screen-content",
        "downloads",
        "task-input",
        "runtime-output",
      ],
      mayExpand: false,
    },
    verifier: component("security-fixture", "d"),
  };
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: {
          name: "alpha",
          cuaRuntimeReadiness: runtime,
          cuaTarget: target,
          cuaSecurityAttestation: security,
          cuaTaskResults: [],
        },
      },
    }),
    { mode: 0o600 },
  );

  const inputPath = path.join(home, "task-input.txt");
  fs.writeFileSync(inputPath, "private synthetic task input", { mode: 0o600 });

  const adapterPath = path.join(home, "task-adapter.mjs");
  fs.writeFileSync(
    adapterPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const statePath = path.join(process.env.HOME, ".cua-task-fixture-state.json");
const target = request.target.target;
const active = (status = "running") => ({
  ...request.target,
  status: "attached",
  activeTask: { taskId: request.taskId, status },
});
const result = (status = "succeeded") => ({
  schemaVersion: request.schemaVersion,
  kind: "task-result",
  taskId: request.taskId,
  status,
  targetIdentityDigest: target.identityDigest,
  components: {
    runtime: request.runtime.components.runtime,
    sandboxImage: request.runtime.components.sandboxImage,
    targetImage: target.image,
    serviceBundle: target.serviceBundle,
    policy: request.runtime.components.policy,
    taskProtocol: request.runtime.components.taskProtocol,
  },
  inference: request.runtime.inference,
  capabilities: target.capabilities.map(({ id, protocolVersion }) => ({ id, protocolVersion })),
  agentResult: {
    status,
    resultDigest: "${digest("8")}",
  },
  verification: {
    status: status === "succeeded" ? "passed" : "not-run",
    checkIds: status === "succeeded" ? ["browser-form-json", "terminal-file", "computer-docx"] : [],
    evidenceDigests: status === "succeeded" ? ["${digest("9")}"] : [],
  },
  receipts: status === "succeeded"
    ? [
        { capability: "browser", status: "completed", evidenceDigests: ["${digest("9")}"] },
        { capability: "computer", status: "completed", evidenceDigests: ["${digest("a")}"] },
        { capability: "terminal", status: "completed", evidenceDigests: ["${digest("b")}"] },
      ]
    : [],
  evidence: [
    { digest: "${digest("8")}", classification: "private", mediaType: "application/json" },
    ...(status === "succeeded"
      ? [
          { digest: "${digest("9")}", classification: "private", mediaType: "application/json" },
          { digest: "${digest("a")}", classification: "private", mediaType: "image/png" },
          { digest: "${digest("b")}", classification: "private", mediaType: "text/plain" },
        ]
      : []),
  ],
});
const evidenceCategory = request.operation.slice("task.".length);
const evidence = () => ({
  schemaVersion: request.schemaVersion,
  kind: "task-evidence-index",
  taskId: request.taskId,
  category: evidenceCategory,
  targetIdentityDigest: target.identityDigest,
  evidence: [{
    digest: "${digest("9")}",
    classification: "private",
    mediaType: "application/json",
    sizeBytes: 42,
  }],
});
const responses = {
  "task.start": () => {
    fs.writeFileSync(statePath, JSON.stringify({
      taskId: request.taskId,
      mode: request.mode,
      inputDigest: "${digest("c")}",
    }));
    return active();
  },
  "task.status": () => active(),
  "task.events": evidence,
  "task.logs": evidence,
  "task.plans": evidence,
  "task.pause": () => active("paused"),
  "task.guide": () => active(),
  "task.respond": () => active(),
  "task.result": () => {
    fs.writeFileSync(statePath, JSON.stringify({ taskId: request.taskId, status: "succeeded" }));
    return result();
  },
  "task.cancel": () => {
    fs.writeFileSync(statePath, JSON.stringify({ taskId: request.taskId, status: "cancelled" }));
    return result("cancelled");
  },
};
process.stdout.write(JSON.stringify(responses[request.operation]()));
`,
    { mode: 0o700 },
  );
  return { home, adapterPath, inputPath, registryPath };
}

function run(home: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

function taskArgs(adapterPath: string, operation: string): string[] {
  return [
    "sandbox",
    "cua",
    "task",
    operation,
    "alpha",
    "--adapter",
    adapterPath,
    "--task-id",
    "task-1",
    "--json",
  ];
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("public CUA task commands (#7752)", () => {
  it("starts, observes, retrieves evidence, completes, and reconnects through one task ID", () => {
    const { home, adapterPath, inputPath, registryPath } = fixture();
    const start = run(home, [
      ...taskArgs(adapterPath, "start"),
      "--mode",
      "headless",
      "--input-file",
      inputPath,
    ]);
    expect(start.status, start.stderr).toBe(0);
    expect(JSON.parse(start.stdout)).toMatchObject({
      kind: "target-attachment",
      activeTask: { taskId: "task-1", status: "running" },
    });

    const conflict = run(home, [
      ...taskArgs(adapterPath, "start"),
      "--mode",
      "interactive",
      "--input-file",
      inputPath,
    ]);
    expect(conflict.status).toBe(3);
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      kind: "failure",
      family: "task_conflict",
    });

    const status = run(home, taskArgs(adapterPath, "status"));
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      activeTask: { taskId: "task-1", status: "running" },
    });

    const events = run(home, taskArgs(adapterPath, "events"));
    expect(events.status, events.stderr).toBe(0);
    expect(JSON.parse(events.stdout)).toMatchObject({
      kind: "task-evidence-index",
      taskId: "task-1",
      category: "events",
      evidence: [{ classification: "private" }],
    });

    const completed = run(home, taskArgs(adapterPath, "result"));
    expect(completed.status, completed.stderr).toBe(0);
    expect(JSON.parse(completed.stdout)).toMatchObject({
      kind: "task-result",
      taskId: "task-1",
      status: "succeeded",
      components: {
        runtime: { digest: digest("1") },
        sandboxImage: { digest: digest("2") },
        targetImage: { digest: digest("6") },
        serviceBundle: { digest: digest("7") },
        policy: { digest: digest("3") },
        taskProtocol: { digest: digest("4") },
      },
      receipts: [
        { capability: "browser", status: "completed" },
        { capability: "computer", status: "completed" },
        { capability: "terminal", status: "completed" },
      ],
    });

    fs.rmSync(adapterPath);
    const reconnected = run(home, taskArgs(adapterPath, "result"));
    expect(reconnected.status, reconnected.stderr).toBe(0);
    expect(JSON.parse(reconnected.stdout)).toEqual(JSON.parse(completed.stdout));

    const persisted = fs.readFileSync(registryPath, "utf8");
    expect(persisted).not.toContain("private synthetic task input");
    expect(persisted).not.toContain(adapterPath);
    expect(persisted).not.toContain(inputPath);
  });

  it("cancels to a terminal result without leaving an active task", () => {
    const { home, adapterPath, inputPath, registryPath } = fixture();
    const start = run(home, [
      ...taskArgs(adapterPath, "start"),
      "--mode",
      "interactive",
      "--input-file",
      inputPath,
    ]);
    expect(start.status, start.stderr).toBe(0);

    const cancelled = run(home, taskArgs(adapterPath, "cancel"));
    expect(cancelled.status, cancelled.stderr).toBe(0);
    expect(JSON.parse(cancelled.stdout)).toMatchObject({
      kind: "task-result",
      taskId: "task-1",
      status: "cancelled",
      agentResult: { status: "cancelled" },
    });
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    expect(registry.sandboxes.alpha.cuaTarget.activeTask).toBeNull();
  });

  it("rejects task input that is not valid UTF-8 before invoking the adapter", () => {
    const { home, adapterPath, inputPath } = fixture();
    fs.writeFileSync(inputPath, Buffer.from([0xc3, 0x28]));

    const started = run(home, [
      ...taskArgs(adapterPath, "start"),
      "--mode",
      "headless",
      "--input-file",
      inputPath,
    ]);

    expect(started.status).toBe(2);
    expect(JSON.parse(started.stdout)).toMatchObject({
      kind: "failure",
      family: "validation_failed",
    });
  });

  it("rejects a symbolic link as private task input before invoking the adapter", () => {
    const { home, adapterPath, inputPath } = fixture();
    const linkedInputPath = path.join(home, "linked-task-input.txt");
    fs.symlinkSync(inputPath, linkedInputPath);

    const started = run(home, [
      ...taskArgs(adapterPath, "start"),
      "--mode",
      "headless",
      "--input-file",
      linkedInputPath,
    ]);

    expect(started.status).toBe(2);
    expect(JSON.parse(started.stdout)).toMatchObject({
      kind: "failure",
      family: "validation_failed",
    });
  });
});
