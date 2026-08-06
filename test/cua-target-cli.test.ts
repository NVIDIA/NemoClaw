// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCuaCliRuntimeFixture } from "./helpers/cua-cli-runtime";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "bin", "nemoclaw.js");
const temporaryDirectories: string[] = [];
const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;

function fixture(): {
  home: string;
  adapterPath: string;
  manifestPath: string;
  registryPath: string;
  env: NodeJS.ProcessEnv;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-target-cli-"));
  temporaryDirectories.push(home);
  const stateDirectory = path.join(home, ".nemoclaw");
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const registryPath = path.join(stateDirectory, "sandboxes.json");

  const adapterContents = `#!${process.execPath}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const detached = {
  schemaVersion: "1.0.0",
  kind: "target-attachment",
  status: "detached",
  runtimeReadinessDigest: request.current.runtimeReadinessDigest,
  target: null,
  activeTask: null,
};
if (request.operation === "target.detach" || request.operation === "target.destroy") {
  process.stdout.write(JSON.stringify(detached));
  process.exit(0);
}
const source = request.manifest ?? request.current.target;
process.stdout.write(JSON.stringify({
  schemaVersion: "1.0.0",
  kind: "target-attachment",
  status: "attached",
  runtimeReadinessDigest: request.current.runtimeReadinessDigest,
  target: {
    identityDigest: source.identityDigest,
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
`;
  const runtime = createCuaCliRuntimeFixture(ROOT, {
    targetAdapterContents: adapterContents,
  });
  temporaryDirectories.push(runtime.root);
  const manifest = {
    schemaVersion: "1.0.0",
    kind: "target-manifest",
    identityDigest: digest("5"),
    platform: runtime.targetBindings.platform,
    image: runtime.targetBindings.image,
    serviceBundle: runtime.targetBindings.serviceBundle,
    capabilities: [
      { id: "browser", protocolVersion: "1.0.0" },
      { id: "computer", protocolVersion: "1.0.0" },
      { id: "terminal", protocolVersion: "1.0.0" },
    ],
  };
  const manifestPath = path.join(home, "target-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const adapterPath = runtime.adapterPaths.target;
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: {
          name: "alpha",
          agent: "nemocua",
          ...runtime.route,
          cuaRuntimeReadiness: runtime.readiness,
        },
      },
    }),
    { mode: 0o600 },
  );
  return { home, adapterPath, manifestPath, registryPath, env: runtime.env };
}

function run(home: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env, HOME: home },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("public CUA target commands (#7751)", () => {
  it("rejects deferred reset without requiring adapter authority (#7755)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-target-reset-cli-"));
    temporaryDirectories.push(home);

    const reset = run(home, ["sandbox", "cua", "target", "reset", "alpha", "--json"], {
      NEMOCLAW_CUA_ENABLED: "1",
    });

    expect(reset.status, reset.stderr).toBe(4);
    expect(JSON.parse(reset.stdout)).toMatchObject({
      kind: "failure",
      operation: "target.reset",
      family: "lifecycle_unavailable",
    });
  });

  it("attaches, inspects, rejects reset, and detaches through one synthetic host adapter", () => {
    const { home, adapterPath, manifestPath, registryPath, env } = fixture();
    const attach = run(
      home,
      [
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
      ],
      env,
    );
    expect(attach.status, attach.stderr).toBe(0);
    expect(JSON.parse(attach.stdout)).toMatchObject({
      kind: "target-attachment",
      status: "attached",
      target: { identityDigest: digest("5") },
    });

    const status = run(home, ["sandbox", "cua", "target", "status", "alpha", "--json"], env);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual(JSON.parse(attach.stdout));

    const conflict = run(
      home,
      [
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
      ],
      env,
    );
    expect(conflict.status).toBe(3);
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      kind: "failure",
      family: "target_conflict",
    });

    const reset = run(home, ["sandbox", "cua", "target", "reset", "alpha", "--json"], env);
    expect(reset.status, reset.stderr).toBe(4);
    expect(JSON.parse(reset.stdout)).toMatchObject({
      kind: "failure",
      operation: "target.reset",
      family: "lifecycle_unavailable",
    });

    const detach = run(
      home,
      ["sandbox", "cua", "target", "detach", "alpha", "--adapter", adapterPath, "--json"],
      env,
    );
    expect(detach.status, detach.stderr).toBe(0);
    expect(JSON.parse(detach.stdout)).toMatchObject({ status: "detached", target: null });

    const persisted = fs.readFileSync(registryPath, "utf8");
    expect(persisted).not.toContain(adapterPath);
    expect(persisted).not.toContain(manifestPath);
  }, 180_000);
});
