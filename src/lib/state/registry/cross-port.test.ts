// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;

function writeRegistry(relDir: string, sandboxes: Record<string, unknown>): string {
  const dir = path.join(home, ".nemoclaw", relDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "sandboxes.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ defaultSandbox: null, defaultSelectionRevision: 1, sandboxes }),
  );
  return file;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cross-port-"));
  vi.stubEnv("HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

async function loadModule() {
  return import("./cross-port");
}

describe("findSandboxAcrossGatewayRoots", () => {
  it("returns null for a name present in no registry root", async () => {
    writeRegistry("", { "owner-b": { name: "owner-b", gatewayPort: 8090 } });
    const { findSandboxAcrossGatewayRoots } = await loadModule();
    expect(findSandboxAcrossGatewayRoots("ghost")).toBeNull();
  });

  it("finds a sandbox registered only in a sibling gateway-port root and stamps the directory port", async () => {
    writeRegistry("", { "owner-b": { name: "owner-b", gatewayPort: 8090 } });
    writeRegistry(path.join("gateways", "8245"), {
      "owner-a": { name: "owner-a", gatewayPort: 8245, agent: "openclaw" },
    });
    const { findSandboxAcrossGatewayRoots } = await loadModule();

    const hit = findSandboxAcrossGatewayRoots("owner-a");

    expect(hit?.entry.name).toBe("owner-a");
    expect(hit?.gatewayPort).toBe(8245);
    expect(hit?.entry.gatewayPort).toBe(8245);
  });

  it("derives the binding from the directory port for legacy entries without a persisted port", async () => {
    writeRegistry(path.join("gateways", "8456"), { legacy: { name: "legacy" } });
    const { findSandboxAcrossGatewayRoots } = await loadModule();

    const hit = findSandboxAcrossGatewayRoots("legacy");

    expect(hit?.gatewayPort).toBe(8456);
    expect(hit?.entry.gatewayPort).toBe(8456);
  });

  it("prefers the base root for an entry present in both roots", async () => {
    writeRegistry("", { dup: { name: "dup", gatewayPort: 8090 } });
    writeRegistry(path.join("gateways", "8245"), { dup: { name: "dup", gatewayPort: 8245 } });
    const { findSandboxAcrossGatewayRoots } = await loadModule();

    expect(findSandboxAcrossGatewayRoots("dup")?.gatewayPort).toBe(8090);
  });

  it("tolerates unreadable sibling roots and non-port directories", async () => {
    writeRegistry("", { "owner-b": { name: "owner-b", gatewayPort: 8090 } });
    const gatewaysDir = path.join(home, ".nemoclaw", "gateways");
    fs.mkdirSync(gatewaysDir, { recursive: true });
    fs.mkdirSync(path.join(gatewaysDir, "not-a-port"));
    fs.mkdirSync(path.join(gatewaysDir, "8245"));
    fs.writeFileSync(path.join(gatewaysDir, "8245", "sandboxes.json"), "{not json");
    const { findSandboxAcrossGatewayRoots } = await loadModule();

    expect(findSandboxAcrossGatewayRoots("owner-b")?.gatewayPort).toBe(8090);
    expect(findSandboxAcrossGatewayRoots("owner-a")).toBeNull();
  });
});

describe("listSandboxNamesAcrossGatewayRoots", () => {
  it("aggregates published names across roots, keeping order stable and deduplicated", async () => {
    writeRegistry("", {
      "owner-b": { name: "owner-b", gatewayPort: 8080 },
      reserved: { name: "reserved", pendingRouteReservation: true, createdAt: "2026-09-09" },
    });
    writeRegistry(path.join("gateways", "8245"), {
      "owner-a": { name: "owner-a", gatewayPort: 8245 },
      "owner-b": { name: "owner-b", gatewayPort: 8245 },
      pending: { name: "pending", pendingRouteReservation: true, createdAt: "2026-09-09" },
    });
    const {
      listPublishedSandboxNamesAcrossGatewayRoots,
      listPendingSandboxNamesAcrossGatewayRoots,
    } = await loadModule();

    expect(listPublishedSandboxNamesAcrossGatewayRoots()).toEqual(["owner-b", "owner-a"]);
    expect(listPendingSandboxNamesAcrossGatewayRoots()).toEqual(["reserved", "pending"]);
  });

  it("returns empty lists when no registry roots exist", async () => {
    const {
      listPublishedSandboxNamesAcrossGatewayRoots,
      listPendingSandboxNamesAcrossGatewayRoots,
    } = await loadModule();

    expect(listPublishedSandboxNamesAcrossGatewayRoots()).toEqual([]);
    expect(listPendingSandboxNamesAcrossGatewayRoots()).toEqual([]);
  });
});
