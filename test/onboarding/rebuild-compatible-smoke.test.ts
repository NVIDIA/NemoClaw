// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const requireSource = createRequire(import.meta.url);
const openshellCli = requireSource("../../src/lib/onboard/openshell-cli.js");
const commandCli = requireSource("../../src/lib/adapters/openshell/sandbox-command-cli.js");
const { rebuildOnboardDependencies } = requireSource(
  "../../src/lib/actions/sandbox/rebuild-onboard-dependencies.js",
);

describe("rebuilt OpenClaw compatible smoke wiring", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([undefined, "captured-gateway"])(
    "preserves the runtime and deadline for gateway %s",
    async (gatewayName) => {
      const run = vi.fn().mockReturnValue({
        status: 0,
        stdout:
          "Id: provider-compatible-endpoint\nName: compatible-endpoint\nType: openai\nResource version: 1\nCredential keys: COMPATIBLE_API_KEY\nConfig keys: OPENAI_BASE_URL",
      });
      const createHelpers = openshellCli.createOpenshellCliHelpers;
      vi.spyOn(openshellCli, "createOpenshellCliHelpers").mockImplementation((deps: unknown) => ({
        ...createHelpers(deps),
        runOpenshell: run,
      }));
      const runBuffered = vi.fn().mockResolvedValue({
        outcome: { kind: "completed", exitCode: 0 },
        stdout: "OPENCLAW_CONFIG_OK\nINFERENCE_SMOKE_OK PONG",
        stderr: "",
      });
      vi.spyOn(commandCli, "createCliOpenShellSandboxCommandExecutor").mockReturnValue({
        runBuffered,
      });
      delete requireSource.cache[requireSource.resolve("../../src/lib/onboard.js")];
      const environment = {
        OPENSHELL_GATEWAY: gatewayName,
        OPENSHELL_WORKSPACE: "/tmp/captured-workspace",
      };
      await rebuildOnboardDependencies.verifyRebuiltOpenClawCompatibleEndpoint({
        sandboxName: "alpha",
        provider: "compatible-endpoint",
        model: "baseline",
        environment,
        gatewayName,
      });
      expect(run).toHaveBeenCalledExactlyOnceWith(
        ["provider", "get", "compatible-endpoint"],
        expect.objectContaining({ env: environment }),
      );
      expect(runBuffered).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sandboxName: "alpha",
          target: gatewayName ? { kind: "named", gatewayName } : { kind: "selected" },
          timeoutMilliseconds: 225000,
          environment,
        }),
      );
      const failure = new Error("restored inference proof failed");
      runBuffered.mockRejectedValue(failure);
      await expect(
        rebuildOnboardDependencies.verifyRebuiltOpenClawCompatibleEndpoint({
          sandboxName: "alpha",
          provider: "compatible-endpoint",
          model: "baseline",
          environment,
          gatewayName,
        }),
      ).rejects.toBe(failure);
    },
  );
});
