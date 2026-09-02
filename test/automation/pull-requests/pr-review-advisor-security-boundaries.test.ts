// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteBotOwnedStickyComments, upsertStickyComment } from "../../../tools/advisors/github.mts";
import { runReadOnlyAdvisor } from "../../../tools/advisors/session.mts";

const ROOT = path.resolve(import.meta.dirname, "../../..");


describe("PR review advisor security boundaries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes the model credential from the tool environment after in-memory setup", async () => {
    const credentialEnv = "PR_REVIEW_ADVISOR_TEST_API_KEY";
    vi.stubEnv(credentialEnv, "test-secret");
    const configDir = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-config-"));
    vi.spyOn(ModelRegistry.prototype, "find").mockReturnValue(undefined);

    try {
      await expect(
        runReadOnlyAdvisor({
          cwd: ROOT,
          promptTurns: [],
          systemPrompt: "test",
          configDir,
          htmlExportPath: path.join(configDir, "session.html"),
          timeoutMs: 1000,
          heartbeatMs: 1000,
          maxCaptureBytes: 1024,
          modelId: "missing-model",
          credentialEnv,
          logPrefix: "test",
          logProgress: () => undefined,
        }),
      ).rejects.toThrow(/Could not configure advisor model/);
      expect(process.env[credentialEnv]).toBeUndefined();
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("removes the model credential when in-memory setup fails", async () => {
    const credentialEnv = "PR_REVIEW_ADVISOR_SETUP_FAILURE_API_KEY";
    vi.stubEnv(credentialEnv, "test-secret");
    const configDir = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-config-"));
    vi.spyOn(ModelRegistry.prototype, "registerProvider").mockImplementation(() => {
      throw new Error("setup failed");
    });

    try {
      await expect(
        runReadOnlyAdvisor({
          cwd: ROOT,
          promptTurns: [],
          systemPrompt: "test",
          configDir,
          htmlExportPath: path.join(configDir, "session.html"),
          timeoutMs: 1000,
          heartbeatMs: 1000,
          maxCaptureBytes: 1024,
          modelId: "missing-model",
          credentialEnv,
          logPrefix: "test",
          logProgress: () => undefined,
        }),
      ).rejects.toThrow("setup failed");
      expect(process.env[credentialEnv]).toBeUndefined();
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("creates a bot-owned sticky comment when a user squats the marker", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          '[{"id":7,"body":"<!-- marker --> user text","user":{"login":"contributor"}}]',
      } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => '{"id":123}' } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => "{}" } as Response);

    await upsertStickyComment({
      repo: "NVIDIA/NemoClaw",
      pr: "1",
      token: "token",
      marker: "<!-- marker -->",
      body: "<!-- marker --> pending",
      label: "test",
      bodyForComment: (comment) => `<!-- marker --> comment_id=${comment.id}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("issues/1/comments");
    expect(String(fetchMock.mock.calls[1]?.[1]?.method)).toBe("POST");
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain("comments/7");
  });

  it("surfaces sticky comment publication permission failures", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, text: async () => "[]" } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "Resource not accessible by integration",
      } as Response);

    await expect(
      upsertStickyComment({
        repo: "NVIDIA/NemoClaw",
        pr: "1",
        token: "token",
        marker: "<!-- marker -->",
        body: "<!-- marker --> pending",
        label: "test",
      }),
    ).rejects.toThrow(/403.*Resource not accessible/);
  });

  it("deletes only bot-owned comments with legacy advisor markers", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify([
            {
              id: 10,
              body: "<!-- nemoclaw-e2e-advisor -->\nlegacy coverage",
              user: { login: "github-actions[bot]" },
            },
            {
              id: 11,
              body: "<!-- nemoclaw-e2e-target-advisor -->\nlegacy targets",
              user: { login: "github-actions[bot]" },
            },
            {
              id: 12,
              body: "<!-- nemoclaw-e2e-advisor -->\ncontributor text",
              user: { login: "contributor" },
            },
            {
              id: 13,
              body: "prefix <!-- nemoclaw-e2e-advisor -->",
              user: { login: "github-actions[bot]" },
            },
          ]),
      } as Response)
      .mockResolvedValue({ ok: true, text: async () => "" } as Response);

    await expect(
      deleteBotOwnedStickyComments({
        repo: "NVIDIA/NemoClaw",
        pr: "1",
        token: "token",
        markers: ["<!-- nemoclaw-e2e-advisor -->", "<!-- nemoclaw-e2e-target-advisor -->"],
        label: "legacy E2E advisor",
      }),
    ).resolves.toBe(2);

    const deletes = fetchMock.mock.calls.filter(
      ([, options]) => (options as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deletes.map(([input]) => String(input))).toEqual([
      expect.stringContaining("issues/comments/10"),
      expect.stringContaining("issues/comments/11"),
    ]);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("comments/12"))).toBe(
      false,
    );
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("comments/13"))).toBe(
      false,
    );
  });

  it("does not query comments when no retirement markers are provided", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      deleteBotOwnedStickyComments({
        repo: "NVIDIA/NemoClaw",
        pr: "1",
        token: "token",
        markers: [],
        label: "legacy E2E advisor",
      }),
    ).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

});
