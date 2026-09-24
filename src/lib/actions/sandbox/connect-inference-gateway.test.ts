// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GatewayRouteConflictError } from "../../inference/gateway-route-compatibility";
import { resolveGatewayName } from "../../onboard/gateway-binding";
import type { SandboxEntry } from "../../state/registry";
import { assertSandboxGatewayRouteCompatible } from "./connect-inference-gateway";

let home: string;

function writeRegistry(relDir: string, sandboxes: Record<string, SandboxEntry>): void {
  const dir = path.join(home, ".nemoclaw", relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sandboxes.json"),
    JSON.stringify({ defaultSandbox: null, defaultSelectionRevision: 1, sandboxes }),
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-connect-route-cross-root-"));
  vi.stubEnv("HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("assertSandboxGatewayRouteCompatible", () => {
  it("rejects a conflicting same-gateway route recorded in another registry root", () => {
    const target: SandboxEntry = {
      name: "target",
      agent: "openclaw",
      gatewayPort: 8245,
      provider: "compatible-endpoint",
      model: "shared-model",
      endpointUrl: "https://target.example/v1",
      preferredInferenceApi: "openai-completions",
      credentialEnv: "COMPATIBLE_API_KEY",
    };
    const peer: SandboxEntry = {
      name: "peer",
      agent: "openclaw",
      gatewayPort: 8245,
      provider: "compatible-endpoint",
      model: "shared-model",
      endpointUrl: "https://peer.example/v1",
      preferredInferenceApi: "openai-completions",
      credentialEnv: "COMPATIBLE_API_KEY",
    };
    writeRegistry("", { peer });
    writeRegistry(path.join("gateways", "8245"), { target });

    expect(() =>
      assertSandboxGatewayRouteCompatible("target", target, resolveGatewayName(8245)),
    ).toThrow(GatewayRouteConflictError);
  });
});
