// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const patchPath = path.join(root, "agents", "hermes", "secure-dir-skip-chmod.patch");
const patchSource = fs.readFileSync(patchPath, "utf8");
const baseDockerfile = fs.readFileSync(
  path.join(root, "agents", "hermes", "Dockerfile.base"),
  "utf8",
);
const dockerfile = fs.readFileSync(path.join(root, "agents", "hermes", "Dockerfile"), "utf8");

const sourceSha256 = "ffae3271120cf53eb8a7f574f76758eac3ea172f9ddc22c1056277e37d8d392c";
const outputSha256 = "130cf4e76d6f4f16b85517cf8d3d81dfe294aff63d6c561b979971c401f78761";

const upstreamFixture = `\
import os

def is_managed():
    return False

def _chown_to_hermes_uid(path) -> None:
    pass


def _secure_dir(path):
    """Set directory to owner-only access (0700 by default). No-op on Windows.

    Skipped in managed mode — the NixOS module sets group-readable
    permissions (0750) so interactive users in the hermes group can
    share state with the gateway service.

    The mode can be overridden via the HERMES_HOME_MODE environment variable
    (e.g. HERMES_HOME_MODE=0701) for deployments where a web server (nginx,
    caddy, etc.) needs to traverse HERMES_HOME to reach a served subdirectory.
    The execute-only bit on a directory permits cd-through without exposing
    directory listings.

    Also applies \`\`HERMES_UID\`\`/\`\`HERMES_GID\`\`-based ownership when those env
    vars are set (#34107 — Docker deployments need this so profile subdirs
    created at runtime by kanban workers don't land as root:root and block
    subsequent uid-mapped workers).
    """
    if is_managed():
        return
    try:
        mode_str = os.environ.get("HERMES_HOME_MODE", "").strip()
        mode = int(mode_str, 8) if mode_str else 0o700
    except ValueError:
        mode = 0o700
    try:
        os.chmod(path, mode)
    except (OSError, NotImplementedError):
        pass
    _chown_to_hermes_uid(path)
`;

function patchedFixture(): {
  readonly directory: string;
  readonly config: string;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-secure-dir-"));
  const moduleRoot = path.join(directory, "hermes_cli");
  const config = path.join(moduleRoot, "config.py");
  fs.mkdirSync(moduleRoot);
  fs.writeFileSync(config, upstreamFixture);
  const applied = spawnSync("git", ["-C", directory, "apply", "--check", patchPath], {
    encoding: "utf8",
  });
  expect(applied.status, applied.stderr).toBe(0);
  const patch = spawnSync("git", ["-C", directory, "apply", patchPath], {
    encoding: "utf8",
  });
  expect(patch.status, patch.stderr).toBe(0);
  return { directory, config };
}

describe("Hermes secure-directory chmod opt-out", () => {
  it("preserves NemoClaw's shared home and runtime modes when the opt-out is set", () => {
    const fixture = patchedFixture();
    const home = path.join(fixture.directory, ".hermes");
    const runtime = path.join(home, "runtime");
    fs.mkdirSync(runtime, { recursive: true });
    fs.chmodSync(home, 0o3770);
    fs.chmodSync(runtime, 0o2770);
    const probe = `\
import pathlib
import stat
import sys

namespace = {}
exec(compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], "exec"), namespace)
for raw, expected in ((sys.argv[2], 0o3770), (sys.argv[3], 0o2770)):
    path = pathlib.Path(raw)
    namespace["_secure_dir"](path)
    assert stat.S_IMODE(path.stat().st_mode) == expected
`;
    try {
      const result = spawnSync("python3", ["-I", "-c", probe, fixture.config, home, runtime], {
        encoding: "utf8",
        env: { ...process.env, HERMES_SKIP_CHMOD: "1" },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(fs.statSync(home).mode & 0o7777).toBe(0o3770);
      expect(fs.statSync(runtime).mode & 0o7777).toBe(0o2770);
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("retains upstream hardening when the opt-out is unset", () => {
    const fixture = patchedFixture();
    const home = path.join(fixture.directory, ".hermes");
    fs.mkdirSync(home, { recursive: true });
    fs.chmodSync(home, 0o3770);
    const probe = `\
import pathlib
import sys

namespace = {}
exec(compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], "exec"), namespace)
namespace["_secure_dir"](pathlib.Path(sys.argv[2]))
`;
    try {
      const env = { ...process.env };
      delete env.HERMES_HOME_MODE;
      delete env.HERMES_SKIP_CHMOD;
      const result = spawnSync("python3", ["-I", "-c", probe, fixture.config, home], {
        encoding: "utf8",
        env,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(fs.statSync(home).mode & 0o7777).toBe(0o700);
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["base image", baseDockerfile],
    ["final image", dockerfile],
  ])("binds exact source, patch, and output identities in the %s", (_name, source) => {
    const patchSha256 = createHash("sha256").update(patchSource).digest("hex");

    expect(source).toContain(`ENV HERMES_SKIP_CHMOD=1`);
    expect(source).toContain(`NEMOCLAW_HERMES_SECURE_DIR_SOURCE_SHA256=${sourceSha256}`);
    expect(source).toContain(`NEMOCLAW_HERMES_SECURE_DIR_PATCH_SHA256=${patchSha256}`);
    expect(source).toContain(`NEMOCLAW_HERMES_SECURE_DIR_OUTPUT_SHA256=${outputSha256}`);
  });

  it("accepts only the exact source or already-patched output in a final image", () => {
    expect(dockerfile).toContain(
      'secure_dir_source_sha" = "$NEMOCLAW_HERMES_SECURE_DIR_SOURCE_SHA256"',
    );
    expect(dockerfile).toContain(
      'secure_dir_source_sha" != "$NEMOCLAW_HERMES_SECURE_DIR_OUTPUT_SHA256"',
    );
  });

  it("requires exact source input and exact patched output in the base image", () => {
    expect(baseDockerfile).toContain(
      '"$NEMOCLAW_HERMES_SECURE_DIR_SOURCE_SHA256" /opt/hermes/hermes_cli/config.py',
    );
    expect(baseDockerfile).toContain(
      '"$NEMOCLAW_HERMES_SECURE_DIR_OUTPUT_SHA256" /opt/hermes/hermes_cli/config.py',
    );
  });

  it("probes the exact shared modes before cron opens its runtime ledger", () => {
    const modeProbe = dockerfile.indexOf("image-build-probes.py secure-directory-modes");
    const cronProbe = dockerfile.indexOf("image-build-probes.py cron-create");

    expect(modeProbe).toBeGreaterThanOrEqual(0);
    expect(modeProbe).toBeLessThan(cronProbe);
    expect(dockerfile).toContain(`stat -c '%U:%G %a' /sandbox/.hermes)" = "sandbox:sandbox 3770"`);
    expect(dockerfile).toContain(
      `stat -c '%U:%G %a' /sandbox/.hermes/runtime)" = "gateway:sandbox 2770"`,
    );
  });
});
