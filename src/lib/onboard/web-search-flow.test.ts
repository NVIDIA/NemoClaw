// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCurlProbe } from "../adapters/http/probe";
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

describe("web search flow Brave validation", () => {
  beforeEach(() => {
    vi.mocked(runCurlProbe).mockClear();
  });

  it.each([
    ["LF", "brv-good-prefix\nconfig = injected"],
    ["CR", "brv-good-prefix\rconfig = injected"],
  ])("rejects %s-bearing keys before writing a trusted curl config", (_label, apiKey) => {
    const before = braveProbeTempDirs();

    const result = helpers().validateBraveSearchApiKey(apiKey);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("must not contain line breaks");
    expect(runCurlProbe).not.toHaveBeenCalled();
    expect(braveProbeTempDirs()).toEqual(before);
  });
});
