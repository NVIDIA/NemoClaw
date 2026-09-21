// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as crossPort from "../../state/registry/cross-port";
import * as runtime from "../../adapters/openshell/runtime";
import * as resolution from "../../adapters/openshell/resolve";
import { selectSandboxOwningGateway } from "./gateway-select";

describe("selectSandboxOwningGateway", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    [8080, "nemoclaw"],
    [8091, "nemoclaw-8091"],
  ] as const)("selects the recorded gateway on port %d", async (gatewayPort, gatewayName) => {
    vi.spyOn(crossPort, "findSandboxAcrossGatewayRoots").mockReturnValue({
      entry: { name: "alpha", gatewayPort },
      gatewayPort,
      registryFile: "/test/sandboxes.json",
    });
    const selectGateway = vi.fn().mockResolvedValue({ ok: true, state: "completed" });
    expect(await selectSandboxOwningGateway("alpha", { selectGateway })).toEqual({
      outcome: "selected",
      gatewayName,
    });
    expect(selectGateway).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName },
    });
  });
  it("preserves the CLI availability diagnostic before selection", async () => {
    vi.spyOn(crossPort, "findSandboxAcrossGatewayRoots").mockReturnValue({
      entry: { name: "alpha", gatewayPort: 8080 },
      gatewayPort: 8080,
      registryFile: "/test/sandboxes.json",
    });
    const resolveOpenshell = resolution.resolveOpenshell;
    vi.spyOn(resolution, "resolveOpenshell").mockImplementation(() =>
      resolveOpenshell({ commandVResult: null, checkExecutable: () => false }),
    );
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("missing CLI exit");
    });
    const capture = vi.spyOn(runtime, "captureResolvedOpenshell");
    await expect(selectSandboxOwningGateway("alpha")).rejects.toThrow("missing CLI exit");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(diagnostic).toHaveBeenCalledWith(
      "openshell CLI not found. Install OpenShell before using sandbox commands.",
    );
    expect(capture).not.toHaveBeenCalled();
  });
  it("does not change selection for an unregistered sandbox", async () => {
    vi.spyOn(crossPort, "findSandboxAcrossGatewayRoots").mockReturnValue(null);
    const selectGateway = vi.fn();
    expect(await selectSandboxOwningGateway("ghost", { selectGateway })).toEqual({
      outcome: "unregistered",
      gatewayName: null,
    });
    expect(selectGateway).not.toHaveBeenCalled();
  });
  it("propagates a typed selection failure without retrying", async () => {
    vi.spyOn(crossPort, "findSandboxAcrossGatewayRoots").mockReturnValue({
      entry: { name: "alpha", gatewayPort: 8091 },
      gatewayPort: 8091,
      registryFile: "/test/sandboxes.json",
    });
    const selectGateway = vi.fn().mockResolvedValue({
      ok: false,
      error: { kind: "authentication", message: "Access denied." },
      unsupported: false,
      ambiguous: false,
    });
    expect(await selectSandboxOwningGateway("beta", { selectGateway })).toEqual({
      outcome: "failed",
      gatewayName: "nemoclaw-8091",
    });
    expect(selectGateway).toHaveBeenCalledTimes(1);
  });
  it("resolves the owning gateway from a sibling gateway-port registry root", async () => {
    // Regression: with two gateways on one host, the sandbox's recorded
    // binding lives under ~/.nemoclaw/gateways/<its port>/ even when the
    // process points at another gateway port.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-select-cross-"));
    try {
      vi.stubEnv("HOME", home);
      const siblingDir = path.join(home, ".nemoclaw", "gateways", "8245");
      fs.mkdirSync(siblingDir, { recursive: true });
      fs.writeFileSync(
        path.join(siblingDir, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: null,
          defaultSelectionRevision: 1,
          sandboxes: { "owner-a": { name: "owner-a", gatewayPort: 8245 } },
        }),
      );
      const selectGateway = vi.fn().mockResolvedValue({ ok: true, state: "completed" });

      expect(await selectSandboxOwningGateway("owner-a", { selectGateway })).toEqual({
        outcome: "selected",
        gatewayName: "nemoclaw-8245",
      });
      expect(selectGateway).toHaveBeenCalledWith({
        target: { kind: "named", gatewayName: "nemoclaw-8245" },
      });
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
