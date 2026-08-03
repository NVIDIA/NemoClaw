// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { crossOnboardIntentDraftBoundary } from "./boundary";
import { createOnboardIntentDraft } from "./schema";

describe("onboarding review/materialization boundary (#6005)", () => {
  it("does not start materialization until the collector returns Apply", async () => {
    const events: string[] = [];
    const mutations = {
      registerProvider: vi.fn(),
      configureGateway: vi.fn(),
      runDocker: vi.fn(),
      writeSandboxFilesystem: vi.fn(),
    };
    const accepted = {
      ...createOnboardIntentDraft({ agent: "openclaw" }),
      phase: "accepted" as const,
    };

    const result = await crossOnboardIntentDraftBoundary({
      shouldCollect: true,
      existingDraft: null,
      initialDraft: createOnboardIntentDraft(),
      collect: async () => {
        expect(events).toEqual([]);
        for (const mutate of Object.values(mutations)) expect(mutate).not.toHaveBeenCalled();
        events.push("reviewed-and-applied");
        return { kind: "apply", draft: accepted };
      },
      accept: async () => {
        mutations.registerProvider();
        mutations.configureGateway();
        mutations.runDocker();
        mutations.writeSandboxFilesystem();
        events.push("materialization-projected");
      },
    });

    expect(result).toEqual({ kind: "continue", draft: accepted });
    expect(events).toEqual(["reviewed-and-applied", "materialization-projected"]);
    for (const mutate of Object.values(mutations)) expect(mutate).toHaveBeenCalledOnce();
  });

  it("never projects materialization when the user exits review", async () => {
    const partial = createOnboardIntentDraft({ agent: "hermes" });
    const accept = vi.fn();

    const result = await crossOnboardIntentDraftBoundary({
      shouldCollect: true,
      existingDraft: partial,
      initialDraft: createOnboardIntentDraft(),
      collect: async (initial) => ({ kind: "exit", draft: initial }),
      accept,
    });

    expect(result).toEqual({ kind: "exit", draft: partial });
    expect(accept).not.toHaveBeenCalled();
  });

  it("resumes the saved partial draft and accepts an already reviewed draft", async () => {
    const partial = createOnboardIntentDraft({ agent: "hermes" });
    const accepted = { ...partial, phase: "accepted" as const };
    const collect = vi.fn(async () => ({ kind: "apply" as const, draft: accepted }));
    const accept = vi.fn();

    await crossOnboardIntentDraftBoundary({
      shouldCollect: true,
      existingDraft: partial,
      initialDraft: createOnboardIntentDraft(),
      collect,
      accept,
    });
    expect(collect).toHaveBeenCalledWith(partial);
    expect(accept).toHaveBeenCalledWith(accepted);

    collect.mockClear();
    accept.mockClear();
    await crossOnboardIntentDraftBoundary({
      shouldCollect: false,
      existingDraft: accepted,
      initialDraft: createOnboardIntentDraft(),
      collect,
      accept,
    });
    expect(collect).not.toHaveBeenCalled();
    expect(accept).toHaveBeenCalledWith(accepted);
  });

  it("rejects a partial draft when collection is disabled", async () => {
    const partial = createOnboardIntentDraft({ agent: "hermes" });
    const collect = vi.fn();
    const accept = vi.fn();

    await expect(
      crossOnboardIntentDraftBoundary({
        shouldCollect: false,
        existingDraft: partial,
        initialDraft: createOnboardIntentDraft(),
        collect,
        accept,
      }),
    ).rejects.toThrow("before it is reviewed and accepted");

    expect(collect).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });
});
