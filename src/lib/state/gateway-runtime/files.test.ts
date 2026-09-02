// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readPrivateGatewayConfig, readPrivateGatewayRuntimeMarker } from "./files";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function makeStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-runtime-files-"));
  tempRoots.add(stateDir);
  return stateDir;
}

describe("gateway runtime state files", () => {
  it("reads private configuration and runtime marker files", () => {
    const stateDir = makeStateDir();
    const configPath = path.join(stateDir, "openshell-gateway.toml");
    const markerPath = path.join(stateDir, "runtime.json");
    fs.writeFileSync(configPath, "config", { mode: 0o600 });
    fs.writeFileSync(markerPath, "marker", { mode: 0o600 });

    expect(readPrivateGatewayConfig(stateDir)).toEqual({
      path: configPath,
      bytes: Buffer.from("config"),
    });
    expect(readPrivateGatewayRuntimeMarker(stateDir)).toEqual({
      path: markerPath,
      bytes: Buffer.from("marker"),
    });
  });

  it("rejects a gateway state file readable outside its owner", () => {
    const stateDir = makeStateDir();
    const configPath = path.join(stateDir, "openshell-gateway.toml");
    fs.writeFileSync(configPath, "config", { mode: 0o640 });
    fs.chmodSync(configPath, 0o640);

    expect(() => readPrivateGatewayConfig(stateDir)).toThrow(/file is not private/);
  });
});
