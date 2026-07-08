// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { getAgentChoices, loadAgent } from "../agent/defs";
import { resolveAgent } from "../agent/onboard";
import { createSelectOnboardAgent } from "./agent-selection";
import { selectFromNumberedMenuOrExit } from "./prompt-helpers";

// Exercises the real agent registry (agents/openclaw + agents/hermes) so the
// red->green transition reflects genuine wizard behavior rather than a mock.
function makeSelectOnboardAgent(reply: string) {
  const prompt = vi.fn(async (_question: string) => reply);
  const log = vi.fn((_message?: string) => {});
  const select = createSelectOnboardAgent({
    resolveAgent,
    loadAgent,
    getAgentChoices,
    isNonInteractive: () => false,
    note: () => {},
    log,
    prompt,
    selectFromNumberedMenu: selectFromNumberedMenuOrExit,
  });
  return { select, prompt, log };
}

describe("selectOnboardAgent interactive agent selection", () => {
  beforeEach(() => {
    delete process.env.NEMOCLAW_AGENT;
  });

  afterEach(() => {
    delete process.env.NEMOCLAW_AGENT;
  });

  it("presents both OpenClaw and Hermes and honors a Hermes selection", async () => {
    // Derive Hermes' menu position from the real registry so the test stays
    // correct if another agent is later sorted ahead of Hermes.
    const choices = getAgentChoices();
    const hermesPosition = choices.findIndex((choice) => choice.name === "hermes") + 1;
    assert.ok(hermesPosition > 0, "expected Hermes in the agent registry");
    const { select, prompt, log } = makeSelectOnboardAgent(String(hermesPosition));

    const agent = await select({ canPrompt: true });

    assert.equal(agent?.name, "hermes");
    assert.equal(prompt.mock.calls.length, 1);
    const menu = log.mock.calls.map((call) => call[0]).join("\n");
    assert.match(menu, /OpenClaw/);
    assert.match(menu, /Hermes/);
  });

  it("defaults to the OpenClaw path when the user accepts the default", async () => {
    const { select } = makeSelectOnboardAgent("");

    const agent = await select({ canPrompt: true });

    // The OpenClaw default path is represented by a null agent downstream.
    assert.equal(agent, null);
  });

  it("skips the picker when an explicit --agent flag is provided", async () => {
    const { select, prompt } = makeSelectOnboardAgent("1");

    const agent = await select({ agentFlag: "hermes", canPrompt: true });

    assert.equal(agent?.name, "hermes");
    assert.equal(prompt.mock.calls.length, 0);
  });

  it("does not re-prompt when resuming an OpenClaw session", async () => {
    // Resume honors the recorded agent; the OpenClaw default is stored as a
    // null session agent, so the picker must stay hidden rather than risk an
    // accidental agent change.
    const { select, prompt } = makeSelectOnboardAgent("2");

    const agent = await select({ resume: true, canPrompt: true });

    assert.equal(agent, null);
    assert.equal(prompt.mock.calls.length, 0);
  });
});
