// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { collectOperationEvent } =
  require("../../dist/lib/actions/telemetry/send.js") as typeof import("../../src/lib/actions/telemetry/send");
const { isOperationEvent } =
  require("../../dist/lib/domain/telemetry/schema.js") as typeof import("../../src/lib/domain/telemetry/schema");
const { createSupervisedSandboxCommandReader } =
  require("../../dist/lib/actions/telemetry/native-reader.js") as typeof import("../../src/lib/actions/telemetry/native-reader");

function fakeOpenShell(home: string, body: string) {
  const filename = path.join(home, "openshell-fixture");
  fs.writeFileSync(filename, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", filename);
  vi.stubEnv("HOME", home);
  vi.stubEnv("NEMOCLAW_GATEWAY_MANAGEMENT", undefined);
  return filename;
}

it("collects native JSON5 models through the packaged reader after the roster process fails", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-contract-"));
  try {
    const config =
      "{ // native OpenClaw config\n agents: { defaults: { model: 'openai/gpt-4o' }, entries: { main: {} } } }";
    fakeOpenShell(
      home,
      `const args = process.argv.slice(2); const command = args.slice(args.indexOf('--') + 1);
      if (command[0] === 'cat') process.stdout.write(${JSON.stringify(config)});
      else if (command[0] === 'uname') process.stdout.write('Linux');
      else { process.stderr.write('private-native-error'); process.exitCode = 1; }`,
    );
    fs.mkdirSync(path.join(home, ".nemoclaw"));
    fs.writeFileSync(
      path.join(home, ".nemoclaw", "sandboxes.json"),
      JSON.stringify({
        sandboxes: { selected: { name: "selected", agent: "openclaw", gatewayPort: 8080 } },
      }),
    );
    const result = await collectOperationEvent(
      {
        operation: "sandbox_rebuild",
        startedAt: "2026-11-03T00:00:00.000Z",
        completedAt: "2026-11-03T00:00:01.000Z",
        outcome: "completed",
        state: "applied",
        scope: "sandbox",
        installedVersion: "1.2.3",
        targets: [
          {
            sandboxName: "selected",
            gatewayName: "nemoclaw",
            scope: "sandbox",
            outcome: "completed",
            state: "applied",
          },
        ],
      },
      { signal: new AbortController().signal, deadlineAt: Date.now() + 2000 },
    );
    expect(isOperationEvent(result)).toBe(true);
    expect(result.parameters).toMatchObject({
      configuredAgentCount: 1,
      targetResults: [{ configurationPosition: 0, configurationStatus: "reported" }],
      configurations: [
        {
          agentHarnessId: "openclaw",
          sandboxOSStatus: "reported",
          agentsStatus: "reported",
          agents: [
            {
              models: [
                { modelId: "gpt-4o", providerProfile: "openai", apiFamily: "openai-completions" },
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private-native-error");
    expect(JSON.stringify(result)).not.toContain("selected");
    expect(JSON.stringify(result)).not.toContain(home);
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it("cancels an owned native process group and removes reader signal listeners", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reader-cancel-"));
  const pidsFile = path.join(home, "pids.json");
  const controller = new AbortController();
  const beforeTerm = process.listenerCount("SIGTERM");
  const beforeInt = process.listenerCount("SIGINT");
  let reader: ReturnType<typeof createSupervisedSandboxCommandReader> | undefined;
  let pids: number[] = [];
  try {
    fakeOpenShell(
      home,
      `const fs = require('node:fs'); const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);`,
    );
    reader = createSupervisedSandboxCommandReader(controller.signal);
    const pending = reader
      .read(
        {
          sandboxName: "selected",
          target: { kind: "named", gatewayName: "nemoclaw" },
          command: ["fixture"],
          timeoutMilliseconds: 2000,
          timeoutKillSignal: "SIGKILL",
          outputLimitBytes: 1024,
        },
        { gatewayName: "nemoclaw", workspace: "default" },
      )
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(fs.existsSync(pidsFile)).toBe(true));
    pids = JSON.parse(fs.readFileSync(pidsFile, "utf8")) as number[];
    controller.abort();
    expect(await pending).toMatchObject({ reason: "cancelled" });
    reader.dispose();
    await vi.waitFor(() => {
      expect(() => process.kill(pids[0], 0)).toThrow();
      expect(() => process.kill(pids[1], 0)).toThrow();
    });
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
  } finally {
    controller.abort();
    reader?.dispose();
    try {
      process.kill(pids[0], "SIGKILL");
    } catch {}
    try {
      process.kill(pids[1], "SIGKILL");
    } catch {}
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it.each(["conflicting binding", "authority drift"])(
  "refuses packaged runtime reads after %s",
  async (failure) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-authority-contract-"));
    const invoked = path.join(home, "invoked");
    try {
      fakeOpenShell(
        home,
        `require('node:fs').writeFileSync(${JSON.stringify(invoked)}, 'unexpected'); process.exitCode = 1;`,
      );
      fs.mkdirSync(path.join(home, ".nemoclaw"));
      fs.writeFileSync(
        path.join(home, ".nemoclaw", "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            selected: {
              name: "selected",
              agent: "openclaw",
              gatewayPort: 8080,
              ...(failure === "conflicting binding" ? { gatewayName: "nemoclaw-8091" } : {}),
            },
          },
        }),
      );
      const { createSession } =
        require("../../dist/lib/state/onboard-session.js") as typeof import("../../src/lib/state/onboard-session");
      const { bindGatewayAuthorityToCheckpoint } =
        require("../../dist/lib/onboard/gateway-authority-checkpoint.js") as typeof import("../../src/lib/onboard/gateway-authority-checkpoint");
      const { resolveGatewayOwner } =
        require("../../dist/lib/onboard/gateway-ownership.js") as typeof import("../../src/lib/onboard/gateway-ownership");
      const session = createSession();
      bindGatewayAuthorityToCheckpoint(
        session,
        resolveGatewayOwner({
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          declaration: null,
          hasPackagedService: false,
        }),
      );
      fs.writeFileSync(
        path.join(home, ".nemoclaw", "onboard-session.json"),
        JSON.stringify(session),
      );
      const declaration = path.join(home, "gateway-management.json");
      fs.writeFileSync(
        declaration,
        JSON.stringify({
          version: 1,
          mode: "externally-supervised",
          endpoint: "http://127.0.0.1:8080",
          stateDir: path.join(home, "external-gateway"),
          supervisor: {
            kind: "systemd-user",
            serviceName: "openshell-gateway.service",
            execPath: "/usr/bin/openshell-gateway",
          },
          requiredCapabilities: [],
        }),
      );
      vi.stubEnv(
        "NEMOCLAW_GATEWAY_MANAGEMENT",
        failure === "authority drift" ? declaration : undefined,
      );
      const result = await collectOperationEvent(
        {
          operation: "sandbox_rebuild",
          startedAt: "2026-11-03T00:00:00.000Z",
          completedAt: "2026-11-03T00:00:01.000Z",
          outcome: "failed",
          state: "unavailable",
          scope: "sandbox",
          installedVersion: "1.2.3",
          targets: [],
        },
        { signal: new AbortController().signal, deadlineAt: Date.now() + 1000 },
      );
      expect(isOperationEvent(result)).toBe(true);
      expect(result.parameters.configurations).toMatchObject([
        {
          agentHarnessId: "openclaw",
          agentHarnessStatus: "reported",
          agentsStatus: "collection_error",
          agents: [],
        },
      ]);
      expect(fs.existsSync(invoked)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
