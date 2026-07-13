// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateLegacyPortState } from "./legacy-port-migration";

const homes: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-legacy-port-state-"));
  homes.push(home);
  return home;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("legacy non-default gateway state migration", () => {
  it("partitions a selected registry and moves identity-bound session, credentials, and snapshots", () => {
    const home = makeHome();
    const shared = path.join(home, ".nemoclaw");
    const selected = path.join(shared, "gateways", "9123");
    writeJson(path.join(shared, "sandboxes.json"), {
      defaultSandbox: "default-box",
      extraProviders: ["custom-provider"],
      sandboxes: {
        "default-box": {
          name: "default-box",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          dashboardPort: 18789,
        },
        "port-box": {
          name: "port-box",
          gatewayName: "nemoclaw-9123",
          gatewayPort: 9123,
          dashboardPort: 18790,
        },
      },
    });
    writeJson(path.join(shared, "onboard-session.json"), {
      sandboxName: "port-box",
      status: "in_progress",
      metadata: { gatewayName: "nemoclaw-9123" },
    });
    writeJson(path.join(shared, "credentials.json"), { NVIDIA_API_KEY: "legacy-secret" });
    writeJson(path.join(shared, "usage-notice.json"), { acceptedVersion: "1" });
    writeJson(path.join(shared, "state", "default-forward.json"), { pid: 123 });
    writeJson(path.join(shared, "rebuild-backups", "default-box", "one", "manifest.json"), {});
    writeJson(path.join(shared, "rebuild-backups", "port-box", "two", "manifest.json"), {});

    const result = migrateLegacyPortState({ home, gatewayPort: 9123 });

    expect(result).toEqual({
      migratedSandboxNames: ["port-box"],
      migratedSession: true,
      warnings: [expect.stringContaining("Left ambiguous legacy state")],
    });
    expect(Object.keys(readJson(path.join(shared, "sandboxes.json")).sandboxes as object)).toEqual([
      "default-box",
    ]);
    expect(
      Object.keys(readJson(path.join(selected, "sandboxes.json")).sandboxes as object),
    ).toEqual(["port-box"]);
    expect(fs.existsSync(path.join(shared, "onboard-session.json"))).toBe(false);
    expect(fs.existsSync(path.join(selected, "onboard-session.json"))).toBe(true);
    expect(fs.existsSync(path.join(shared, "credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(selected, "credentials.json"))).toBe(true);
    expect(fs.existsSync(path.join(shared, "usage-notice.json"))).toBe(true);
    expect(fs.existsSync(path.join(selected, "usage-notice.json"))).toBe(false);
    expect(fs.existsSync(path.join(shared, "state", "default-forward.json"))).toBe(true);
    expect(fs.existsSync(path.join(selected, "state"))).toBe(false);
    expect(
      fs.existsSync(path.join(selected, "rebuild-backups", "port-box", "two", "manifest.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(shared, "rebuild-backups", "default-box", "one", "manifest.json")),
    ).toBe(true);

    expect(migrateLegacyPortState({ home, gatewayPort: 9123 })).toEqual({
      migratedSandboxNames: [],
      migratedSession: false,
      warnings: [],
    });
  });

  it("refuses a row whose persisted gateway name and port conflict without mutating state", () => {
    const home = makeHome();
    const shared = path.join(home, ".nemoclaw");
    writeJson(path.join(shared, "sandboxes.json"), {
      defaultSandbox: "ambiguous",
      sandboxes: {
        ambiguous: {
          name: "ambiguous",
          gatewayName: "nemoclaw-9124",
          gatewayPort: 9123,
        },
      },
    });
    const before = fs.readFileSync(path.join(shared, "sandboxes.json"), "utf8");

    expect(() => migrateLegacyPortState({ home, gatewayPort: 9123 })).toThrow(
      /conflicting gateway identity/,
    );
    expect(fs.readFileSync(path.join(shared, "sandboxes.json"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(shared, "gateways", "9123", "sandboxes.json"))).toBe(false);
  });

  it("partitions provable rows but leaves credentials whose gateway ownership is ambiguous", () => {
    const home = makeHome();
    const shared = path.join(home, ".nemoclaw");
    writeJson(path.join(shared, "sandboxes.json"), {
      defaultSandbox: "default-box",
      sandboxes: {
        "default-box": { name: "default-box" },
        "port-box": { name: "port-box", gatewayName: "nemoclaw-9123", gatewayPort: 9123 },
      },
    });
    writeJson(path.join(shared, "credentials.json"), { NVIDIA_API_KEY: "ambiguous-secret" });

    const result = migrateLegacyPortState({ home, gatewayPort: 9123 });

    expect(result.migratedSandboxNames).toEqual(["port-box"]);
    expect(result.warnings.join("\n")).toContain("Left ambiguous");
    expect(fs.existsSync(path.join(shared, "credentials.json"))).toBe(true);
    expect(fs.existsSync(path.join(shared, "gateways", "9123", "credentials.json"))).toBe(false);
  });

  it("moves singleton state when every legacy registry row belongs to the selected gateway", () => {
    const home = makeHome();
    const shared = path.join(home, ".nemoclaw");
    const selected = path.join(shared, "gateways", "9123");
    writeJson(path.join(shared, "sandboxes.json"), {
      defaultSandbox: "port-box",
      sandboxes: {
        "port-box": { name: "port-box", gatewayName: "nemoclaw-9123", gatewayPort: 9123 },
      },
    });
    writeJson(path.join(shared, "credentials.json"), { NVIDIA_API_KEY: "selected-secret" });

    const result = migrateLegacyPortState({ home, gatewayPort: 9123 });

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(path.join(shared, "credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(selected, "credentials.json"))).toBe(true);
  });

  it("does not modify the byte-compatible default gateway root", () => {
    const home = makeHome();
    const registry = path.join(home, ".nemoclaw", "sandboxes.json");
    writeJson(registry, {
      defaultSandbox: "default-box",
      sandboxes: { "default-box": { name: "default-box" } },
    });
    const before = fs.readFileSync(registry, "utf8");

    expect(migrateLegacyPortState({ home, gatewayPort: 8080 })).toEqual({
      migratedSandboxNames: [],
      migratedSession: false,
      warnings: [],
    });
    expect(fs.readFileSync(registry, "utf8")).toBe(before);
  });
});
