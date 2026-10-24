// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";
import { proveStoppedDockerAgentRecovery } from "../live/openclaw-stopped-recovery.ts";

const NAME = "e2e-recovery";
const ID = "source-id";
const CONTAINER = "a".repeat(64);
const ROW = {
  id: ID,
  name: NAME,
  labels: {},
  resource_version: 1,
  created_at: "2026-10-19T00:00:00Z",
  phase: "Ready",
  current_policy_version: 1,
};
const page = (rows = [ROW], token = "") =>
  JSON.stringify({ sandboxes: rows, next_page_token: token });
const result = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });

function fixture(
  initial = page(),
  terminal = page([{ ...ROW, phase: "Error" }]),
  agent: "openclaw" | "langchain-deepagents-code" = "openclaw",
) {
  const openshell = vi
    .fn()
    .mockResolvedValueOnce(result(initial))
    .mockResolvedValue(result(terminal));
  const exec = vi
    .fn()
    .mockResolvedValueOnce(result())
    .mockResolvedValue(result("stopped-source-1000\nstopped-source-1000-unknown-root"));
  const command = vi
    .fn()
    .mockResolvedValueOnce(
      result(
        JSON.stringify([
          CONTAINER,
          {
            "openshell.ai/managed-by": "openshell",
            "openshell.ai/sandbox-name": NAME,
            "openshell.ai/sandbox-id": ID,
          },
          true,
        ]),
      ),
    )
    .mockResolvedValue(result());
  const runtime = {
    id: "docker",
    command,
    resolveSandboxResourceHandle: vi
      .fn()
      .mockResolvedValueOnce(CONTAINER)
      .mockResolvedValue("b".repeat(64)),
  };
  const rebuild = vi.fn().mockResolvedValue(undefined);
  const writeJson = vi.fn();
  return {
    exec,
    command,
    rebuild,
    writeJson,
    openshell,
    run: () =>
      proveStoppedDockerAgentRecovery(
        { openshell, exec } as unknown as SandboxClient,
        runtime as unknown as RuntimeProviderPrerequisite,
        { writeJson } as unknown as ArtifactSink,
        NAME,
        rebuild,
        "native-readiness",
        agent,
      ),
  };
}

describe("stopped Docker recovery inventory", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "");
    vi.stubEnv("E2E_TARGET_ID", "rebuild-openclaw");
    vi.spyOn(Date, "now").mockReturnValue(1000);
  });

  it.each([
    ["0.1.3 page", page()],
    ["legacy array", JSON.stringify([ROW])],
  ])("recovers the identified source from a complete %s", async (_name, inventory) => {
    const f = fixture(inventory);
    await f.run();
    expect(f.command.mock.calls.map(([args]) => args[0])).toEqual(["inspect", "kill"]);
    expect(f.rebuild).toHaveBeenCalledOnce();
    expect(f.writeJson).toHaveBeenCalledWith(
      "openclaw-stopped-source-recovery.json",
      expect.objectContaining({
        sourceContainerId: CONTAINER,
        replacementContainerId: "b".repeat(64),
        sourcePhase: "Error",
        workspacePreserved: true,
        unknownNativeRootStatePreserved: true,
      }),
    );
  });

  it.each([
    ["partial page", page([ROW], "next")],
    ["missing page token", JSON.stringify({ sandboxes: [ROW] })],
    ["invalid JSON", "{"],
    ["missing sandbox", page([])],
    ["ambiguous identity", page([ROW, ROW])],
    ["invalid ID", page([{ ...ROW, id: "unsafe/id" }])],
    ["not ready", page([{ ...ROW, phase: "Error" }])],
  ])("rejects %s before container inspection or mutation", async (_name, inventory) => {
    const f = fixture(inventory);
    await expect(f.run()).rejects.toThrow();
    expect(f.command).not.toHaveBeenCalled();
    expect(f.rebuild).not.toHaveBeenCalled();
  });

  it("rejects a changed source ID before rebuild", async () => {
    const f = fixture(page(), page([{ ...ROW, id: "replacement-id", phase: "Error" }]));
    await expect(f.run()).rejects.toThrow("The source identity changed");
    expect(f.rebuild).not.toHaveBeenCalled();
  });

  it("prepares Deep Agents recovery state as its owner without chown", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "recovery-gateway");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stopped-dcode-"));
    const home = path.join(directory, "sandbox");
    const bin = path.join(directory, "bin");
    try {
      fs.mkdirSync(path.join(home, ".deepagents", ".state"), { recursive: true, mode: 0o700 });
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(home, ".bash_profile"), "existing user profile");
      fs.writeFileSync(path.join(bin, "chown"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
      fs.writeFileSync(path.join(bin, "sync"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const f = fixture(undefined, undefined, "langchain-deepagents-code");
      f.exec.mockReset().mockImplementation(async (_name, args) => {
        const prepared = spawnSync(args[0], [args[1], args[2].replaceAll("/sandbox", home)], {
          env: { PATH: `${bin}:/usr/bin:/bin` },
          encoding: "utf8",
        });
        return { exitCode: prepared.status, stdout: prepared.stdout, stderr: prepared.stderr };
      });
      await f.run();
      const marker = path.join(home, ".deepagents", ".state", ".stopped-recovery-marker");
      expect(fs.readFileSync(marker, "utf8")).toBe("stopped-source-1000");
      expect(fs.statSync(marker).uid).toBe(process.getuid!());
      expect(
        fs.readFileSync(path.join(home, ".stopped-recovery-unknown-root-marker"), "utf8"),
      ).toBe("stopped-source-1000-unknown-root");
      expect(fs.readlinkSync(path.join(home, ".bash_profile"))).toBe(
        path.join(home, "hostile-env.sh"),
      );
      expect(f.command.mock.calls.map(([args]) => args[0])).toEqual(["inspect", "kill"]);
      expect(f.exec).toHaveBeenNthCalledWith(
        1,
        NAME,
        expect.any(Array),
        expect.objectContaining({
          timeoutMs: 10_000,
          env: expect.objectContaining({ OPENSHELL_GATEWAY: "recovery-gateway" }),
        }),
      );
      expect(f.rebuild).toHaveBeenCalledOnce();
      expect(f.writeJson).toHaveBeenCalledWith(
        "deepagents-stopped-source-recovery.json",
        expect.objectContaining({
          sourceProfile: "broken-symlink",
          agentStatePreserved: true,
          unknownNativeRootStatePreserved: true,
        }),
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
