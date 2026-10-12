// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { SandboxClient, type CommandRunner } from "../fixtures/clients/index.ts";
import type { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { proveStoppedDockerAgentRecovery } from "../live/openclaw-stopped-recovery.ts";

function result(stdout = ""): ShellProbeResult {
  return {
    command: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    artifacts: { stdout: "", stderr: "", result: "" },
  };
}

describe("stopped OpenClaw recovery namespace", () => {
  it("keeps source observations and restored state in the captured gateway", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "e2e-owned-gateway");
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "");
    vi.stubEnv("E2E_TARGET_ID", "rebuild-openclaw");
    const now = vi.spyOn(Date, "now").mockReturnValue(12345);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stopped-recovery-"));
    try {
      const replies = [
        result(JSON.stringify([{ id: "native-id", name: "e2e-owned", phase: "Ready" }])),
        result(),
        result(JSON.stringify([{ id: "native-id", name: "e2e-owned", phase: "Error" }])),
        result("stopped-source-12345\nstopped-source-12345-unknown-root"),
      ];
      const run = vi.fn<CommandRunner["run"]>().mockImplementation(async (_command, options) => {
        expect(options?.env?.OPENSHELL_GATEWAY).toBe("e2e-owned-gateway");
        return replies.shift()!;
      });
      const source = "a".repeat(64);
      const replacement = "b".repeat(64);
      const command = vi
        .fn()
        .mockResolvedValueOnce(
          result(
            JSON.stringify([
              source,
              {
                "openshell.ai/managed-by": "openshell",
                "openshell.ai/sandbox-name": "e2e-owned",
                "openshell.ai/sandbox-id": "native-id",
              },
              true,
            ]),
          ),
        )
        .mockResolvedValueOnce(result());
      const runtime = {
        id: "docker",
        resolveSandboxResourceHandle: vi
          .fn()
          .mockResolvedValueOnce(source)
          .mockResolvedValueOnce(replacement),
        command,
      } as unknown as RuntimeProviderPrerequisite;
      const rebuild = vi.fn(async () => {
        vi.stubEnv("OPENSHELL_GATEWAY", "another-gateway");
      });
      await proveStoppedDockerAgentRecovery(
        new SandboxClient({ run }),
        runtime,
        new ArtifactSink(directory),
        "e2e-owned",
        rebuild,
        "native-readiness",
      );
      expect(rebuild).toHaveBeenCalledOnce();
      expect(command).toHaveBeenLastCalledWith(["kill", source], expect.any(Object));
      expect(run).toHaveBeenCalledTimes(4);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(directory, "openclaw-stopped-source-recovery.json"), "utf8"),
        ),
      ).toMatchObject({
        applicable: true,
        sourceContainerId: source,
        replacementContainerId: replacement,
        workspacePreserved: true,
        unknownNativeRootStatePreserved: true,
      });
    } finally {
      now.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
