// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  OpenShellPolicyRequests,
  PolicyRequest,
} from "../../../adapters/openshell/policy-requests-sdk";
import {
  approveSandboxPolicyRequest,
  listSandboxPolicyRequests,
  rejectSandboxPolicyRequest,
  type PolicyRequestsDeps,
  type PolicyRequestsHost,
} from "./requests";

function pending(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    id: "chunk-1",
    status: "pending",
    ruleName: "allow_api_example_com_443",
    binary: "/usr/bin/python3",
    endpoints: [
      {
        host: "api.example.com",
        port: 443,
        protocol: "rest",
        access: "",
        rules: [{ method: "GET", path: "/v1/items" }],
      },
    ],
    rationale: "Denied GET /v1/items",
    securityNotes: "",
    validationResult: "",
    applicationError: "",
    hitCount: 2,
    firstSeenMs: 1,
    lastSeenMs: 2,
    reviewToken: "token-1",
    ...overrides,
  };
}

function harness(
  requests: PolicyRequest[] = [pending()],
  overrides: PolicyRequestsDeps & Partial<PolicyRequestsHost> = {},
) {
  const lines: string[] = [];
  const errors: string[] = [];
  const json: unknown[] = [];
  const policyRequests = {
    listPending: vi.fn(async () => ({ ok: true as const, value: requests })),
    approve: vi.fn(async () => ({
      ok: true as const,
      value: { policyVersion: 4, policyHash: "abc" },
    })),
    reject: vi.fn(async () => ({ ok: true as const, value: null })),
  } satisfies OpenShellPolicyRequests;
  const lockedSandboxes: string[] = [];
  const withLock = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    lockedSandboxes.push(name);
    return operation();
  };
  const { cliName, resolveGatewayName, ask, ...depOverrides } = overrides;
  const host: PolicyRequestsHost = {
    cliName: cliName ?? "nemoclaw",
    resolveGatewayName: resolveGatewayName ?? (() => "nemoclaw"),
    ask: ask ?? vi.fn(async () => "y"),
  };
  const deps: PolicyRequestsDeps = {
    policyRequests,
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
    logJson: (value) => json.push(value),
    isNonInteractive: () => false,
    withLock,
    ...depOverrides,
  };
  return { deps, errors, host, json, lines, lockedSandboxes, policyRequests };
}

afterEach(() => {
  delete process.env.OPENSHELL_GATEWAY_ENDPOINT;
});

describe("policy requests", () => {
  it("lists pending requests with destination, binary, and next commands", async () => {
    const { deps, host, lines, policyRequests } = harness();

    await expect(listSandboxPolicyRequests("alpha", {}, host, deps)).resolves.toEqual({
      exitCode: 0,
    });

    expect(policyRequests.listPending).toHaveBeenCalledWith({
      sandboxName: "alpha",
      target: { kind: "named", gatewayName: "nemoclaw" },
    });
    const output = lines.join("\n");
    expect(output).toContain("1 pending network request for sandbox 'alpha'");
    expect(output).toContain("Destination: api.example.com:443");
    expect(output).toContain("Binary:      /usr/bin/python3");
    expect(output).toContain("Allows:      GET /v1/items");
    expect(output).toContain("policy approve <id>");
  });

  it("says so when nothing is pending", async () => {
    const { deps, host, lines } = harness([]);

    await listSandboxPolicyRequests("alpha", {}, host, deps);

    expect(lines).toEqual(["  No pending network requests for sandbox 'alpha'."]);
  });

  it("omits review tokens from JSON output", async () => {
    const { deps, host, json } = harness();

    await listSandboxPolicyRequests("alpha", { json: true }, host, deps);

    expect(json).toHaveLength(1);
    expect(JSON.stringify(json[0])).not.toContain("token-1");
    expect(json[0]).toMatchObject({ sandbox: "alpha", requests: [{ id: "chunk-1" }] });
  });

  it("escapes terminal control sequences and redacts credentials from OpenShell text", async () => {
    const { deps, host, lines } = harness([
      pending({
        rationale: "\u001b[2Jcleared https://user:hunter2@example.com/",
        binary: "/usr/bin/curl\u0007",
      }),
    ]);

    await listSandboxPolicyRequests("alpha", {}, host, deps);

    const output = lines.join("\n");
    expect(output).not.toContain("\u001b[2J");
    expect(output).not.toContain("\u0007");
    expect(output).not.toContain("hunter2");
  });

  it("refuses an unregistered sandbox without contacting OpenShell", async () => {
    const { deps, host, errors, policyRequests } = harness([], { resolveGatewayName: () => null });

    await expect(listSandboxPolicyRequests("ghost", {}, host, deps)).resolves.toEqual({
      exitCode: 1,
    });

    expect(errors.join("\n")).toContain("Sandbox 'ghost' is not registered");
    expect(policyRequests.listPending).not.toHaveBeenCalled();
  });

  it("refuses to run when OPENSHELL_GATEWAY_ENDPOINT could redirect the gateway", async () => {
    process.env.OPENSHELL_GATEWAY_ENDPOINT = "https://elsewhere:8080";
    const { deps, host, policyRequests } = harness();

    await expect(listSandboxPolicyRequests("alpha", {}, host, deps)).rejects.toThrow(
      /OPENSHELL_GATEWAY_ENDPOINT/,
    );
    expect(policyRequests.listPending).not.toHaveBeenCalled();
  });

  it("approves after confirmation, under the sandbox lock, with the fresh review token", async () => {
    const { deps, host, lines, lockedSandboxes, policyRequests } = harness();

    await expect(
      approveSandboxPolicyRequest("alpha", { requestId: "chunk-1" }, host, deps),
    ).resolves.toEqual({ exitCode: 0 });

    expect(lockedSandboxes).toEqual(["alpha"]);
    expect(host.ask).toHaveBeenCalledOnce();
    expect(policyRequests.approve).toHaveBeenCalledWith({
      sandboxName: "alpha",
      target: { kind: "named", gatewayName: "nemoclaw" },
      chunkId: "chunk-1",
      reviewToken: "token-1",
    });
    expect(lines.join("\n")).toContain("Approved 'chunk-1' (policy version 4)");
  });

  it("leaves the request pending when the operator declines", async () => {
    const { deps, host, lines, policyRequests } = harness([pending()], { ask: async () => "n" });

    await expect(
      approveSandboxPolicyRequest("alpha", { requestId: "chunk-1" }, host, deps),
    ).resolves.toEqual({ exitCode: 0 });

    expect(policyRequests.approve).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("still pending");
  });

  it("treats Ctrl-D at the prompt as no", async () => {
    const eof = Object.assign(new Error("Prompt closed before input"), { code: "EOF" });
    const { deps, host, lines, policyRequests } = harness([pending()], {
      ask: async () => Promise.reject(eof),
    });

    await expect(
      approveSandboxPolicyRequest("alpha", { requestId: "chunk-1" }, host, deps),
    ).resolves.toEqual({ exitCode: 0 });

    expect(policyRequests.approve).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("still pending");
  });

  it("says to re-check pending requests when an approval times out", async () => {
    const { deps, host, errors, policyRequests } = harness();
    policyRequests.approve.mockResolvedValueOnce({
      ok: false,
      error: { kind: "timeout", message: "OpenShell did not respond in time." },
    } as never);

    await expect(
      approveSandboxPolicyRequest("alpha", { requestId: "chunk-1", yes: true }, host, deps),
    ).resolves.toEqual({ exitCode: 1 });

    expect(errors.join("\n")).toContain("nemoclaw alpha policy requests' before retrying");
  });

  it("requires --yes when it cannot prompt", async () => {
    const { deps, host, errors, policyRequests } = harness([pending()], {
      isNonInteractive: () => true,
    });

    await expect(
      approveSandboxPolicyRequest("alpha", { requestId: "chunk-1" }, host, deps),
    ).resolves.toEqual({ exitCode: 1 });
    expect(errors.join("\n")).toContain("pass --yes");
    expect(policyRequests.approve).not.toHaveBeenCalled();

    await expect(
      approveSandboxPolicyRequest("alpha", { requestId: "chunk-1", yes: true }, host, deps),
    ).resolves.toEqual({ exitCode: 0 });
    expect(policyRequests.approve).toHaveBeenCalledOnce();
  });

  it("shows OpenShell's security notes before asking", async () => {
    const { deps, host, lines } = harness([
      pending({ securityNotes: "Destination resolves to a private address" }),
    ]);

    await approveSandboxPolicyRequest("alpha", { requestId: "chunk-1" }, host, deps);

    expect(lines.join("\n")).toContain("Security:    Destination resolves to a private address");
  });

  it("will not approve a request that OpenShell says cannot be applied", async () => {
    const { deps, host, errors, policyRequests } = harness([
      pending({ applicationError: "merge failed: conflicting endpoint" }),
    ]);

    await expect(
      approveSandboxPolicyRequest("alpha", { requestId: "chunk-1", yes: true }, host, deps),
    ).resolves.toEqual({ exitCode: 1 });

    expect(errors.join("\n")).toContain("cannot be applied");
    expect(policyRequests.approve).not.toHaveBeenCalled();
  });

  it("reports an unknown request ID", async () => {
    const { deps, host, errors, policyRequests } = harness();

    await expect(
      approveSandboxPolicyRequest("alpha", { requestId: "chunk-9", yes: true }, host, deps),
    ).resolves.toEqual({ exitCode: 1 });

    expect(errors.join("\n")).toContain("No pending request 'chunk-9'");
    expect(policyRequests.approve).not.toHaveBeenCalled();
  });

  it("tells the operator to re-read a request that changed before approval", async () => {
    const { deps, host, errors, policyRequests } = harness();
    policyRequests.approve.mockResolvedValueOnce({
      ok: false,
      error: { kind: "stale", message: "The request changed after it was read." },
    } as never);

    await expect(
      approveSandboxPolicyRequest("alpha", { requestId: "chunk-1", yes: true }, host, deps),
    ).resolves.toEqual({ exitCode: 1 });

    expect(errors.join("\n")).toContain("nemoclaw alpha policy requests");
  });

  it("points at the host directory, not the sandbox, when the gateway preflight refuses", async () => {
    const { deps, errors, host, policyRequests } = harness();
    policyRequests.listPending.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "local_state",
        message: "Unsafe OpenShell gateway state directory: '/home/u/.local' is group writable.",
      },
    } as never);

    await expect(listSandboxPolicyRequests("alpha", {}, host, deps)).resolves.toEqual({
      exitCode: 1,
    });

    const output = errors.join("\n");
    expect(output).toContain("'/home/u/.local' is group writable");
    expect(output).toContain("Fix the host directory named above");
    expect(output).not.toContain("status");
  });

  it("rejects with the operator's reason under the sandbox lock", async () => {
    const { deps, host, lines, lockedSandboxes, policyRequests } = harness();

    await expect(
      rejectSandboxPolicyRequest(
        "alpha",
        { requestId: "chunk-1", reason: "  GET /docs only  " },
        host,
        deps,
      ),
    ).resolves.toEqual({ exitCode: 0 });

    expect(lockedSandboxes).toEqual(["alpha"]);
    expect(policyRequests.reject).toHaveBeenCalledWith({
      sandboxName: "alpha",
      target: { kind: "named", gatewayName: "nemoclaw" },
      chunkId: "chunk-1",
      reason: "GET /docs only",
    });
    expect(lines.join("\n")).toContain("Rejected 'chunk-1'");
  });
});
