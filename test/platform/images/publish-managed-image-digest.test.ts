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
function manifest(layerCount = 1): string {
  return JSON.stringify({
    schemaVersion: 2,
    layers: Array.from({ length: layerCount }, (_, index) => ({
      digest: `sha256:${String(index).padStart(64, "0")}`,
    })),
  });
}
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
    const pullConfig = join(root, "pull-config");
    mkdirSync(bin);
    mkdirSync(runner);
    const publishedManifest = manifest();
    const digest = `sha256:${createHash("sha256").update(publishedManifest).digest("hex")}`;
    const docker = join(bin, "docker");
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then printf %s '${publishedManifest}'; exit 0; fi
[ -z "\${DOCKER_AUTH_CONFIG+x}" ] || exit 91
if [ "$1" = pull ]; then
  case "$DOCKER_CONFIG" in "$RUNNER_TEMP"/anonymous-docker-*) ;; *) exit 92 ;; esac
  [ -z "$(find "$DOCKER_CONFIG" -mindepth 1 -print -quit)" ] || exit 93
  printf %s "$DOCKER_CONFIG" > "$PULL_CONFIG_OUTPUT"
  exit 1
fi
exit 94
`,
    );
    chmodSync(docker, 0o755);
    const result = spawnSync("bash", [helper], {
      encoding: "utf8",
      env: {
        ...process.env,
        DIGEST: digest,
        DOCKER_AUTH_CONFIG: "must-not-reach-docker",
        DOCKER_CONFIG: join(root, "ambient-docker"),
        GITHUB_OUTPUT: output,
        IMAGE: "ghcr.io/nvidia/nemoclaw/test",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PLATFORM: "linux/amd64",
        PULL_CONFIG_OUTPUT: pullConfig,
        RUNNER_TEMP: runner,
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBe(91);
    expect(existsSync(output) ? readFileSync(output, "utf8") : "").toBe("");
    expect(existsSync(readFileSync(pullConfig, "utf8"))).toBe(false);
  });

  it("exports immutable identity after a credential-free anonymous pull", () => {
    const root = mkdtempSync(join(tmpdir(), "managed-image-digest-success-"));
    roots.push(root);
    const bin = join(root, "bin");
    const runner = join(root, "runner");
    const output = join(root, "output");
    const pullConfig = join(root, "pull-config");
    mkdirSync(bin);
    mkdirSync(runner);
    const platformManifest = manifest();
    const platformDigest = `sha256:${createHash("sha256").update(platformManifest).digest("hex")}`;
    const publishedManifest = JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          digest: platformDigest,
          platform: { architecture: "amd64", os: "linux" },
        },
        {
          digest: `sha256:${"c".repeat(64)}`,
          platform: { architecture: "unknown", os: "unknown" },
        },
      ],
    });
    const digest = `sha256:${createHash("sha256").update(publishedManifest).digest("hex")}`;
    const imageId = "sha256:" + "b".repeat(64);
    const docker = join(bin, "docker");
    writeFileSync(
      docker,
      "#!/usr/bin/env bash\nset -euo pipefail\n" +
        'if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then case "$*" in *"$PLATFORM_DIGEST"*) printf %s \'' +
        platformManifest +
        "' ;; *) printf %s '" +
        publishedManifest +
        "' ;; esac; exit 0; fi\n" +
        'if [ "$1" = pull ]; then [ -z "${DOCKER_AUTH_CONFIG+x}" ] || exit 91; case "$DOCKER_CONFIG" in "$RUNNER_TEMP"/anonymous-docker-*) ;; *) exit 92 ;; esac; [ -z "$(find "$DOCKER_CONFIG" -mindepth 1 -print -quit)" ] || exit 93; printf %s "$DOCKER_CONFIG" > "$PULL_CONFIG_OUTPUT"; exit 0; fi\n' +
        'if [ "$1 $2" = "image inspect" ]; then printf \'%s\\n\' \'' +
        imageId +
        "'; exit 0; fi\nexit 94\n",
    );
    chmodSync(docker, 0o755);
    const result = spawnSync("bash", [helper], {
      encoding: "utf8",
      env: {
        ...process.env,
        DIGEST: digest,
        DOCKER_AUTH_CONFIG: "must-not-reach-docker",
        DOCKER_CONFIG: join(root, "ambient-docker"),
        GITHUB_OUTPUT: output,
        IMAGE: "ghcr.io/nvidia/nemoclaw/test",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PLATFORM: "linux/amd64",
        PLATFORM_DIGEST: platformDigest,
        PULL_CONFIG_OUTPUT: pullConfig,
        RUNNER_TEMP: runner,
      },
    });
    expect(result.status).toBe(0);
    const anonymousConfig = readFileSync(pullConfig, "utf8");
    expect(existsSync(anonymousConfig)).toBe(true);
    expect(readFileSync(output, "utf8")).toBe(
      "docker-config=" +
        anonymousConfig +
        "\nlocal-id=" +
        imageId +
        "\nreference=ghcr.io/nvidia/nemoclaw/test@" +
        digest +
        "\n",
    );
  });
});
