// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSdkOpenShellPolicyRequests } from "./policy-requests-sdk";

const target = { kind: "named" as const, gatewayName: "nemoclaw" };
const base = { sandboxName: "alpha", target };

function chunk(overrides: Record<string, unknown> = {}) {
  return {
    id: "chunk-1",
    status: "pending",
    ruleName: "allow_api_example_com_443",
    binary: "/usr/bin/python3",
    proposedRule: {
      endpoints: [
        {
          host: "api.example.com",
          port: 443,
          protocol: "rest",
          access: "",
          rules: [{ allow: { method: "GET", path: "/v1/items" } }],
        },
      ],
    },
    rationale: "Denied GET /v1/items",
    securityNotes: "",
    validationResult: "",
    applicationError: "",
    hitCount: 3,
    firstSeenMs: 1000n,
    lastSeenMs: 2000n,
    reviewToken: "token-1",
    ...overrides,
  };
}

function harness(chunks: unknown[] = [chunk()]) {
  const getDraftPolicy = vi.fn(async () => ({ chunks: chunks as never[] }));
  const approveDraftChunk = vi.fn(async () => ({ policyVersion: 7, policyHash: "abc" }));
  const rejectDraftChunk = vi.fn(async () => ({ chunkId: "chunk-1", reviewToken: "" }));
  const connect = vi.fn(async () => ({
    raw: { getDraftPolicy, approveDraftChunk, rejectDraftChunk },
  }));
  const client = createSdkOpenShellPolicyRequests({ connect });
  return { approveDraftChunk, client, connect, getDraftPolicy, rejectDraftChunk };
}

describe("OpenShell SDK policy requests", () => {
  it("lists pending chunks from the recorded gateway with their review token", async () => {
    const { client, connect, getDraftPolicy } = harness([
      chunk(),
      chunk({ id: "chunk-2", status: "approved" }),
    ]);

    const result = await client.listPending(base);

    expect(connect).toHaveBeenCalledWith(target, { signal: expect.any(AbortSignal) });
    expect(getDraftPolicy).toHaveBeenCalledWith(
      { name: "alpha", statusFilter: "pending", workspace: "default" },
      { signal: expect.any(AbortSignal) },
    );
    expect(result).toEqual({
      ok: true,
      value: [
        {
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
          hitCount: 3,
          firstSeenMs: 1000,
          lastSeenMs: 2000,
          reviewToken: "token-1",
        },
      ],
    });
  });

  it("drops chunks whose ID is not a safe identifier", async () => {
    const { client } = harness([chunk({ id: "../../etc" }), chunk({ id: "" })]);

    await expect(client.listPending(base)).resolves.toEqual({ ok: true, value: [] });
  });

  it("uses the first explicit port when a chunk lists a port set", async () => {
    const { client } = harness([
      chunk({
        proposedRule: { endpoints: [{ host: "example.com", port: 0, ports: [0, 8443] }] },
      }),
    ]);

    const result = await client.listPending(base);

    expect(result.ok && result.value[0]?.endpoints[0]?.port).toBe(8443);
  });

  it("approves with the review token that was read", async () => {
    const { approveDraftChunk, client } = harness();

    const result = await client.approve({ ...base, chunkId: "chunk-1", reviewToken: "token-1" });

    expect(approveDraftChunk).toHaveBeenCalledWith(
      { name: "alpha", chunkId: "chunk-1", workspace: "default", reviewToken: "token-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(result).toEqual({ ok: true, value: { policyVersion: 7, policyHash: "abc" } });
  });

  it("refuses to approve without a review token", async () => {
    const { client, connect } = harness();

    const result = await client.approve({ ...base, chunkId: "chunk-1", reviewToken: "" });

    expect(result).toEqual({
      ok: false,
      error: { kind: "schema", message: "Invalid approval request." },
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects with the operator's reason", async () => {
    const { client, rejectDraftChunk } = harness();

    const result = await client.reject({ ...base, chunkId: "chunk-1", reason: "GET /docs only" });

    expect(rejectDraftChunk).toHaveBeenCalledWith(
      { name: "alpha", chunkId: "chunk-1", reason: "GET /docs only", workspace: "default" },
      { signal: expect.any(AbortSignal) },
    );
    expect(result).toEqual({ ok: true, value: null });
  });

  it("validates the sandbox and gateway names before it connects", async () => {
    const { client, connect } = harness();

    await expect(client.listPending({ ...base, sandboxName: "../alpha" })).resolves.toEqual({
      ok: false,
      error: { kind: "schema", message: "Invalid sandbox request." },
    });
    await expect(client.reject({ ...base, chunkId: "chunk 1", reason: "" })).resolves.toMatchObject(
      { ok: false, error: { kind: "schema" } },
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("reports a stale review as needing a fresh read", async () => {
    const stale = Object.assign(new Error("review token mismatch"), {
      code: "rpc",
      connectCode: 9,
    });
    const client = createSdkOpenShellPolicyRequests({
      connect: async () => ({
        raw: {
          getDraftPolicy: async () => ({ chunks: [] }),
          approveDraftChunk: async () => {
            throw stale;
          },
          rejectDraftChunk: async () => ({}),
        },
      }),
    });

    const result = await client.approve({ ...base, chunkId: "chunk-1", reviewToken: "token-1" });

    expect(result).toMatchObject({ ok: false, error: { kind: "stale" } });
  });

  it("classifies an authorization denial without exposing its detail", async () => {
    const denied = Object.assign(new Error("token=secret"), { code: "auth" });
    const client = createSdkOpenShellPolicyRequests({
      connect: async () => {
        throw denied;
      },
    });

    const result = await client.listPending(base);

    expect(result).toEqual({
      ok: false,
      error: { kind: "authentication", message: "OpenShell denied access." },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("passes the local gateway preflight reason through", async () => {
    const reason =
      "Unsafe OpenShell gateway state directory: the gateway state directory's ancestor '/home/u/.local' is not a trusted real directory.";
    const client = createSdkOpenShellPolicyRequests({
      connect: async () => {
        throw Object.assign(new Error(reason), { name: "OpenShellSdkPreflightUnavailableError" });
      },
    });

    await expect(client.listPending(base)).resolves.toEqual({
      ok: false,
      error: { kind: "local_state", message: reason },
    });
  });

  it("reports a missing SDK package without the loader detail", async () => {
    const client = createSdkOpenShellPolicyRequests({
      connect: async () => {
        throw new Error(
          "Cannot find package '@nvidia/openshell-sdk' imported from /x/sdk-import.mjs",
        );
      },
    });

    await expect(client.listPending(base)).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable", message: "OpenShell SDK is unavailable." },
    });
  });

  it("times out a gateway that never answers", async () => {
    const client = createSdkOpenShellPolicyRequests({
      connect: () => new Promise<never>(() => {}),
    });

    const result = await client.listPending({ ...base, timeoutMs: 20 });

    expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
  });
});
