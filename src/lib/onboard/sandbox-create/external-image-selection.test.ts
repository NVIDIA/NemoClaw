// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { confirmExternalImageSelection, persistExternalImageToolDisclosure } from "./orchestration";

describe("external image sandbox creation", () => {
  it("persists an adopted direct disclosure for later resume", () => {
    const session = { toolDisclosure: "progressive" } as never;
    const updateSession = vi.fn((mutator: (current: typeof session) => typeof session | void) => {
      return mutator(session) ?? session;
    });

    expect(persistExternalImageToolDisclosure("direct", updateSession as never)).toBe("direct");
    expect(session).toMatchObject({ toolDisclosure: "direct" });
    expect(updateSession).toHaveBeenCalledOnce();
  });

  const reference = `ghcr.io/example/openclaw@sha256:${"a".repeat(64)}`;
  const base = {
    sandboxName: "alpha",
    requestedReference: reference,
    existingState: "ready",
    existingWorkload: undefined,
    recreate: false,
    nonInteractive: false,
    error: vi.fn(),
    exitProcess: vi.fn(() => {
      throw new Error("exit");
    }),
  };

  it("reuses a matching ready external image without prompting", async () => {
    const prompt = vi.fn(async () => false);

    await expect(
      confirmExternalImageSelection({ ...base, matches: () => true, prompt }),
    ).resolves.toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("requires confirmation before replacing a different ready image", async () => {
    const prompt = vi.fn(async () => true);

    await expect(
      confirmExternalImageSelection({ ...base, matches: () => false, prompt }),
    ).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledOnce();
  });
});
