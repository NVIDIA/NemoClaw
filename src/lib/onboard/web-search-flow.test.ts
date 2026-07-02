// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testTimeoutOptions } from "../../../test/helpers/timeouts";
import { runCurlProbe } from "../adapters/http/probe";
import { isBackToSelection } from "./credential-navigation";
import { createWebSearchFlowHelpers } from "./web-search-flow";

vi.mock("../adapters/http/probe", () => ({
  runCurlProbe: vi.fn(() => ({
    ok: true,
    httpStatus: 200,
    curlStatus: 0,
    body: "{}",
    stderr: "",
    message: "ok",
  })),
}));

vi.mock("../runner", () => ({
  ROOT: "/tmp/nemoclaw-web-search-flow-test",
}));

function braveProbeTempDirs(): string[] {
  return fs
    .readdirSync(os.tmpdir())
    .filter((entry) => entry.startsWith("nemoclaw-brave-probe-"))
    .sort();
}

function helpers() {
  return createWebSearchFlowHelpers({
    prompt: async () => "",
    note: () => {},
    isNonInteractive: () => true,
    cliName: () => "nemoclaw",
    runCaptureOpenshell: () => null,
  });
}

describe("Brave key prompt empty-input escape (#6025)", () => {
  it("surfaces the back/exit hint on empty input and loops instead of dead-ending", async () => {
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      errors.push(String(message));
    });
    const responses = ["", "back"];
    let call = 0;
    const flow = createWebSearchFlowHelpers({
      prompt: async () => responses[call++] ?? "back",
      note: () => {},
      isNonInteractive: () => false,
      cliName: () => "nemoclaw",
      runCaptureOpenshell: () => null,
    });

    const result = await flow.promptBraveSearchApiKey();
    errSpy.mockRestore();

    expect(isBackToSelection(result)).toBe(true);
    expect(call).toBe(2);
    const errorText = errors.join("\n");
    expect(errorText).toContain("Brave Search API key is required.");
    // Assert both escape routes independently so the test fails if either the
    // "back" or the "exit" hint regresses, not just when both disappear (#6025).
    expect(errorText).toContain("back to choose a different option");
    expect(errorText).toContain("exit to quit");
  });
});

describe("web search flow Brave validation", () => {
  beforeEach(() => {
    vi.mocked(runCurlProbe).mockClear();
  });

  it.each([
    ["LF", "brv-good-prefix\nconfig = injected"],
    ["CR", "brv-good-prefix\rconfig = injected"],
  ])(
    "rejects %s-bearing keys before writing a trusted curl config",
    testTimeoutOptions(15_000),
    (_label, apiKey) => {
      const before = braveProbeTempDirs();

      const result = helpers().validateBraveSearchApiKey(apiKey);

      expect(result.ok).toBe(false);
      expect(result.message).toContain("must not contain line breaks");
      expect(runCurlProbe).not.toHaveBeenCalled();
      expect(braveProbeTempDirs()).toEqual(before);
    },
  );
});
