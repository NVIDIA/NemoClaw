// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenShellTools } from "../../../tools/openshell-agent/runtime.mts";
import {
  createAdvisorRepairSandbox,
  deleteAdvisorRepairSandbox,
  reconcilePreviousAdvisorRepairSandbox,
} from "../../../tools/pr-review-advisor/repair-resolve.mts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-repair-retry-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function toolsWith(outputs: string[]): OpenShellTools {
  return {
    run: vi.fn(() => outputs.shift() ?? ""),
    runAsync: vi.fn(() => ({ cancel: vi.fn(), completion: Promise.resolve() })),
    start: vi.fn(),
    wait: vi.fn(async () => undefined),
  };
}

function environment(attempt: number): NodeJS.ProcessEnv {
  return {
    GITHUB_RUN_ATTEMPT: String(attempt),
    GITHUB_RUN_ID: "12345",
    HOME: temporaryDirectory(),
    OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:8080",
    PATH: "/usr/bin",
    PI_IMAGE: "pi-image",
    RESOLUTION_WORKDIR: "/resolution",
    RESOLVER_CONFIG_DIR: "/config",
    SANDBOX_NAME: `advisor-repair-12345-${attempt}`,
    TRUSTED_CHECKOUT: "/trusted",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  temporaryDirectories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true }));
});

describe("PR Review Advisor repair retries", () => {
  it("removes the prior owned sandbox before creating its replacement (#10791)", () => {
    const failedCleanupTools = toolsWith(["advisor-repair-12345-1"]);
    vi.mocked(failedCleanupTools.run)
      .mockImplementationOnce(() => "advisor-repair-12345-1")
      .mockImplementationOnce(() => {
        throw new Error("cleanup failed");
      });
    expect(() =>
      deleteAdvisorRepairSandbox(
        environment(1),
        path.join(temporaryDirectory(), "failed-cleanup.json"),
        failedCleanupTools,
      ),
    ).toThrow("cleanup failed");

    const receiptFile = path.join(temporaryDirectory(), "reconciliation.json");
    const retryTools = toolsWith(["advisor-repair-12345-1", "", ""]);
    reconcilePreviousAdvisorRepairSandbox(environment(2), receiptFile, retryTools);
    createAdvisorRepairSandbox(environment(2), retryTools);

    const calls = vi.mocked(retryTools.run).mock.calls;
    expect(calls[0]?.[1]).toEqual(["sandbox", "list", "--names"]);
    expect(calls[1]?.[1]).toEqual(["sandbox", "delete", "advisor-repair-12345-1"]);
    expect(calls[2]?.[1]).toEqual(
      expect.arrayContaining(["sandbox", "create", "--name", "advisor-repair-12345-2"]),
    );
    expect(JSON.parse(fs.readFileSync(receiptFile, "utf8"))).toEqual({
      version: 1,
      sandboxName: "advisor-repair-12345-1",
      outcome: "success",
      error: null,
    });
  });
});
