// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve(
  import.meta.dirname,
  "../../../.github/actions/publish-managed-image-digest/validate.sh",
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("managed-image digest publication validation", () => {
  it("rejects an inaccessible digest without ambient credentials or success outputs", () => {
    const root = mkdtempSync(join(tmpdir(), "managed-image-digest-"));
    roots.push(root);
    const bin = join(root, "bin");
    const runner = join(root, "runner");
    const output = join(root, "output");
    mkdirSync(bin);
    mkdirSync(runner);
    const manifest = "published-manifest";
    const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
    const docker = join(bin, "docker");
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then printf %s '${manifest}'; exit 0; fi
[ -z "\${DOCKER_AUTH_CONFIG+x}" ] || exit 91
[ "$1" = pull ] && exit 1
exit 92
`,
    );
    chmodSync(docker, 0o755);
    const result = spawnSync("bash", [helper], {
      encoding: "utf8",
      env: {
        ...process.env,
        DIGEST: digest,
        DOCKER_AUTH_CONFIG: "must-not-reach-docker",
        GITHUB_OUTPUT: output,
        IMAGE: "ghcr.io/nvidia/nemoclaw/test",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PLATFORM: "linux/amd64",
        RUNNER_TEMP: runner,
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBe(91);
    expect(existsSync(output) ? readFileSync(output, "utf8") : "").toBe("");
  });
});
