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
  manifestPath: string;
  registryPath: string;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-target-cli-"));
  temporaryDirectories.push(home);
  const stateDirectory = path.join(home, ".nemoclaw");
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const registryPath = path.join(stateDirectory, "sandboxes.json");
  const runtimeReadiness = {
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
      "task.cancel",
    ],
  };
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: { alpha: { name: "alpha", cuaRuntimeReadiness: runtimeReadiness } },
    }),
    { mode: 0o600 },
  );

  const manifest = {
    schemaVersion: "1.0.0",
    kind: "target-manifest",
    identityDigest: digest("5"),
    platform: "fixture-linux-amd64",
    image: component("desktop-fixture", "6"),
    serviceBundle: component("service-fixture", "7"),
    capabilities: [
      { id: "browser", protocolVersion: "1.0.0" },
      { id: "computer", protocolVersion: "1.0.0" },
      { id: "terminal", protocolVersion: "1.0.0" },
    ],
  };
  const manifestPath = path.join(home, "target-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });

  const adapterPath = path.join(home, "target-adapter.mjs");
  fs.writeFileSync(
    adapterPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const targetStatePath = path.join(process.env.HOME, ".cua-target-fixture-state.json");
const detached = {
  schemaVersion: "1.0.0",
  kind: "target-attachment",
  status: "detached",
  target: null,
  activeTask: null,
};
if (request.operation === "target.detach" || request.operation === "target.destroy") {
  if (request.operation === "target.destroy") {
    fs.rmSync(targetStatePath, { force: true });
  } else {
    fs.writeFileSync(targetStatePath, JSON.stringify({ reachable: false }));
  }
  process.stdout.write(JSON.stringify(detached));
  process.exit(0);
}
const source = request.manifest ?? request.current.target;
if (request.operation === "target.attach" || request.operation === "target.reset") {
  fs.writeFileSync(targetStatePath, JSON.stringify({
    reachable: true,
    browserProfile: "clean",
    fixtureState: "seeded",
  }));
}
const identityDigest =
  request.operation === "target.reset"
    ? "${digest("8")}"
    : source.identityDigest;
process.stdout.write(JSON.stringify({
  schemaVersion: "1.0.0",
  kind: "target-attachment",
  status: "attached",
  target: {
    identityDigest,
    platform: source.platform,
    image: source.image,
    serviceBundle: source.serviceBundle,
    capabilities: source.capabilities.map((capability) => ({
      id: capability.id,
      protocolVersion: capability.protocolVersion,
      health: "healthy",
    })),
  },
  activeTask: null,
}));
`,
    { mode: 0o700 },
  );
  return { home, adapterPath, manifestPath, registryPath };
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

describe("public CUA target commands (#7751)", () => {
  it("attach, inspect, reset, and detach through one synthetic host adapter", () => {
    const { home, adapterPath, manifestPath, registryPath } = fixture();
    const attach = run(home, [
      "sandbox",
      "cua",
      "target",
      "attach",
      "alpha",
      "--adapter",
      adapterPath,
      "--target-manifest",
      manifestPath,
      "--json",
    ]);
    expect(attach.status, attach.stderr).toBe(0);
    expect(JSON.parse(attach.stdout)).toMatchObject({
      kind: "target-attachment",
      status: "attached",
      target: { identityDigest: digest("5") },
    });

    const status = run(home, ["sandbox", "cua", "target", "status", "alpha", "--json"]);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual(JSON.parse(attach.stdout));

    const conflict = run(home, [
      "sandbox",
      "cua",
      "target",
      "attach",
      "alpha",
      "--adapter",
      adapterPath,
      "--target-manifest",
      manifestPath,
      "--json",
    ]);
    expect(conflict.status).toBe(3);
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      kind: "failure",
      family: "target_conflict",
    });

    fs.writeFileSync(
      path.join(home, ".cua-target-fixture-state.json"),
      JSON.stringify({
        reachable: true,
        browserProfile: "mutated",
        fixtureState: "changed",
      }),
    );
    const reset = run(home, [
      "sandbox",
      "cua",
      "target",
      "reset",
      "alpha",
      "--adapter",
      adapterPath,
      "--json",
    ]);
    expect(reset.status, reset.stderr).toBe(0);
    expect(JSON.parse(reset.stdout).target.identityDigest).toBe(digest("8"));
    expect(
      JSON.parse(fs.readFileSync(path.join(home, ".cua-target-fixture-state.json"), "utf8")),
    ).toEqual({
      reachable: true,
      browserProfile: "clean",
      fixtureState: "seeded",
    });

    const detach = run(home, [
      "sandbox",
      "cua",
      "target",
      "detach",
      "alpha",
      "--adapter",
      adapterPath,
      "--json",
    ]);
    expect(detach.status, detach.stderr).toBe(0);
    expect(JSON.parse(detach.stdout)).toMatchObject({ status: "detached", target: null });
    expect(
      JSON.parse(fs.readFileSync(path.join(home, ".cua-target-fixture-state.json"), "utf8")),
    ).toEqual({ reachable: false });

    const persisted = fs.readFileSync(registryPath, "utf8");
    expect(persisted).not.toContain(adapterPath);
    expect(persisted).not.toContain(manifestPath);
  });
});
