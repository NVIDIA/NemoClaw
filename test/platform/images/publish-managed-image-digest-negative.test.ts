// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

function fixture(dockerLines: string[], digest = "sha256:" + "a".repeat(64)) {
  const root = mkdtempSync(join(tmpdir(), "managed-image-digest-negative-"));
  roots.push(root);
  const bin = join(root, "bin");
  const runner = join(root, "runner");
  const output = join(root, "output");
  const log = join(root, "docker.log");
  mkdirSync(bin);
  mkdirSync(runner);
  const docker = join(bin, "docker");
  writeFileSync(
    docker,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf '%s\n' "$*" >> "$DOCKER_LOG"`,
      ...dockerLines,
      "exit 97",
      "",
    ].join("\n"),
  );
  chmodSync(docker, 0o755);
  const result = spawnSync("bash", [helper], {
    encoding: "utf8",
    env: {
      ...process.env,
      DIGEST: digest,
      DOCKER_LOG: log,
      GITHUB_OUTPUT: output,
      IMAGE: "ghcr.io/nvidia/nemoclaw/test",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PLATFORM: "linux/amd64",
      RUNNER_TEMP: runner,
    },
  });
  return { log, output, result };
}

describe("managed-image digest publication rejection", () => {
  it("rejects manifest bytes that do not match the published digest before pulling", () => {
    const { log, output, result } = fixture([
      `if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then printf %s mismatched-manifest; exit 0; fi`,
    ]);
    expect(result.status).not.toBe(0);
    expect(readFileSync(log, "utf8")).not.toContain("pull --platform");
    expect(existsSync(output) ? readFileSync(output, "utf8") : "").toBe("");
  });

  it("rejects a pulled reference whose image ID is not self-consistent", () => {
    const manifest = "published-manifest";
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
    const first = "sha256:" + "b".repeat(64);
    const second = "sha256:" + "c".repeat(64);
    const { output, result } = fixture(
      [
        `if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then printf %s '${manifest}'; exit 0; fi`,
        `if [ "$1" = pull ]; then exit 0; fi`,
        `if [ "$1 $2" = "image inspect" ]; then case "$*" in *"${first}"*) printf '%s\n' '${second}' ;; *) printf '%s\n' '${first}' ;; esac; exit 0; fi`,
      ],
      digest,
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(output) ? readFileSync(output, "utf8") : "").toBe("");
  });
});
