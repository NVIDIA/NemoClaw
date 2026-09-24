// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import { startRoutedPrivateRelay } from "../fixtures/routed-private-relay.ts";
import { captureTrustedPrivateMcpFailure } from "../live/mcp-bridge-trusted-private.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";

const runtime = vi.hoisted(() => ({ command: vi.fn(), resolveSandboxResourceHandle: vi.fn() }));
vi.mock("../fixtures/runtime-provider.ts", () => ({
  RuntimeProviderPrerequisite: class {
    command = runtime.command;
    resolveSandboxResourceHandle = runtime.resolveSandboxResourceHandle;
  },
}));

async function startRelay() {
  runtime.resolveSandboxResourceHandle.mockResolvedValue("owned-sandbox");
  runtime.command.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  runtime.command
    .mockResolvedValueOnce({ exitCode: 0, stdout: '{"owned-network":{}}', stderr: "" })
    .mockResolvedValueOnce({ exitCode: 0, stdout: "relay-id", stderr: "" })
    .mockResolvedValueOnce({ exitCode: 0, stdout: "172.18.0.3", stderr: "" });
  return startRoutedPrivateRelay({
    host: {} as HostCliClient,
    sandboxName: "owned-sandbox",
    upstreamHost: "10.0.0.1",
    upstreamPort: 12345,
  });
}

it.each([
  { outcome: "succeeds", acquire: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }) },
  { outcome: "rejects", acquire: () => Promise.reject(new Error("artifact unavailable")) },
])("removes the owned relay when diagnostic acquisition $outcome", async ({ acquire }) => {
  const relay = await startRelay();
  runtime.command.mockImplementationOnce(acquire);
  await relay.close();
  const startArgs = runtime.command.mock.calls[1]?.[0] as string[];
  const name = startArgs[startArgs.indexOf("--name") + 1];
  expect(runtime.command.mock.calls.slice(-2)).toEqual([
    [
      ["container", "logs", "--tail", "50", name],
      {
        artifactName: "routed-private-relay-connections",
        captureLimitBytes: 8192,
        timeoutMs: 10000,
      },
    ],
    [
      ["container", "rm", "--force", name],
      {
        artifactName: "cleanup-routed-private-relay",
        timeoutMs: 60000,
      },
    ],
  ]);
});

it("reports relay connection outcomes without recording payloads or error messages", async () => {
  await startRelay();
  const startArgs = runtime.command.mock.calls[1]?.[0] as string[];
  const log = vi.fn();
  const socket = () =>
    Object.assign(new EventEmitter(), {
      pipe: vi.fn(),
      destroy: vi.fn(),
      bytesRead: 12,
      bytesWritten: 34,
    });
  const client = socket();
  const upstream = socket();
  runInNewContext(startArgs[startArgs.indexOf("-e") + 1]!, {
    require: () => ({
      createServer: (accept: (value: typeof client) => void) => {
        accept(client);
        return { listen: (_port: number, _host: string, ready: () => void) => ready() };
      },
      connect: () => upstream,
    }),
    process: { argv: ["node", "10.0.0.1", "12345"] },
    console: { log },
  });
  upstream.emit("connect");
  upstream.emit("data", Buffer.from("secret payload"));
  upstream.emit("error", Object.assign(new Error("secret error detail"), { code: "ECONNRESET" }));
  upstream.emit("close");
  expect(log.mock.calls.map(([line]) => JSON.parse(line as string))).toEqual([
    { event: "client-connected" },
    { event: "listening" },
    { event: "upstream-connected" },
    { event: "connection-error", side: "upstream", code: "ECONNRESET" },
    { event: "upstream-closed", bytesRead: 12, bytesWritten: 34 },
  ]);
  expect(client.destroy).toHaveBeenCalledOnce();
  expect(upstream.destroy).toHaveBeenCalledOnce();
});

it("captures bounded redacted OpenShell evidence only for a failed private-route probe", async () => {
  const command = vi.fn().mockRejectedValue(new Error("diagnostic unavailable"));
  const host = { command, openshellCommandPath: "/trusted/openshell" };
  const options = { sandboxName: "owned-sandbox", artifactPrefix: "hermes" };
  await captureTrustedPrivateMcpFailure(host, { exitCode: 0, timedOut: false }, options);
  expect(command).not.toHaveBeenCalled();
  await expect(
    captureTrustedPrivateMcpFailure(host, { exitCode: 1, timedOut: false }, options),
  ).resolves.toBeUndefined();
  expect(command).toHaveBeenCalledWith(
    "/trusted/openshell",
    ["logs", "owned-sandbox", "-n", "200", "--source", "all", "--since", "2m"],
    expect.objectContaining({
      artifactName: "hermes-mcp-trusted-private-failure-logs",
      redactionValues: Object.values(MCP_BRIDGE_TEST_CREDENTIALS),
      captureLimitBytes: 32768,
      timeoutMs: 30000,
    }),
  );
});
