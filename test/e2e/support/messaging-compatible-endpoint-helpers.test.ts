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
  parseOpenClawAgentText,
  stopGatewayRuntime,
} from "../live/messaging-compatible-endpoint-helpers.ts";

const COMPAT_AGENT_REPLY = "COMPAT_MOCK_ROUTE_5098_OK";
const COMPAT_AGENT_PROMPT =
  "Call the configured model and report the compatible endpoint route token.";

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
        expect(command).toHaveBeenCalledTimes(1);
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
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        argv0: "openshell-gateway[nemoclaw=nemoclaw;port=8080]",
        stdio: "ignore",
      });
      await once(child, "spawn");
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

    expect(calls).toHaveLength(3);
    expect(calls[0]?.command).toBe("node");
    expect(calls[0]?.args[0]).toMatch(/bin\/nemoclaw\.js$/);
    expect(calls[0]?.args.slice(1)).toEqual(["e2e-msg-compat-missing", "destroy", "--yes"]);
    expect(calls[1]).toEqual({
      command: "openshell",
      args: ["sandbox", "delete", "e2e-msg-compat-missing"],
    });
    expect(calls[2]?.command).toBe("bash");
    expect(calls[2]?.args[0]).toBe("-lc");
    expect(calls[2]?.args[1]).toContain('"$openshell_bin" gateway destroy -g nemoclaw');
    expect(calls[2]?.args.at(-1)).toBe("openshell");
  });

  it("extracts noisy OpenClaw JSON while rejecting prompt echo text", () => {
    expect(COMPAT_AGENT_PROMPT).not.toContain(COMPAT_AGENT_REPLY);
    expect(
      parseOpenClawAgentText(JSON.stringify({ result: { content: COMPAT_AGENT_PROMPT } })),
    ).not.toContain(COMPAT_AGENT_REPLY);

    const noisyOutput = [
      "openclaw: session starting",
      "debug: {not-json}",
      JSON.stringify({
        result: {
          messages: [{ role: "assistant", content: COMPAT_AGENT_REPLY }],
        },
      }),
      "openclaw: session complete",
    ].join("\n");

    expect(parseOpenClawAgentText(noisyOutput)).toContain(COMPAT_AGENT_REPLY);
  });

  it("extracts OpenAI Responses content parts", () => {
    const output = JSON.stringify({
      result: {
        content: [{ type: "output_text", text: COMPAT_AGENT_REPLY }],
      },
    });

    expect(parseOpenClawAgentText(output)).toContain(COMPAT_AGENT_REPLY);
  });
});
