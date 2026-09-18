// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";

describe("destroySandbox cross-root registry authority", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-destroy-cross-root-"));
    vi.stubEnv("HOME", home);
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
    fs.rmSync(home, { force: true, recursive: true });
  });

  it("removes the sandbox from its sibling gateway registry", async () => {
    const registryDir = path.join(home, ".nemoclaw", "gateways", "8245");
    const registryFile = path.join(registryDir, "sandboxes.json");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      registryFile,
      JSON.stringify({
        defaultSandbox: "alpha",
        defaultSelectionRevision: 1,
        sandboxes: {
          alpha: {
            name: "alpha",
            agent: "openclaw",
            provider: "ollama-local",
            model: "nvidia/nemotron",
            gatewayName: "nemoclaw-8245",
            gatewayPort: 8245,
          },
        },
      }),
    );
    const harness = createDestroyHarness();

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: false }),
    ).resolves.toBeUndefined();

    expect(JSON.parse(fs.readFileSync(registryFile, "utf8"))).toMatchObject({
      defaultSandbox: null,
      defaultSelectionRevision: 2,
      sandboxes: {},
    });
    expect(harness.selectGatewaySpy).toHaveBeenCalledWith(
      "alpha",
      "nemoclaw-8245",
      expect.anything(),
      undefined,
    );
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });

  it("preserves the gateway when another sibling-root sandbox remains", async () => {
    const registryDir = path.join(home, ".nemoclaw", "gateways", "8245");
    const registryFile = path.join(registryDir, "sandboxes.json");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      registryFile,
      JSON.stringify({
        defaultSandbox: "alpha",
        defaultSelectionRevision: 1,
        sandboxes: {
          alpha: {
            name: "alpha",
            agent: "openclaw",
            provider: "ollama-local",
            model: "nvidia/nemotron",
            gatewayName: "nemoclaw-8245",
            gatewayPort: 8245,
          },
          beta: {
            name: "beta",
            agent: "openclaw",
            provider: "ollama-local",
            model: "nvidia/nemotron",
            gatewayName: "nemoclaw-8245",
            gatewayPort: 8245,
          },
        },
      }),
    );
    const harness = createDestroyHarness();

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
    ).resolves.toBeUndefined();

    expect(JSON.parse(fs.readFileSync(registryFile, "utf8"))).toMatchObject({
      defaultSandbox: "beta",
      sandboxes: { beta: { name: "beta" } },
    });
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });
});
