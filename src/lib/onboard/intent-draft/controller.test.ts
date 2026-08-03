// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  assertDraftNavigationAllowed,
  assertDraftRevisionAllowed,
  collectIntentDraft,
  type DraftPromptResult,
  type DraftStep,
} from "./controller";

type StepId = "agent" | "provider" | "model";
type Draft = Partial<Record<StepId, string>>;

function answer(value: string): DraftPromptResult<string> {
  return { kind: "answer", value };
}

function fail(message: string): never {
  throw new Error(message);
}

function makeSteps(
  replies: Record<StepId, DraftPromptResult<string>[]>,
  visits: StepId[],
): DraftStep<StepId, Draft, unknown>[] {
  return (["agent", "provider", "model"] as const).map((id) => ({
    id,
    label: id,
    read: (draft: Draft) => draft[id],
    write: (draft: Draft, value: unknown) => ({ ...draft, [id]: String(value) }),
    prompt: async () => {
      visits.push(id);
      return replies[id].shift() ?? fail(`Missing reply for ${id}`);
    },
  }));
}

describe("onboarding intent draft navigation (#6005)", () => {
  it("walks Back repeatedly to step one and then reaches review", async () => {
    const visits: StepId[] = [];
    const steps = makeSteps(
      {
        agent: [answer("openclaw"), answer("hermes")],
        provider: [answer("build"), { kind: "back" }, answer("build")],
        model: [{ kind: "back" }, answer("nemotron")],
      },
      visits,
    );
    const review = vi.fn(async () => ({ kind: "apply" }) as const);

    const result = await collectIntentDraft({
      steps,
      initialDraft: {},
      review,
      reconcile: ({ next }) => next,
    });

    expect(visits).toEqual(["agent", "provider", "model", "provider", "agent", "model"]);
    expect(result).toEqual({
      kind: "apply",
      draft: { agent: "hermes", provider: "build", model: "nemotron" },
    });
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("jumps from review to step one and immediately returns when later answers remain compatible", async () => {
    const visits: StepId[] = [];
    const steps = makeSteps(
      {
        agent: [answer("hermes")],
        provider: [],
        model: [],
      },
      visits,
    );
    const review = vi
      .fn()
      .mockResolvedValueOnce({ kind: "edit", step: "agent" })
      .mockResolvedValueOnce({ kind: "apply" });

    const result = await collectIntentDraft({
      steps,
      initialDraft: { agent: "openclaw", provider: "build", model: "nemotron" },
      review,
      reconcile: ({ next }) => next,
    });

    expect(visits).toEqual(["agent"]);
    expect(review).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ kind: "apply", draft: { agent: "hermes" } });
  });

  it("reopens only answers invalidated by a direct edit", async () => {
    const visits: StepId[] = [];
    const steps = makeSteps(
      {
        agent: [answer("hermes")],
        provider: [answer("hermesProvider")],
        model: [answer("claude")],
      },
      visits,
    );
    const review = vi
      .fn()
      .mockResolvedValueOnce({ kind: "edit", step: "agent" })
      .mockResolvedValueOnce({ kind: "apply" });

    const result = await collectIntentDraft({
      steps,
      initialDraft: { agent: "openclaw", provider: "openai", model: "gpt-5" },
      review,
      reconcile: ({ previous, next, changedStep }) =>
        changedStep === "agent" && previous.agent !== next.agent
          ? { ...next, provider: undefined, model: undefined }
          : next,
    });

    expect(visits).toEqual(["agent", "provider", "model"]);
    expect(result).toEqual({
      kind: "apply",
      draft: { agent: "hermes", provider: "hermesProvider", model: "claude" },
    });
  });

  it("resumes at the first missing secret-free answer and checkpoints each answer", async () => {
    const visits: StepId[] = [];
    const checkpoint = vi.fn();
    const steps = makeSteps(
      {
        agent: [],
        provider: [answer("build")],
        model: [answer("nemotron")],
      },
      visits,
    );

    await collectIntentDraft({
      steps,
      initialDraft: { agent: "openclaw" },
      review: async () => ({ kind: "apply" }),
      reconcile: ({ next }) => next,
      checkpoint,
    });

    expect(visits).toEqual(["provider", "model"]);
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(checkpoint).toHaveBeenLastCalledWith({
      agent: "openclaw",
      provider: "build",
      model: "nemotron",
    });
  });

  it("returns an exit intent without calling process.exit", async () => {
    const visits: StepId[] = [];
    const steps = makeSteps(
      {
        agent: [{ kind: "exit" }],
        provider: [],
        model: [],
      },
      visits,
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const result = await collectIntentDraft({
      steps,
      initialDraft: {},
      review: async () => ({ kind: "apply" }),
      reconcile: ({ next }) => next,
    });

    expect(result).toEqual({ kind: "exit", draft: {} });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("refuses Back once materialization has started", () => {
    expect(() => assertDraftNavigationAllowed("collecting", "nemoclaw")).not.toThrow();
    expect(() => assertDraftNavigationAllowed("materializing", "nemoclaw")).toThrow(
      "Back navigation is unavailable after Apply configuration",
    );
  });

  it("refuses a post-Apply retry that would revisit an accepted choice", () => {
    expect(() =>
      assertDraftRevisionAllowed("materializing", "the Ollama model", "nemoclaw"),
    ).toThrow(
      "Cannot change the Ollama model after Apply configuration. Use `nemoclaw <sandbox-name> rebuild`",
    );
  });
});
