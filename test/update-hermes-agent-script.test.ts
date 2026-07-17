// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "update-hermes-agent.sh");
const HERMES_BASE_DOCKERFILE = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "Dockerfile.base",
);
const HERMES_MANIFEST = path.join(import.meta.dirname, "..", "agents", "hermes", "manifest.yaml");
const TARGET_TAG = "v2026.7.1";

const CURRENT_INSTALLED_BASE = [
  "# Calver tag v2026.6.5 = Hermes Agent v0.16.0.",
  "ARG HERMES_VERSION=v2026.6.5",
  "ARG HERMES_SEMVER=0.16.0",
  "ARG HERMES_TARBALL_SHA256=oldsha",
  "ARG HERMES_NPM_INTEGRITY=sha512-old",
  "",
].join("\n");

const CURRENT_INSTALLED_DOCKERFILE = [
  "COPY agents/hermes/validate-hermes-env-secret-boundary.py /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py",
  "COPY agents/hermes/seed-dashboard-config.py /usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py",
  "COPY agents/hermes/build-mcp-digest.py /usr/local/lib/nemoclaw/build-hermes-mcp-digest.py",
  'RUN mcp_digest="$(/opt/hermes/.venv/bin/python -I /usr/local/lib/nemoclaw/build-hermes-mcp-digest.py --guard /usr/local/lib/nemoclaw/hermes-runtime-config-guard.py --config /sandbox/.hermes/config.yaml)"',
  "COPY agents/hermes/mcp-config-transaction.py /usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py",
  "COPY src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.85.json /usr/local/lib/nemoclaw/openshell-child-visible-credentials.v0.0.85.json",
  "RUN HERMES_HOME=/sandbox/.hermes /usr/local/bin/hermes doctor --fix \\",
  "    && node --experimental-strip-types /opt/nemoclaw-hermes-config/generate-config.ts",
  "RUN mkdir -p /sandbox/.hermes/dashboard-home",
  "",
].join("\n");

function writeInstalledHermesCopy(baseDockerfile: string, baseText = CURRENT_INSTALLED_BASE) {
  fs.mkdirSync(path.dirname(baseDockerfile), { recursive: true });
  fs.writeFileSync(baseDockerfile, baseText);
  fs.writeFileSync(
    path.join(path.dirname(baseDockerfile), "Dockerfile"),
    CURRENT_INSTALLED_DOCKERFILE,
  );
}

function writeExecutable(file: string, body: string) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

describe("scripts/update-hermes-agent.sh", () => {
  it("pins rebuild overrides to the accepted full image-ID local tag family", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-rebuild-"));
    const repo = path.join(tmp, "repo");
    const script = path.join(repo, "scripts", "update-hermes-agent.sh");
    const fakeBin = path.join(tmp, "bin");
    const dockerLog = path.join(tmp, "docker.log");
    const nemohermesLog = path.join(tmp, "nemohermes.log");
    const imageId = `sha256:${"a".repeat(64)}`;
    const pinnedRef = `nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`;
    const baseRef = "nemoclaw-hermes-base-local:test";
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.mkdirSync(path.join(repo, "agents", "hermes"), { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.copyFileSync(SCRIPT, script);
    fs.chmodSync(script, 0o755);
    fs.copyFileSync(HERMES_BASE_DOCKERFILE, path.join(repo, "agents", "hermes", "Dockerfile.base"));
    fs.copyFileSync(HERMES_MANIFEST, path.join(repo, "agents", "hermes", "manifest.yaml"));
    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
output=""
previous=""
for arg in "$@"; do
  case "$previous" in
    -o) output="$arg" ;;
  esac
  previous="$arg"
done
printf 'fake archive' > "$output"
`,
    );
    writeExecutable(
      path.join(fakeBin, "tar"),
      "#!/usr/bin/env bash\nprintf 'version = \"0.18.0\"\\n'\n",
    );
    writeExecutable(path.join(fakeBin, "npm"), "#!/usr/bin/env bash\nprintf 'sha512-test\\n'\n");
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "\${1:-}" in
  image) printf '%s\\n' ${JSON.stringify(imageId)} ;;
esac
`,
    );
    writeExecutable(
      path.join(fakeBin, "nemohermes"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\\n' "\${NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF:-}" "$*" >> "$FAKE_NEMOHERMES_LOG"
if [[ "$*" == "hermes exec -- hermes --version" ]]; then
  printf '0.18.0\\n'
fi
`,
    );

    try {
      const run = spawnSync("bash", [script, "--tag", TARGET_TAG, "--rebuild"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          HOME: path.join(tmp, "home"),
          HERMES_BASE_REF: baseRef,
          FAKE_DOCKER_LOG: dockerLog,
          FAKE_NEMOHERMES_LOG: nemohermesLog,
          NEMOCLAW_SOURCE_ROOT: undefined,
        },
        timeout: 10_000,
      });

      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(fs.readFileSync(dockerLog, "utf8")).toContain(`tag ${baseRef} ${pinnedRef}`);
      expect(fs.readFileSync(nemohermesLog, "utf8")).toContain(`${pinnedRef}|hermes rebuild`);
      expect(run.stdout).toContain("OK: sandbox reports Hermes Agent v0.18.0");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps installed-copy scanning opt-in unless rebuild needs it", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-home-"));
    const installedDockerfile = path.join(
      tmpHome,
      ".nemoclaw",
      "source",
      "agents",
      "hermes",
      "Dockerfile.base",
    );
    writeInstalledHermesCopy(installedDockerfile);

    const run = (...args: string[]) =>
      spawnSync("bash", [SCRIPT, "--tag", TARGET_TAG, "--check", ...args], {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_SOURCE_ROOT: undefined,
        },
        timeout: 5000,
      });

    try {
      const defaultCheck = run();
      expect(defaultCheck.status).toBe(0);
      expect(defaultCheck.stdout).toContain("Installed-copy scan skipped");

      const explicitScan = run("--update-installed-copies");
      expect(explicitScan.status).toBe(1);
      expect(explicitScan.stdout).toContain("STALE: installed copy");
      expect(explicitScan.stdout).toContain(installedDockerfile);

      const rebuildCheck = run("--rebuild");
      expect(rebuildCheck.status).toBe(1);
      expect(rebuildCheck.stdout).toContain("STALE: installed copy");
      expect(rebuildCheck.stdout).toContain(installedDockerfile);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("refuses unsafe installed-copy rewrite candidates", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-unsafe-"));
    const sourceRoot = path.join(tmpHome, "source-root");
    const symlinkRoot = path.join(tmpHome, "symlink-root");
    const symlinkTarget = path.join(tmpHome, "target-root");
    const hardlinkedDockerfile = path.join(sourceRoot, "agents", "hermes", "Dockerfile.base");
    const symlinkDockerfile = path.join(sourceRoot, "aliased", "Dockerfile.base");
    fs.mkdirSync(path.dirname(hardlinkedDockerfile), { recursive: true });
    fs.mkdirSync(path.dirname(symlinkDockerfile), { recursive: true });
    fs.mkdirSync(symlinkTarget, { recursive: true });
    fs.writeFileSync(hardlinkedDockerfile, "ARG HERMES_VERSION=v2026.6.5\n");
    fs.linkSync(hardlinkedDockerfile, path.join(sourceRoot, "Dockerfile.hardlink"));
    fs.symlinkSync(hardlinkedDockerfile, symlinkDockerfile);
    fs.symlinkSync(symlinkTarget, symlinkRoot);

    const run = (root: string) =>
      spawnSync("bash", [SCRIPT, "--tag", TARGET_TAG, "--check", "--update-installed-copies"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_SOURCE_ROOT: root,
        },
        timeout: 5000,
      });

    try {
      const unsafeCandidates = run(sourceRoot);
      expect(unsafeCandidates.status).toBe(0);
      expect(unsafeCandidates.stdout).not.toContain("STALE: installed copy");
      expect(unsafeCandidates.stderr).toContain("SKIP unsafe installed copy");
      expect(fs.readFileSync(hardlinkedDockerfile, "utf-8")).toContain("v2026.6.5");

      const unsafeRoot = run(symlinkRoot);
      expect(unsafeRoot.status).toBe(0);
      expect(unsafeRoot.stderr).toContain("SKIP unsafe installed-copy root");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("refuses legacy installed copies missing HERMES_SEMVER/HERMES_NPM_INTEGRITY and current integration markers without mutating them", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-legacy-"));
    const installedDockerfile = path.join(
      tmpHome,
      ".nemoclaw",
      "source",
      "agents",
      "hermes",
      "Dockerfile.base",
    );
    const legacyBase = "ARG HERMES_VERSION=v2026.6.5\nARG HERMES_TARBALL_SHA256=oldsha\n";
    const legacyDockerfile = "# legacy Hermes Dockerfile without v0.17 integration markers\n";
    fs.mkdirSync(path.dirname(installedDockerfile), { recursive: true });
    fs.writeFileSync(installedDockerfile, legacyBase);
    fs.writeFileSync(path.join(path.dirname(installedDockerfile), "Dockerfile"), legacyDockerfile);

    const run = spawnSync(
      "bash",
      [SCRIPT, "--tag", TARGET_TAG, "--check", "--update-installed-copies"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_SOURCE_ROOT: undefined,
        },
        timeout: 5000,
      },
    );

    try {
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("INVALID: installed copy");
      expect(run.stdout).toContain("legacy Hermes source schema");
      expect(run.stdout).toContain("refresh or reinstall");
      expect(fs.readFileSync(installedDockerfile, "utf-8")).toBe(legacyBase);
      expect(
        fs.readFileSync(path.join(path.dirname(installedDockerfile), "Dockerfile"), "utf-8"),
      ).toBe(legacyDockerfile);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("refuses installed copies that predate the transactional MCP boundary", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-pre-mcp-"));
    const installedDockerfile = path.join(
      tmpHome,
      ".nemoclaw",
      "source",
      "agents",
      "hermes",
      "Dockerfile.base",
    );
    const installedAgentDockerfile = path.join(path.dirname(installedDockerfile), "Dockerfile");
    const preMcpDockerfile = CURRENT_INSTALLED_DOCKERFILE.replace(
      /^(?:COPY (?:agents\/hermes\/(?:build-mcp-digest|mcp-config-transaction)\.py|src\/lib\/actions\/sandbox\/openshell-child-visible-credentials\.v0\.0\.85\.json) .*|RUN mcp_digest=.*build-hermes-mcp-digest\.py.*)\n/gm,
      "",
    );
    fs.mkdirSync(path.dirname(installedDockerfile), { recursive: true });
    fs.writeFileSync(installedDockerfile, CURRENT_INSTALLED_BASE);
    fs.writeFileSync(installedAgentDockerfile, preMcpDockerfile);

    const run = spawnSync(
      "bash",
      [SCRIPT, "--tag", TARGET_TAG, "--check", "--update-installed-copies"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_SOURCE_ROOT: undefined,
        },
        timeout: 5000,
      },
    );

    try {
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("INVALID: installed copy");
      expect(run.stdout).toContain("marker hermes-mcp-config-transaction.py");
      expect(run.stdout).toContain("marker openshell-child-visible-credentials.v0.0.85.json");
      expect(run.stdout).toContain("marker COPY agents/hermes/build-mcp-digest.py");
      expect(run.stdout).toContain("marker /opt/hermes/.venv/bin/python -I");
      expect(fs.readFileSync(installedDockerfile, "utf-8")).toBe(CURRENT_INSTALLED_BASE);
      expect(fs.readFileSync(installedAgentDockerfile, "utf-8")).toBe(preMcpDockerfile);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("refuses installed copies with an independently pinned final workaround guard (#5254)", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-final-guard-"));
    const installedDockerfile = path.join(
      tmpHome,
      ".nemoclaw",
      "source",
      "agents",
      "hermes",
      "Dockerfile.base",
    );
    const installedAgentDockerfile = path.join(path.dirname(installedDockerfile), "Dockerfile");
    const staleGuardDockerfile = [
      CURRENT_INSTALLED_DOCKERFILE,
      "ARG HERMES_SEMVER=0.17.0",
      'RUN if [ "$HERMES_SEMVER" != "0.17.0" ]; then exit 1; fi',
      "",
    ].join("\n");
    fs.mkdirSync(path.dirname(installedDockerfile), { recursive: true });
    fs.writeFileSync(installedDockerfile, CURRENT_INSTALLED_BASE);
    fs.writeFileSync(installedAgentDockerfile, staleGuardDockerfile);

    const run = spawnSync(
      "bash",
      [SCRIPT, "--tag", TARGET_TAG, "--check", "--update-installed-copies"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_SOURCE_ROOT: undefined,
        },
        timeout: 5000,
      },
    );

    try {
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("INVALID: installed copy");
      expect(run.stdout).toContain("final Dockerfile #5254 guard");
      expect(run.stdout).toContain("installed hermes --version");
      expect(fs.readFileSync(installedDockerfile, "utf-8")).toBe(CURRENT_INSTALLED_BASE);
      expect(fs.readFileSync(installedAgentDockerfile, "utf-8")).toBe(staleGuardDockerfile);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
