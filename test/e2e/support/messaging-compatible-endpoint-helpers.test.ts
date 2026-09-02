// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  cleanupMessagingState,
  cleanupOwnedGatewayRuntimeStrict,
  stopGatewayRuntime,
} from "../live/messaging-compatible-endpoint-helpers.ts";

describe("messaging compatible endpoint helper coverage", () => {
  it.runIf(process.platform === "linux")(
    "never signals an unrelated process from a stale gateway PID file (#6352)",
    async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-pid-"));
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      await once(child, "spawn");
      const pid = child.pid;
      expect(pid).toBeTypeOf("number");
      fs.writeFileSync(path.join(stateDir, "openshell-gateway.pid"), String(pid), "utf8");
      vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", stateDir);
      const command = vi.fn(async () => ({ exitCode: 0 }));
      const host = {
        command,
        openshellCommandPath: "/configured/openshell",
      } as unknown as HostCliClient;

      try {
        await expect(
          stopGatewayRuntime(host, "preclean-unrelated-gateway-pid"),
        ).resolves.toBeUndefined();
        expect(() => process.kill(pid!, 0)).not.toThrow();
        await expect(
          cleanupOwnedGatewayRuntimeStrict(host, "strict-unrelated-gateway-pid"),
        ).rejects.toThrow(/does not prove ownership/u);
        expect(() => process.kill(pid!, 0)).not.toThrow();
        fs.writeFileSync(path.join(stateDir, "openshell-gateway.pid"), "not-a-pid", "utf8");
        await expect(
          cleanupOwnedGatewayRuntimeStrict(host, "strict-invalid-gateway-pid"),
        ).rejects.toThrow(/PID file is invalid or unreadable/u);
        expect(command).toHaveBeenCalledTimes(4);
      } finally {
        vi.unstubAllEnvs();
        process.kill(pid!, "SIGKILL");
        await once(child, "exit");
        fs.rmSync(stateDir, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "signals only a start-time-matched owned gateway process (#6352)",
    async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-owned-gateway-pid-"));
      const child = spawn(
        process.execPath,
        ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
        {
          argv0: "openshell-gateway[nemoclaw=nemoclaw;port=8080]",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const childReady = once(child.stdout, "data");
      await once(child, "spawn");
      await childReady;
      const childExit = once(child, "exit");
      const pid = child.pid;
      expect(pid).toBeTypeOf("number");
      fs.writeFileSync(path.join(stateDir, "openshell-gateway.pid"), String(pid), "utf8");
      vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", stateDir);
      const command = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" }));
      const host = { command } as unknown as HostCliClient;

      try {
        await expect(
          cleanupOwnedGatewayRuntimeStrict(host, "strict-owned-gateway-pid"),
        ).resolves.toBeUndefined();
        await childExit;
        expect(command).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllEnvs();
        child.kill("SIGKILL");
        await childExit;
        fs.rmSync(stateDir, { force: true, recursive: true });
      }
    },
  );

  it("keeps missing-sandbox cleanup from masking endpoint validation evidence", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const host = {
      openshellCommandPath: "openshell",
      command: async (command: string, args: string[]) => {
        calls.push({ command, args });
        throw new Error("Sandbox e2e-msg-compat-missing does not exist");
      },
    } as unknown as HostCliClient;

    await expect(
      (async () => {
        try {
          throw new Error("endpoint validation failed with HTTP 429");
        } catch (error) {
          await cleanupMessagingState(host, "e2e-msg-compat-missing");
          throw error;
        }
      })(),
    ).rejects.toThrow(/HTTP 429/);

    expect(calls).toHaveLength(6);
    expect(calls[0]?.command).toBe("node");
    expect(calls[0]?.args[0]).toMatch(/bin\/nemoclaw\.js$/);
    expect(calls[0]?.args.slice(1)).toEqual(["e2e-msg-compat-missing", "destroy", "--yes"]);
    expect(calls[1]).toEqual({
      command: "openshell",
      args: ["sandbox", "delete", "e2e-msg-compat-missing"],
    });
    expect(calls[2]).toEqual({
      command: "openshell",
      args: ["forward", "stop", "18789"],
    });
    expect(calls[3]).toEqual({
      command: "openshell",
      args: ["gateway", "stop", "-g", "nemoclaw"],
    });
    expect(calls[4]?.args).toEqual([
      "container",
      "ps",
      "--filter",
      "name=^openshell-cluster-nemoclaw$",
      "--format",
      "{{.Names}}",
    ]);
    expect(calls[5]).toEqual({
      command: "openshell",
      args: ["gateway", "destroy", "-g", "nemoclaw"],
    });
  });

});
