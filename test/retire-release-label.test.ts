// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

function runRetireReleaseLabel(fakeGh: string, args = ["v1.2.3"]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retire-release-label-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const ghPath = path.join(bin, "gh");
  fs.writeFileSync(ghPath, fakeGh);
  fs.chmodSync(ghPath, 0o755);
  try {
    return spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "scripts/retire-release-label.mts", ...args],
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

describe("released label retirement", () => {
  it("moves open work before deleting the released label", () => {
    const result = runRetireReleaseLabel(`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "api repos/NVIDIA/NemoClaw/git/matching-refs/tags/v1.2.4")
    printf '[{"ref":"refs/tags/v1.2.40"}]' ;;
  "label list"*"--search v1.2.4"*) printf '[]' ;;
  "label create v1.2.4"*) ;;
  "label list"*"--search v1.2.3"*)
    if test -f "$0.deleted"; then printf '[]'; else printf '[{"name":"v1.2.3"}]'; fi ;;
  "pr list"*)
    if test -f "$0.pr-moved"; then printf '[]'; else printf '[{"number":42,"title":"needs more work"}]'; fi ;;
  "pr edit 42"*) : > "$0.pr-moved" ;;
  "issue list"*)
    if test -f "$0.issue-moved"; then printf '[]'; else printf '[{"number":84,"title":"still open"}]'; fi ;;
  "issue edit 84"*) : > "$0.issue-moved" ;;
  "label delete v1.2.3"*)
    test -f "$0.pr-moved"
    test -f "$0.issue-moved"
    : > "$0.deleted" ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      from: "v1.2.3",
      to: "v1.2.4",
      moved: [
        { number: 42, title: "needs more work", type: "pr" },
        { number: 84, title: "still open", type: "issue" },
      ],
      retired: true,
    });
  });

  it("treats an already-absent released label as retired", () => {
    const result = runRetireReleaseLabel(`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "label list"*"--search v1.2.3"*) printf '[]' ;;
  "label create"*) echo 'label create must not run' >&2; exit 9 ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      from: "v1.2.3",
      to: "v1.2.4",
      moved: [],
      retired: true,
    });
  });

  it("refuses deletion while an open item still carries the released label", () => {
    const result = runRetireReleaseLabel(`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "api repos/NVIDIA/NemoClaw/git/matching-refs/tags/v1.2.4") printf '[]' ;;
  "label list"*"--search v1.2.4"*) printf '[{"name":"v1.2.4"}]' ;;
  "label list"*"--search v1.2.3"*) printf '[{"name":"v1.2.3"}]' ;;
  "pr list"*) printf '[{"number":42,"title":"still labeled"}]' ;;
  "pr edit 42"*) ;;
  "issue list"*) printf '[]' ;;
  "label delete"*) echo 'delete must not run' >&2; exit 9 ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to delete v1.2.3");
    expect(result.stderr).toContain("PR #42");
    expect(result.stdout).toBe("");
  });

  it("fails visibly when deleting the released label fails", () => {
    const result = runRetireReleaseLabel(`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "api repos/NVIDIA/NemoClaw/git/matching-refs/tags/v1.2.4") printf '[]' ;;
  "label list"*"--search v1.2.4"*) printf '[{"name":"v1.2.4"}]' ;;
  "label list"*"--search v1.2.3"*) printf '[{"name":"v1.2.3"}]' ;;
  "pr list"*|"issue list"*) printf '[]' ;;
  "label delete v1.2.3"*) echo 'permission denied' >&2; exit 7 ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("permission denied");
    expect(result.stdout).toBe("");
  });

  it("fails when GitHub still returns the label after deletion", () => {
    const result = runRetireReleaseLabel(`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "api repos/NVIDIA/NemoClaw/git/matching-refs/tags/v1.2.4") printf '[]' ;;
  "label list"*"--search v1.2.4"*) printf '[{"name":"v1.2.4"}]' ;;
  "label list"*"--search v1.2.3"*) printf '[{"name":"v1.2.3"}]' ;;
  "pr list"*|"issue list"*) printf '[]' ;;
  "label delete v1.2.3"*) ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("still exists after deletion");
    expect(result.stdout).toBe("");
  });

  it.each([
    [["1.2.3"], "Invalid released version"],
    [["v1.2.3", "--repo", "invalid"], "Invalid --repo value"],
    [[], "Usage: retire-release-label.mts"],
  ])("rejects invalid arguments", (args, error) => {
    const result = runRetireReleaseLabel("#!/usr/bin/env bash\nexit 9\n", args);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
  });

  it("rejects an unincrementable version before calling GitHub", () => {
    const result = runRetireReleaseLabel(
      "#!/usr/bin/env bash\necho 'gh must not run' >&2\nexit 9\n",
      [`v1.2.${Number.MAX_SAFE_INTEGER}`],
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot increment release version");
    expect(result.stderr).not.toContain("gh must not run");
  });

  it("refuses to carry work to a version whose remote tag already exists", () => {
    const result = runRetireReleaseLabel(`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "label list"*"--search v1.2.3"*) printf '[{"name":"v1.2.3"}]' ;;
  "api repos/NVIDIA/NemoClaw/git/matching-refs/tags/v1.2.4")
    printf '[{"ref":"refs/tags/v1.2.4"}]' ;;
  "label list"*"--search v1.2.4"*|"label create"*)
    echo 'target label lookup or creation must not run' >&2; exit 9 ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to use release target v1.2.4");
    expect(result.stderr).not.toContain("target label lookup or creation must not run");
    expect(result.stdout).toBe("");
  });

  it("fails visibly when a label lookup fails", () => {
    const result = runRetireReleaseLabel(`#!/usr/bin/env bash
set -euo pipefail
echo 'auth failed' >&2
exit 4
`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("auth failed");
    expect(result.stdout).toBe("");
  });
});
