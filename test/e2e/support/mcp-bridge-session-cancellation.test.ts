// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import type { FakeMcpHttpsServer, FakeMcpRequest } from "../live/mcp-bridge-servers.ts";
import { assertAuthenticatedMcpToolDiscovery } from "../live/mcp-bridge-tool-discovery.ts";

const SECRET = "fixture-mcp-secret";
const PROTOCOL = "2025-03-26";

function request(
  method: string,
  sessionId: string,
  extra: Partial<FakeMcpRequest> = {},
): FakeMcpRequest {
  return {
    method: "POST",
    path: "/mcp",
    auth: `Bearer ${SECRET}`,
    body: "",
    sessionId,
    protocolVersion: PROTOCOL,
    rpcMethod: method,
    responseStatus: 200,
    responseHasResult: true,
    ...extra,
  };
}

function initialize(sessionId: string): FakeMcpRequest {
  return request("initialize", "", {
    protocolVersion: "",
    negotiatedSessionId: sessionId,
    negotiatedProtocolVersion: PROTOCOL,
  });
}

function fixture() {
  return {
    prior: [
      initialize("fake-session-9"),
      request("notifications/initialized", "fake-session-9", { responseStatus: 202 }),
      request("tools/list", "fake-session-9", { rpcId: 42 }),
    ],
    cancel: request("notifications/cancelled", "fake-session-9", {
      responseStatus: 202,
      responseHasResult: false,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 42 },
      }),
    }),
  };
}

type Fixture = ReturnType<typeof fixture>;
const checks = {
  accept: (result: Promise<void>) => expect(result).resolves.toBeUndefined(),
  reject: (result: Promise<void>) => expect(result).rejects.toThrow(),
};

it.each([
  { label: "earlier tool-list cancellation", result: "accept", change: (_f: Fixture) => {} },
  {
    label: "earlier tool-call cancellation",
    result: "accept",
    change: (f: Fixture) => {
      f.prior[2]!.rpcMethod = "tools/call";
    },
  },
  {
    label: "unrelated session",
    result: "reject",
    change: (f: Fixture) => {
      f.cancel.sessionId = "fake-session-8";
    },
  },
  {
    label: "wrong protocol",
    result: "reject",
    change: (f: Fixture) => {
      f.cancel.protocolVersion = "other";
    },
  },
  {
    label: "wrong credential",
    result: "reject",
    change: (f: Fixture) => {
      f.cancel.auth = "Bearer foreign";
    },
  },
  {
    label: "unacknowledged cancellation",
    result: "reject",
    change: (f: Fixture) => {
      f.cancel.responseStatus = 400;
    },
  },
  {
    label: "malformed cancellation",
    result: "reject",
    change: (f: Fixture) => {
      f.cancel.body = "{";
    },
  },
  {
    label: "unrelated request ID",
    result: "reject",
    change: (f: Fixture) => {
      f.cancel.body = JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 43 },
      });
    },
  },
  {
    label: "unnegotiated session",
    result: "reject",
    change: (f: Fixture) => {
      f.prior.splice(0);
    },
  },
  {
    label: "failed earlier initialize",
    result: "reject",
    change: (f: Fixture) => {
      f.prior[0]!.responseStatus = 400;
    },
  },
  {
    label: "earlier initialize without result",
    result: "reject",
    change: (f: Fixture) => {
      f.prior[0]!.responseHasResult = false;
    },
  },
  {
    label: "missing earlier initialized notification",
    result: "reject",
    change: (f: Fixture) => {
      f.prior.splice(1, 1);
    },
  },
  {
    label: "foreign earlier request credential",
    result: "reject",
    change: (f: Fixture) => {
      f.prior[2]!.auth = "Bearer foreign";
    },
  },
  {
    label: "earlier RPC before initialization",
    result: "reject",
    change: (f: Fixture) => {
      f.prior.unshift(f.prior.pop()!);
    },
  },
  {
    label: "cross-session tool request",
    result: "reject",
    change: (f: Fixture) => {
      f.cancel.rpcMethod = "tools/list";
    },
  },
  {
    label: "current-session cancellation",
    result: "accept",
    change: (f: Fixture) => {
      f.cancel.sessionId = "fake-session-10";
    },
  },
  {
    label: "current-session wrong protocol",
    result: "reject",
    change: (f: Fixture) => {
      f.cancel.sessionId = "fake-session-10";
      f.cancel.protocolVersion = "other";
    },
  },
] as const)("validates $label during discovery", async ({ result, change }) => {
  const f = fixture();
  change(f);
  const requests = [...f.prior];
  const host = {
    nemoclaw: vi.fn(async () => {
      requests.push(
        initialize("fake-session-10"),
        request("notifications/initialized", "fake-session-10", { responseStatus: 202 }),
        request("tools/list", "fake-session-10", { rpcId: 42 }),
        f.cancel,
        request("tools/list", "fake-session-10", { rpcId: 43 }),
      );
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          provider: { present: true, state: "configured", attached: true, credentialReady: true },
          policy: { present: true, state: "configured" },
          adapter: { registered: true },
          toolDiscovery: {
            ok: true,
            count: 2,
            tools: ["fake_echo", "fake_status"],
            truncated: false,
            commandStatus: 0,
          },
        }),
      };
    }),
  };
  const artifacts = { writeJson: vi.fn().mockResolvedValue("evidence.json") };
  await checks[result](
    assertAuthenticatedMcpToolDiscovery(
      host as unknown as Parameters<typeof assertAuthenticatedMcpToolDiscovery>[0],
      { requests } as unknown as FakeMcpHttpsServer,
      {
        artifacts,
        sandboxName: "sandbox",
        artifactPrefix: "openclaw",
        hostSecret: SECRET,
        progress: { event: vi.fn() },
      },
    ),
  );
  expect(host.nemoclaw).toHaveBeenCalledOnce();
  expect(JSON.stringify(artifacts.writeJson.mock.calls)).not.toContain(SECRET);
});
