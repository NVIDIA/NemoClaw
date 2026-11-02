// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import { readProtectedLocalInferenceCount } from "../../../scripts/checks/managed-image-protected-runtime-contract.ts";
import {
  assertProtectedLocalInference,
  type ManagedImageCommandRunner,
} from "../../../scripts/checks/run-managed-image-openshell-e2e.ts";
import { buildOpenShellSandboxCreateEnvironment } from "../../../src/lib/adapters/openshell/sandbox-lifecycle-cli.ts";

const IMAGE = `localhost:5000/nemoclaw-managed-protected/openclaw@sha256:${"a".repeat(64)}`;

it.each([
  [
    "ollama",
    "11435",
    "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    { model: "fixture-model", completedRequests: 2 },
    "?model=fixture-model",
  ],
  ["vllm", "8000", "NEMOCLAW_PROTECTED_INFERENCE_RECEIPT_TOKEN", { completedRequests: 2 }, ""],
] as const)(
  "reads the protected %s completion receipt only from its configured route",
  async (kind, port, credentialEnv, receipt, query) => {
    const token = "a".repeat(48);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => receipt,
    } as Response);
    try {
      const env = {
        [credentialEnv]: token,
        ...(kind === "vllm" ? { NEMOCLAW_PROTECTED_INFERENCE_RECEIPT_PORT: port } : {}),
      };
      const count = await readProtectedLocalInferenceCount(
        {
          agent: "hermes",
          image: IMAGE,
          sandbox: "managed-openclaw",
          localProvider: kind,
          model: "fixture-model",
        },
        env,
      );
      expect(count).toBe(2);
      expect(fetchMock).toHaveBeenCalledWith(
        `http://127.0.0.1:${port}/_nemoclaw/e2e-inference-receipt${query}`,
        expect.objectContaining({ headers: { authorization: `Bearer ${token}` } }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  },
);

it("rejects a receipt listener that does not match the configured local route", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  try {
    await expect(
      readProtectedLocalInferenceCount(
        {
          agent: "hermes",
          image: IMAGE,
          sandbox: "managed-openclaw",
          localProvider: "vllm",
          model: "fixture-model",
        },
        {
          NEMOCLAW_PROTECTED_INFERENCE_RECEIPT_PORT: "8001",
          NEMOCLAW_PROTECTED_INFERENCE_RECEIPT_TOKEN: "a".repeat(48),
        },
      ),
    ).rejects.toThrow("receipt authority is unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    fetchMock.mockRestore();
  }
});

it.each(["ollama", "nim", "vllm"] as const)(
  "uses host receipt authority without forwarding it to %s sandbox commands",
  async (localProvider) => {
    const token = "b".repeat(48);
    vi.stubEnv("NEMOCLAW_OLLAMA_PROXY_TOKEN", token);
    vi.stubEnv("NEMOCLAW_PROTECTED_INFERENCE_RECEIPT_TOKEN", token);
    vi.stubEnv("NEMOCLAW_PROTECTED_INFERENCE_RECEIPT_PORT", "8000");
    const env = buildOpenShellSandboxCreateEnvironment(process.env, { policyAttached: true });
    const runCommand = vi.fn<ManagedImageCommandRunner>(() => ({
      status: 0,
      stdout: "PONG",
      stderr: "",
    }));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ model: "fixture-model", completedRequests: 1 })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ model: "fixture-model", completedRequests: 2 })),
      );

    await expect(
      assertProtectedLocalInference(
        { openshellArgv: (args) => ["openshell", ...args] },
        {
          agent: "hermes",
          image: IMAGE,
          sandbox: "managed-hermes",
          localProvider,
          model: "fixture-model",
        },
        env,
        runCommand,
      ),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, options]) => options?.headers)).toEqual([
      { authorization: `Bearer ${token}` },
      { authorization: `Bearer ${token}` },
    ]);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand.mock.calls.map((call) => call[1])).toEqual([env, env]);
    expect(env).not.toHaveProperty("NEMOCLAW_OLLAMA_PROXY_TOKEN");
    expect(env).not.toHaveProperty("NEMOCLAW_PROTECTED_INFERENCE_RECEIPT_TOKEN");
    expect(env).not.toHaveProperty("NEMOCLAW_PROTECTED_INFERENCE_RECEIPT_PORT");
  },
);

it.each(["ollama", "nim", "vllm"] as const)(
  "stops before the %s agent turn when host receipt authority is absent",
  async (localProvider) => {
    vi.stubEnv("NEMOCLAW_OLLAMA_PROXY_TOKEN", undefined);
    vi.stubEnv("NEMOCLAW_PROTECTED_INFERENCE_RECEIPT_TOKEN", undefined);
    vi.stubEnv("NEMOCLAW_PROTECTED_INFERENCE_RECEIPT_PORT", undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const runCommand = vi.fn(() => ({ status: 0, stdout: "PONG", stderr: "" }));

    await expect(
      assertProtectedLocalInference(
        { openshellArgv: (args) => ["openshell", ...args] },
        {
          agent: "hermes",
          image: IMAGE,
          sandbox: "managed-hermes",
          localProvider,
          model: "fixture-model",
        },
        {},
        runCommand,
      ),
    ).rejects.toThrow("receipt authority is unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledTimes(1);
  },
);
