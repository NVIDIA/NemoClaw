// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  CUA_CAPABILITIES,
  CUA_LIFECYCLE_SCHEMA_VERSION,
  CUA_REQUIRED_TASK_OPERATIONS,
  CUA_TARGET_OPERATIONS,
  type CuaRuntimeReadiness,
  type CuaTargetAttachment,
} from "../cua/contract";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-registry-cua-"));
process.env.HOME = testHome;
const registry = await import("./registry");

const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
const component = (name: string, value: string) => ({
  name,
  version: "1.0.0",
  digest: digest(value),
  owner: "fixture",
});

const readiness: CuaRuntimeReadiness = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
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
  requiredCapabilities: CUA_CAPABILITIES,
  targetOperations: CUA_TARGET_OPERATIONS,
  taskOperations: CUA_REQUIRED_TASK_OPERATIONS,
};

const attachment: CuaTargetAttachment = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "target-attachment",
  status: "attached",
  target: {
    identityDigest: digest("5"),
    platform: "fixture-linux-amd64",
    image: component("desktop-fixture", "6"),
    serviceBundle: component("service-fixture", "7"),
    capabilities: CUA_CAPABILITIES.map((id) => ({
      id,
      protocolVersion: "1.0.0",
      health: "healthy" as const,
    })),
  },
  activeTask: null,
};

beforeEach(() => {
  registry.clearAll();
});

afterAll(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("CUA canonical registry state (#7751)", () => {
  it("round-trips only versioned runtime and target projections", () => {
    registry.registerSandbox({
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
    });

    expect(registry.getSandbox("alpha")).toMatchObject({
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
    });
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    expect(JSON.stringify(disk.sandboxes.alpha.cuaTarget)).not.toMatch(
      /credential|password|secret|token|endpoint|hostName|ssh|vnc/i,
    );
  });

  it("fails closed when persisted target health does not match the schema", () => {
    registry.registerSandbox({
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
    });
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    disk.sandboxes.alpha.cuaTarget.target.capabilities[0].health = "unchecked";
    fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify(disk));

    expect(() => registry.load()).toThrow("CUA lifecycle record does not match its schema");
  });
});
