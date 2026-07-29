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

function fixture(unsafe = false): {
  home: string;
  adapterPath: string;
  registryPath: string;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-security-cli-"));
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
      runtime: component("runtime", "1"),
      sandboxImage: component("sandbox", "2"),
      policy: component("policy", "3"),
      taskProtocol: component("protocol", "4"),
    },
    inference: { provider: "managed-provider", model: "managed-model" },
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
  const target = {
    schemaVersion: "1.0.0",
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
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: {
          name: "alpha",
          cuaRuntimeReadiness: runtime,
          cuaTarget: target,
        },
      },
    }),
    { mode: 0o600 },
  );

  const adapterPath = path.join(home, "security-adapter.mjs");
  fs.writeFileSync(
    adapterPath,
    `#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const target = request.target.target;
const attestation = {
  schemaVersion: request.schemaVersion,
  kind: "security-attestation",
  status: "enforced",
  bindings: {
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
  verifier: {
    name: "security-verifier",
    version: "1.0.0",
    digest: "${digest("8")}",
    owner: "fixture",
  },
  ${unsafe ? 'endpoint: "https://host.invalid",' : ""}
};
process.stdout.write(JSON.stringify(attestation));
`,
    { mode: 0o700 },
  );
  return { home, adapterPath, registryPath };
}

function run(home: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("public CUA security commands (#7754)", () => {
  it("verifies, persists, and reconnects through a content-free attestation", () => {
    const { home, adapterPath, registryPath } = fixture();
    const verified = run(home, [
      "sandbox",
      "cua",
      "security",
      "verify",
      "alpha",
      "--adapter",
      adapterPath,
      "--json",
    ]);

    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      kind: "security-attestation",
      status: "enforced",
      network: { defaultAction: "deny", managedInference: "only" },
      isolation: { privileged: false, hostDockerSocket: false, hostDesktop: false },
      artifacts: { classification: "private", backup: "excluded" },
      authority: { externalSideEffects: "denied", mayExpand: false },
    });

    fs.rmSync(adapterPath);
    const status = run(home, ["sandbox", "cua", "security", "status", "alpha", "--json"]);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual(JSON.parse(verified.stdout));

    const persisted = fs.readFileSync(registryPath, "utf8");
    expect(persisted).not.toMatch(
      /host\.invalid|"(endpoint|hostname|cookie|password|token|credential|ssh|vnc)"\s*:/i,
    );
  });

  it("fails closed when verifier output tries to introduce an endpoint", () => {
    const { home, adapterPath } = fixture(true);
    const verified = run(home, [
      "sandbox",
      "cua",
      "security",
      "verify",
      "alpha",
      "--adapter",
      adapterPath,
      "--json",
    ]);

    expect(verified.status).toBe(5);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      kind: "failure",
      family: "policy_invalid",
      component: "policy",
    });
  });
});
