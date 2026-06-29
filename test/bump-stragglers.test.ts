// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

function runBumpStragglers(fakeGh: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bump-stragglers-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const ghPath = path.join(bin, "gh");
  fs.writeFileSync(ghPath, fakeGh);
  fs.chmodSync(ghPath, 0o755);
  try {
    return spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        ".agents/skills/nemoclaw-maintainer-day/scripts/bump-stragglers.ts",
        "v1.2.3",
        "v1.2.4",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf-8",
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("bump-stragglers release housekeeping", () => {
  it("creates the next label and moves open PRs and issues", () => {
    const result = runBumpStragglers(`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "label list"*) printf '[]' ;;
  "label create v1.2.4"*) ;;
  "pr list"*) printf '[{"number":42,"title":"needs more work"}]' ;;
  "pr edit 42"*) ;;
  "issue list"*) printf '[{"number":84,"title":"still open"}]' ;;
  "issue edit 84"*) ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      from: "v1.2.3",
      to: "v1.2.4",
      bumped: [
        { number: 42, title: "needs more work", type: "pr" },
        { number: 84, title: "still open", type: "issue" },
      ],
    });
  });

  it("fails visibly when gh label lookup fails", () => {
    const result = runBumpStragglers(`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "label list"*) echo 'auth failed' >&2; exit 4 ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("auth failed");
    expect(result.stdout).toBe("");
  });

  it("fails visibly when gh returns non-array JSON", () => {
    const result = runBumpStragglers(`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "label list"*) printf '{}' ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected JSON array");
    expect(result.stdout).toBe("");
  });

  it("does not create the target label when it already exists", () => {
    const result = runBumpStragglers(`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "label list"*) printf '[{"name":"v1.2.4"}]' ;;
  "label create"*) echo 'label create should not run' >&2; exit 9 ;;
  "pr list"*) printf '[]' ;;
  "issue list"*) printf '[]' ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ from: "v1.2.3", to: "v1.2.4", bumped: [] });
  });

  it("fails visibly when gh returns invalid JSON", () => {
    const result = runBumpStragglers(`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "label list"*) printf '[{"name":"v1.2.4"}]' ;;
  "pr list"*) printf 'not-json' ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Failed to parse gh JSON output");
    expect(result.stdout).toBe("");
  });

  it("fails visibly when a GitHub PR edit command fails", () => {
    const result = runBumpStragglers(`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "label list"*) printf '[{"name":"v1.2.4"}]' ;;
  "pr list"*) printf '[{"number":42,"title":"needs more work"}]' ;;
  "pr edit"*) echo 'auth failed' >&2; exit 7 ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("auth failed");
    expect(result.stdout).toBe("");
  });

  it("fails visibly when a GitHub issue edit command fails", () => {
    const result = runBumpStragglers(`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "label list"*) printf '[{"name":"v1.2.4"}]' ;;
  "pr list"*) printf '[]' ;;
  "issue list"*) printf '[{"number":84,"title":"still open"}]' ;;
  "issue edit"*) echo 'permission denied' >&2; exit 7 ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("permission denied");
    expect(result.stdout).toBe("");
  });
});
