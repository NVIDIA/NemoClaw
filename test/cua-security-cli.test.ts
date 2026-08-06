// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CuaRuntimeReadiness, getCuaRuntimeReadinessDigest } from "../src/lib/cua/contract";
import { createCuaCliRuntimeFixture } from "./helpers/cua-cli-runtime";

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
  env: NodeJS.ProcessEnv;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-security-cli-"));
  temporaryDirectories.push(home);
  const stateDirectory = path.join(home, ".nemoclaw");
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const registryPath = path.join(stateDirectory, "sandboxes.json");
  const buildTarget = (runtime: CuaRuntimeReadiness) => ({
    schemaVersion: "1.0.0",
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
  });
  const adapterContents = `#!${process.execPath}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const target = request.target.target;
const attestation = {
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
    retention: "until-target-detach-or-destroy",
    cleanupOperations: ["target.detach", "target.destroy"],
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
  verifier: request.runtime.components.securityVerifier,
  ${unsafe ? 'endpoint: "https://host.invalid",' : ""}
};
process.stdout.write(JSON.stringify(attestation));
`;
  const runtimeFixture = createCuaCliRuntimeFixture(ROOT, {
    securityAdapterContents: adapterContents,
  });
  temporaryDirectories.push(runtimeFixture.root);
  const runtime = runtimeFixture.readiness;
  const target = buildTarget(runtime);
  const adapterPath = runtimeFixture.adapterPaths.security;
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: {
          name: "alpha",
          agent: "nemocua",
          ...runtimeFixture.route,
          cuaRuntimeReadiness: runtime,
          cuaTarget: target,
        },
      },
    }),
    { mode: 0o600 },
  );
  return { home, adapterPath, registryPath, env: runtimeFixture.env };
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

describe("public CUA security commands (#7754)", () => {
  it("verifies, persists, and reconnects through a content-free attestation", () => {
    const { home, adapterPath, registryPath, env } = fixture();
    const verified = run(
      home,
      ["sandbox", "cua", "security", "verify", "alpha", "--adapter", adapterPath, "--json"],
      env,
    );

    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      kind: "security-attestation",
      status: "enforced",
      network: { defaultAction: "deny", managedInference: "only" },
      isolation: { privileged: false, hostDockerSocket: false, hostDesktop: false },
      artifacts: { classification: "private", backup: "excluded" },
      authority: { externalSideEffects: "denied", mayExpand: false },
    });

    const status = run(home, ["sandbox", "cua", "security", "status", "alpha", "--json"], env);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual(JSON.parse(verified.stdout));

    const persisted = fs.readFileSync(registryPath, "utf8");
    expect(persisted).not.toMatch(
      /host\.invalid|"(endpoint|hostname|cookie|password|token|credential|ssh|vnc)"\s*:/i,
    );
  });

  it("fails closed when verifier output tries to introduce an endpoint", () => {
    const { home, adapterPath, env } = fixture(true);
    const verified = run(
      home,
      ["sandbox", "cua", "security", "verify", "alpha", "--adapter", adapterPath, "--json"],
      env,
    );

    expect(verified.status).toBe(5);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      kind: "failure",
      family: "policy_invalid",
      component: "policy",
    });
  });

  it("rejects an unregistered executable before it can persist an attestation", () => {
    const { home, adapterPath, registryPath, env } = fixture();
    const unregisteredPath = path.join(home, "unregistered-security-adapter.mjs");
    fs.writeFileSync(
      unregisteredPath,
      `${fs.readFileSync(adapterPath, "utf8")}\n// unregistered\n`,
      {
        mode: 0o700,
      },
    );

    const verified = run(
      home,
      ["sandbox", "cua", "security", "verify", "alpha", "--adapter", unregisteredPath, "--json"],
      env,
    );

    expect(verified.status).toBe(2);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      kind: "failure",
      family: "validation_failed",
      component: "runtime",
    });
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    expect(registry.sandboxes.alpha.cuaSecurityAttestation).toBeUndefined();
  });
});
