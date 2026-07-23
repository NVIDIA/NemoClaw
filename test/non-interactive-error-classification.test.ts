// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "./helpers/langchain-deepagents-code-patch-fixture";

afterEach(cleanupPackageFixtures);

describe("non-interactive error classification patch", () => {
  it("injects classification infrastructure into non_interactive.py", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);

    const source = fs.readFileSync(
      path.join(tempDir, "deepagents_code", "client", "non_interactive.py"),
      "utf8",
    );

    expect(source).toContain("_NEMOCLAW_KNOWN_PROVIDER_ERRORS");
    expect(source).toContain("_nemoclaw_classify_non_interactive_error");
    expect(source).toContain("nemoclaw.managed.non_interactive");
  });

  it("produces valid Python syntax after patching", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);

    const source = fs.readFileSync(
      path.join(tempDir, "deepagents_code", "client", "non_interactive.py"),
      "utf8",
    );

    const result = spawnSync("python3", ["-c", `compile(${JSON.stringify(source)}, "<test>", "exec")`], {
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
  });

  it("classifies known provider errors correctly", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);

    const source = fs.readFileSync(
      path.join(tempDir, "deepagents_code", "client", "non_interactive.py"),
      "utf8",
    );

    const driver = [
      source,
      "",
      "# Test driver: exercise classifier against sample exceptions",
      "cases = [",
      "    (RuntimeError('ResourceExhausted: Worker local total request limit reached'), 'upstream_provider_capacity', True),",
      "    (RuntimeError('RateLimitError: 429 Too Many Requests'), 'upstream_rate_limit', True),",
      "    (RuntimeError('request timeout after 30s'), 'upstream_timeout', True),",
      "    (RuntimeError('DeadlineExceeded'), 'upstream_timeout', True),",
      "    (ConnectionError('connection refused'), 'upstream_connection', True),",
      "    (RuntimeError('unknown kaboom'), None, None),",
      "]",
      "for exc, expected_cat, expected_retry in cases:",
      "    result = _nemoclaw_classify_non_interactive_error(exc)",
      "    if expected_cat is None:",
      "        assert result is None, f'Expected None for {exc!r}, got {result}'",
      "    else:",
      "        assert result is not None, f'Expected classification for {exc!r}, got None'",
      "        cat, retry = result",
      "        assert cat == expected_cat, f'Expected {expected_cat}, got {cat} for {exc!r}'",
      "        assert retry == expected_retry, f'Expected {expected_retry}, got {retry} for {exc!r}'",
      "print('All classifier tests passed')",
    ].join("\n");

    const result = spawnSync("python3", ["-c", driver], { timeout: 10_000 });
    expect(result.stderr.toString()).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.toString().trim()).toBe("All classifier tests passed");
  });
});
