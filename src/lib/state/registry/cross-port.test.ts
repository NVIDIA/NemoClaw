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

  it("rejects an ambiguous name present in multiple registry roots", async () => {
    writeRegistry("", { dup: { name: "dup", gatewayPort: 8090 } });
    writeRegistry(path.join("gateways", "8245"), { dup: { name: "dup", gatewayPort: 8245 } });
    const { findSandboxAcrossGatewayRoots } = await loadModule();

    expect(() => findSandboxAcrossGatewayRoots("dup")).toThrow(
      'Cannot safely inspect NemoClaw gateway state: sandbox "dup" appears in multiple gateway registries',
    );
  });

  it("ignores non-port directories but rejects a malformed sibling registry", async () => {
    writeRegistry("", { "owner-b": { name: "owner-b", gatewayPort: 8090 } });
    const gatewaysDir = path.join(home, ".nemoclaw", "gateways");
    fs.mkdirSync(gatewaysDir, { recursive: true });
    fs.mkdirSync(path.join(gatewaysDir, "not-a-port"));
    fs.mkdirSync(path.join(gatewaysDir, "8245"));
    fs.writeFileSync(path.join(gatewaysDir, "8245", "sandboxes.json"), "{not json");
    const { findSandboxAcrossGatewayRoots } = await loadModule();

    expect(() => findSandboxAcrossGatewayRoots("owner-b")).toThrow(
      "Cannot safely inspect NemoClaw gateway state:",
    );
  });

  it("rejects a symbolic-link gateway root", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cross-port-outside-"));
    writeRegistry("", { "owner-b": { name: "owner-b", gatewayPort: 8090 } });
    const gatewaysDir = path.join(home, ".nemoclaw", "gateways");
    fs.mkdirSync(gatewaysDir, { recursive: true });
    fs.symlinkSync(outside, path.join(gatewaysDir, "8245"));
    const { findSandboxAcrossGatewayRoots } = await loadModule();

    try {
      expect(() => findSandboxAcrossGatewayRoots("owner-b")).toThrow(
        "Cannot safely inspect NemoClaw gateway state:",
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("owning registry mutations", () => {
  it("removes a sibling-root sandbox and advances its default-pointer revision", async () => {
    const registryFile = writeRegistry(path.join("gateways", "8245"), {
      "owner-a": { name: "owner-a", gatewayPort: 8245 },
      "owner-b": { name: "owner-b", gatewayPort: 8245 },
    });
    fs.writeFileSync(
      registryFile,
      JSON.stringify({
        defaultSandbox: "owner-a",
        defaultSelectionRevision: 4,
        sandboxes: {
          "owner-a": { name: "owner-a", gatewayPort: 8245 },
          "owner-b": { name: "owner-b", gatewayPort: 8245 },
        },
      }),
    );
    const { removeSandboxAcrossGatewayRoots } = await loadModule();

    expect(removeSandboxAcrossGatewayRoots("owner-a")).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    expect(persisted).toMatchObject({
      defaultSandbox: "owner-b",
      defaultSelectionRevision: 5,
      sandboxes: { "owner-b": { name: "owner-b", gatewayPort: 8245 } },
    });
    expect(persisted.sandboxes).not.toHaveProperty("owner-a");
  });

  it("rejects an invalid default-pointer revision before mutating a sibling registry", async () => {
    const registryFile = writeRegistry(path.join("gateways", "8245"), {
      "owner-a": { name: "owner-a", gatewayPort: 8245 },
    });
    fs.writeFileSync(
      registryFile,
      JSON.stringify({
        defaultSandbox: "owner-a",
        defaultSelectionRevision: -1,
        sandboxes: { "owner-a": { name: "owner-a", gatewayPort: 8245 } },
      }),
    );
    const { removeSandboxAcrossGatewayRoots } = await loadModule();

    expect(() => removeSandboxAcrossGatewayRoots("owner-a")).toThrow(
      "invalid defaultSelectionRevision",
    );
    expect(JSON.parse(fs.readFileSync(registryFile, "utf8")).sandboxes).toHaveProperty("owner-a");
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
      listPublishedSandboxesAcrossGatewayRoots,
      listPendingSandboxNamesAcrossGatewayRoots,
    } = await loadModule();

    expect(listPublishedSandboxNamesAcrossGatewayRoots()).toEqual(["owner-b", "owner-a"]);
    expect(
      listPublishedSandboxesAcrossGatewayRoots().map(({ name, gatewayPort }) => ({
        name,
        gatewayPort,
      })),
    ).toEqual([
      { name: "owner-b", gatewayPort: 8080 },
      { name: "owner-a", gatewayPort: 8245 },
      { name: "owner-b", gatewayPort: 8245 },
    ]);
    expect(listPendingSandboxNamesAcrossGatewayRoots()).toEqual(["reserved", "pending"]);
  });

  it("returns empty lists when no registry roots exist", async () => {
    const {
      listPublishedSandboxNamesAcrossGatewayRoots,
      listPublishedSandboxesAcrossGatewayRoots,
      listPendingSandboxNamesAcrossGatewayRoots,
    } = await loadModule();

    expect(listPublishedSandboxNamesAcrossGatewayRoots()).toEqual([]);
    expect(listPublishedSandboxesAcrossGatewayRoots()).toEqual([]);
    expect(listPendingSandboxNamesAcrossGatewayRoots()).toEqual([]);
  });
});
