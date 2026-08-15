// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  bindApprovedPrBaseForBaseImageComparison,
  readApprovedPrBaseSha,
} from "../live/pr-base-comparison.ts";

const BASE_SHA = "0d1cb93888c817daec44b2cc996afa75eebcbd46";
const temporaryDirectories: string[] = [];

function eventEnvironment(baseSha: unknown): NodeJS.ProcessEnv {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-base-"));
  temporaryDirectories.push(directory);
  const eventPath = path.join(directory, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify({ inputs: { base_sha: baseSha } }));
  return { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: eventPath };
}

function result(stdout = "", exitCode = 0): ShellProbeResult {
  return {
    artifacts: { result: "", stderr: "", stdout: "" },
    command: ["git"],
    exitCode,
    signal: null,
    stderr: "",
    stdout,
    timedOut: false,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("trusted PR base comparison", () => {
  it("ignores non-dispatch and empty-base runs", () => {
    expect(readApprovedPrBaseSha({ GITHUB_EVENT_NAME: "push" })).toBeNull();
    expect(readApprovedPrBaseSha(eventEnvironment(""))).toBeNull();
  });

  it("does not read the dispatch event when cold measurement is disabled", async () => {
    const command = vi.fn();
    await bindApprovedPrBaseForBaseImageComparison({ command }, false, {
      GITHUB_EVENT_NAME: "workflow_dispatch",
    });
    expect(command).not.toHaveBeenCalled();
  });

  it("rejects an invalid dispatch base before running Git", async () => {
    const command = vi.fn();
    await expect(
      bindApprovedPrBaseForBaseImageComparison({ command }, true, eventEnvironment("main")),
    ).rejects.toThrow("base_sha must be a lowercase 40-character commit SHA");
    expect(command).not.toHaveBeenCalled();
  });

  it("fetches and verifies the approved base before updating the comparison ref", async () => {
    const command = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result(`${BASE_SHA}\n`))
      .mockResolvedValueOnce(result());

    await bindApprovedPrBaseForBaseImageComparison({ command }, true, eventEnvironment(BASE_SHA));

    expect(command.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [
        "git",
        ["fetch", "--no-tags", "--depth=1", "https://github.com/NVIDIA/NemoClaw.git", BASE_SHA],
      ],
      ["git", ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]],
      ["git", ["update-ref", "refs/remotes/origin/main", BASE_SHA]],
    ]);
  });

  it("does not update the comparison ref when the fetched commit differs", async () => {
    const command = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result(`${"f".repeat(40)}\n`));

    await expect(
      bindApprovedPrBaseForBaseImageComparison({ command }, true, eventEnvironment(BASE_SHA)),
    ).rejects.toThrow("did not match");
    expect(command).toHaveBeenCalledTimes(2);
  });
});
