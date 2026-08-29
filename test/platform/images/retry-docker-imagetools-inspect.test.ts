// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const inspector = path.join(repoRoot, "scripts/checks/retry-docker-imagetools-inspect.sh");
const reference = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`;

function runInspector(failures: number) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-image-inspect-"));
  const fakeBin = path.join(temporaryRoot, "bin");
  const countFile = path.join(temporaryRoot, "count");
  const argsFile = path.join(temporaryRoot, "args");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
count=0
if [ -f "$COUNT_FILE" ]; then
  count="$(cat "$COUNT_FILE")"
fi
count=$((count + 1))
printf '%s\n' "$count" >"$COUNT_FILE"
printf '%s\n' "$*" >>"$ARGS_FILE"
if [ "$count" -le "$FAILURES" ]; then
  echo "failed to authorize: token request returned 403 Forbidden" >&2
  exit 42
fi
printf '{"schemaVersion":2}\n'
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(fakeBin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  try {
    const result = spawnSync(inspector, [reference, "--raw"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ARGS_FILE: argsFile,
        COUNT_FILE: countFile,
        FAILURES: String(failures),
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    return {
      ...result,
      args: fs.readFileSync(argsFile, "utf8").trim().split("\n"),
      count: Number(fs.readFileSync(countFile, "utf8").trim()),
    };
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

describe("retry-docker-imagetools-inspect", () => {
  it("recovers from a transient registry authorization failure", () => {
    const result = runInspector(2);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('{"schemaVersion":2}\n');
    expect(result.count).toBe(3);
    expect(result.args).toEqual(
      Array.from({ length: 3 }, () => `buildx imagetools inspect ${reference} --raw`),
    );
    expect(result.stderr).toContain("attempt 1/5");
    expect(result.stderr).toContain("attempt 2/5");
  });

  it("returns the registry failure after the bounded attempts", () => {
    const result = runInspector(5);

    expect(result.status).toBe(42);
    expect(result.count).toBe(5);
    expect(result.stderr).toContain("failed after 5 attempts");
  });
});
