// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSession } from "../state/onboard-session";
import { hasPortableUninstallAuthority } from "./portable-retirement-authority";

const homes: string[] = [];

function completedOrdinaryOnboard(driver: string) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ordinary-runtime-retirement-"));
  homes.push(homeDir);
  const stateDir = path.join(homeDir, ".nemoclaw");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const boundary = {
    homeDir,
    stateDir,
    registryFile: path.join(stateDir, "sandboxes.json"),
    sessionFile: path.join(stateDir, "onboard-session.json"),
  };
  const sandboxName = "ordinary";
  const sessionId = "ordinary-runtime";
  const gateway = {
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    mode: "nemoclaw-managed" as const,
    source: "standalone" as const,
    endpoint: null,
    stateDir: null,
    supervisor: null,
    requiredCapabilities: [],
  };
  const session = createSession({ agent: null, sandboxName, sessionId });
  session.status = "complete";
  session.resumable = false;
  session.machine = {
    version: 1,
    state: "complete",
    stateEnteredAt: "2026-10-28T00:00:00.000Z",
    revision: 1,
  };
  session.checkpoint = {
    schemaVersion: 4,
    sessionId,
    machineState: "complete",
    updatedAt: "2026-10-28T00:00:00.000Z",
    profile: { kind: "selected", value: "default" },
    runtimeAuthority: { kind: "unset" },
    sandboxIdentity: { kind: "selected", value: { name: sandboxName, agent: "openclaw" } },
    webSearch: { kind: "unset" },
    messaging: { kind: "unset" },
    resourceProfile: { kind: "unset" },
    gatewayAuthority: { kind: "selected", value: gateway },
    effectGroups: {},
    bindings: { credentialEnvs: [], registeredProviders: [] },
    sandboxRecreate: null,
  };
  const registry = {
    defaultSandbox: sandboxName,
    sandboxes: {
      [sandboxName]: {
        name: sandboxName,
        agent: null,
        openshellDriver: driver,
        gatewayName: gateway.gatewayName,
        gatewayPort: gateway.gatewayPort,
      },
    },
  };
  fs.writeFileSync(boundary.sessionFile, JSON.stringify(session), { mode: 0o600 });
  fs.writeFileSync(boundary.registryFile, JSON.stringify(registry), { mode: 0o600 });
  return { boundary, registry, deps: { loadRegistry: () => registry } };
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("ordinary runtime uninstall authority", () => {
  it.each(["docker", "podman"])("admits completed %s without Portable cleanup", (driver) => {
    const fixture = completedOrdinaryOnboard(driver);
    expect(hasPortableUninstallAuthority(fixture.boundary, fixture.deps)).toBe(false);
  });

  it.each(["mxc", "unknown", ""])("refuses unsupported ordinary driver %j", (driver) => {
    const fixture = completedOrdinaryOnboard(driver);
    expect(() => hasPortableUninstallAuthority(fixture.boundary, fixture.deps)).toThrow(
      "Completed ordinary onboarding registry authority is incomplete",
    );
  });

  it("refuses a normalized runtime that differs from the recorded Podman runtime", () => {
    const fixture = completedOrdinaryOnboard("podman");
    fixture.registry.sandboxes.ordinary!.openshellDriver = "docker";
    expect(() => hasPortableUninstallAuthority(fixture.boundary, fixture.deps)).toThrow(
      "Completed ordinary onboarding registry authority is incomplete",
    );
  });
});
