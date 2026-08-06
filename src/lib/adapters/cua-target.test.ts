// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CUA_LIFECYCLE_SCHEMA_VERSION, type CuaTargetAttachment } from "../cua/contract";
import type { CuaTargetManifest } from "../cua/schema";
import { detachedCuaTarget } from "../cua/target-lifecycle";
import {
  CuaTargetAdapterInvocationError,
  type CuaTargetAdapterRequest,
  ProcessCuaTargetAdapter,
} from "./cua-target";

const temporaryDirectories: string[] = [];
const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;

const manifest: CuaTargetManifest = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "target-manifest",
  identityDigest: digest("1"),
  platform: "fixture-linux-amd64",
  image: { name: "fixture-image", version: "1.0.0", digest: digest("2"), owner: "fixture" },
  serviceBundle: {
    name: "fixture-services",
    version: "1.0.0",
    digest: digest("3"),
    owner: "fixture",
  },
  capabilities: [
    { id: "browser", protocolVersion: "1.0.0" },
    { id: "computer", protocolVersion: "1.0.0" },
    { id: "terminal", protocolVersion: "1.0.0" },
  ],
};

function request(): CuaTargetAdapterRequest {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "target-adapter-request",
    operation: "target.attach",
    sandboxName: "alpha",
    manifest,
    current: detachedCuaTarget(digest("9")),
  };
}

function executable(source: string, shebang = `#!${process.execPath}`): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-target-adapter-"));
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

describe("process CUA target adapter (#7751)", () => {
  it("sends the bounded request on stdin and accepts one lifecycle record", () => {
    const adapterPath = executable(`
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const manifest = request.manifest;
process.stdout.write(JSON.stringify({
  schemaVersion: request.schemaVersion,
  kind: "target-attachment",
  status: "attached",
  runtimeReadinessDigest: request.current.runtimeReadinessDigest,
  target: {
    identityDigest: manifest.identityDigest,
    platform: manifest.platform,
    image: manifest.image,
    serviceBundle: manifest.serviceBundle,
    capabilities: manifest.capabilities.map((capability) => ({ ...capability, health: "healthy" })),
  },
  activeTask: null,
}));
`);
    const adapter = new ProcessCuaTargetAdapter(adapterPath);

    const record = adapter.execute(request()) as CuaTargetAttachment;

    expect(record.kind).toBe("target-attachment");
    expect(record.target?.capabilities.map((capability) => capability.id).sort()).toEqual([
      "browser",
      "computer",
      "terminal",
    ]);
    expect(adapter.executableDigest).toBe(executableDigest(adapterPath));
  });

  it("invokes the digest-checked snapshot only through the qualification runner", () => {
    const adapterPath = executable(`
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
process.stdout.write(JSON.stringify({
  schemaVersion: request.schemaVersion,
  kind: "failure",
  operation: request.operation,
  family: "target_unreachable",
  retryable: true
}));
`);
    const markerPath = path.join(path.dirname(adapterPath), "runner-invocation");
    const runnerPath = executable(`
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const executable = process.argv[2];
if (executable !== "--require-target-channel") process.exit(124);
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
    const adapter = new ProcessCuaTargetAdapter(adapterPath, {
      qualificationArtifactRunner: runnerPath,
    });

    expect(adapter.execute(request()).kind).toBe("failure");
    const invokedPath = fs.readFileSync(markerPath, "utf8");
    expect(invokedPath).not.toBe(adapterPath);
    expect(invokedPath).toContain("nemoclaw-cua-target-adapter-");
    expect(fs.existsSync(invokedPath)).toBe(false);
  });

  it("does not copy target-private stderr into a validation error", () => {
    const adapterPath = executable(`
process.stderr.write("private-adapter-diagnostic");
process.stdout.write("not-json");
`);
    const adapter = new ProcessCuaTargetAdapter(adapterPath);

    expect(() => adapter.execute(request())).toThrowError(CuaTargetAdapterInvocationError);
    try {
      adapter.execute(request());
    } catch (error) {
      expect(String(error)).not.toContain("private-adapter-diagnostic");
    }
  });

  it("rejects a relative executable before starting a process", () => {
    const adapter = new ProcessCuaTargetAdapter("adapter");
    expect(() => adapter.execute(request())).toThrow("path must be absolute");
  });

  it("does not forward unrelated host credential variables to the adapter", () => {
    vi.stubEnv("CUA_TEST_AUTHORITY", "private-value");
    vi.stubEnv("HOME", "/host-private-home");
    vi.stubEnv("PATH", "/host-private-bin");
    const adapterPath = executable(`
if (
  process.env.CUA_TEST_AUTHORITY ||
  process.env.HOME === "/host-private-home" ||
  !process.env.HOME?.includes("nemoclaw-cua-target-adapter-") ||
  process.env.PATH !== "/usr/bin:/bin" ||
  process.env.TMPDIR === process.env.HOME
) {
  process.stdout.write("environment-leaked");
  process.exit(0);
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const manifest = request.manifest;
process.stdout.write(JSON.stringify({
  schemaVersion: request.schemaVersion,
  kind: "target-attachment",
  status: "attached",
  runtimeReadinessDigest: request.current.runtimeReadinessDigest,
  target: {
    identityDigest: manifest.identityDigest,
    platform: manifest.platform,
    image: manifest.image,
    serviceBundle: manifest.serviceBundle,
    capabilities: manifest.capabilities.map((capability) => ({ ...capability, health: "healthy" })),
  },
  activeTask: null,
}));
`);

    expect(new ProcessCuaTargetAdapter(adapterPath).execute(request()).kind).toBe(
      "target-attachment",
    );
  });

  it("rejects a symlink without starting its target", () => {
    const adapterPath = executable(`
process.stdout.write("not-reached");
`);
    const symlinkPath = path.join(path.dirname(adapterPath), "adapter-link.mjs");
    fs.symlinkSync(adapterPath, symlinkPath);

    expect(() => new ProcessCuaTargetAdapter(symlinkPath).execute(request())).toThrow(
      "unavailable",
    );
  });

  it("rejects a replaced adapter when an immutable digest is required", () => {
    const adapterPath = executable(`
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
process.stdout.write(JSON.stringify({
  schemaVersion: request.schemaVersion,
  kind: "failure",
  operation: request.operation,
  family: "target_unreachable",
  retryable: true
}));
`);
    const markerPath = path.join(path.dirname(adapterPath), "replacement-ran");
    const adapter = new ProcessCuaTargetAdapter(adapterPath, {
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
