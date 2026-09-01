// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const SHA_AMD64 = "a".repeat(64);
const SHA_ARM64 = "b".repeat(64);
const SHA_CANDIDATE = `sha256:${"c".repeat(64)}`;
const SHA_PUBLISHED = `sha256:${"d".repeat(64)}`;
const helper = resolve(
  import.meta.dirname,
  "../../../.github/actions/publish-base-image-manifest/publish.sh",
);
const tagHelper = resolve(
  import.meta.dirname,
  "../../../.github/actions/publish-base-image-manifest/tags.sh",
);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function executable(file: string, content: string): void {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

function runManifest({
  digestFiles,
  wrongPlatform = false,
  publicationMismatch = false,
}: {
  digestFiles: string[];
  wrongPlatform?: boolean;
  publicationMismatch?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-base-manifest-"));
  temporaryRoots.push(root);
  const runnerTemp = join(root, "runner");
  const digests = join(runnerTemp, "digests");
  const checks = join(root, "scripts", "checks");
  const bin = join(root, "bin");
  mkdirSync(digests, { recursive: true });
  mkdirSync(checks, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const file of digestFiles) writeFileSync(join(digests, file), "");

  executable(
    join(checks, "retry-docker-imagetools-inspect.sh"),
    `#!/bin/bash
set -euo pipefail
if [[ " $* " == *" --raw "* ]]; then
  printf '%s\n' '{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}'
  exit 0
fi
if [ "$WRONG_PLATFORM" = true ]; then
  printf '%s\n' linux/arm64
elif [[ "$1" == *"${SHA_AMD64}"* ]]; then
  printf '%s\n' linux/amd64
else
  printf '%s\n' linux/arm64
fi
`,
  );
  executable(
    join(checks, "validate-managed-base-index.sh"),
    `#!/bin/bash
printf '{"linux/amd64":"sha256:%s","linux/arm64":"sha256:%s"}\n' '${SHA_AMD64}' '${SHA_ARM64}'
`,
  );
  executable(
    join(root, "scripts", "export-managed-base-image-contract.sh"),
    `#!/bin/bash
set -euo pipefail
output="$9"
mkdir -p "$(dirname "$output")"
printf '{}\n' > "$output"
`,
  );
  executable(
    join(bin, "docker"),
    `#!/bin/bash
set -euo pipefail
metadata=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--metadata-file" ]; then metadata="$argument"; fi
  previous="$argument"
done
[ -n "$metadata" ]
if [[ "$metadata" == *publication* ]] && [ "$PUBLICATION_MISMATCH" = true ]; then
  digest='${SHA_PUBLISHED}'
else
  digest='${SHA_CANDIDATE}'
fi
mkdir -p "$(dirname "$metadata")"
printf '{"containerimage.descriptor":{"digest":"%s"}}\n' "$digest" > "$metadata"
`,
  );

  const output = join(root, "github-output");
  return spawnSync("bash", [helper], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT: "openclaw",
      DISPLAY_NAME: "OpenClaw",
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "1",
      GITHUB_SHA: "e".repeat(40),
      IMAGE: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      PATH: `${bin}:${process.env.PATH || ""}`,
      PUBLICATION_MISMATCH: String(publicationMismatch),
      RUNNER_TEMP: runnerTemp,
      TAGS: "ghcr.io/nvidia/nemoclaw/sandbox-base:test",
      WRONG_PLATFORM: String(wrongPlatform),
    },
  });
}

function runTagHelper(ref: string, revision = "e".repeat(40)) {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-base-tags-"));
  temporaryRoots.push(root);
  const output = join(root, "github-output");
  const result = spawnSync("bash", [tagHelper], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      IMAGE: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      REF: ref,
      REVISION: revision,
    },
  });
  return {
    ...result,
    output: result.status === 0 ? readFileSync(output, "utf8") : "",
  };
}

describe("base-image manifest publication", () => {
  it("generates main and immutable SHA tags without a GitHub API request", () => {
    const result = runTagHelper("refs/heads/main");

    expect(result.status).toBe(0);
    expect(result.output).toContain("ghcr.io/nvidia/nemoclaw/sandbox-base:latest\n");
    expect(result.output).toContain("ghcr.io/nvidia/nemoclaw/sandbox-base:eeeeeeee\n");
  });

  it("generates release and immutable SHA tags without a GitHub API request", () => {
    const result = runTagHelper("refs/tags/v0.0.114");

    expect(result.status).toBe(0);
    expect(result.output).toContain("ghcr.io/nvidia/nemoclaw/sandbox-base:v0.0.114\n");
    expect(result.output).toContain("ghcr.io/nvidia/nemoclaw/sandbox-base:eeeeeeee\n");
    expect(result.output).toContain("ghcr.io/nvidia/nemoclaw/sandbox-base:latest\n");
  });

  it("rejects a malformed publication revision", () => {
    const result = runTagHelper("refs/heads/main", "not-a-commit");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("base-image revision must be an exact commit SHA");
  });

  it("rejects a malformed platform digest artifact", () => {
    const result = runManifest({ digestFiles: ["amd64-invalid", `arm64-${SHA_ARM64}`] });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid platform digest artifact: amd64-invalid");
  });

  it("rejects duplicate platform digest artifacts", () => {
    const result = runManifest({ digestFiles: [`amd64-${SHA_AMD64}`, `amd64-${SHA_ARM64}`] });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("duplicate platform digest for linux/amd64");
  });

  it("rejects a digest that resolves to the wrong platform", () => {
    const result = runManifest({
      digestFiles: [`amd64-${SHA_AMD64}`, `arm64-${SHA_ARM64}`],
      wrongPlatform: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("digest for linux/amd64 resolves to linux/arm64");
  });

  it("rejects a published digest that differs from the validated candidate", () => {
    const result = runManifest({
      digestFiles: [`amd64-${SHA_AMD64}`, `arm64-${SHA_ARM64}`],
      publicationMismatch: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "published OpenClaw base digest differs from the validated candidate",
    );
  });
});
