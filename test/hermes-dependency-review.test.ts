// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "..");
const dockerfileBase = fs.readFileSync(
  path.join(root, "agents", "hermes", "Dockerfile.base"),
  "utf8",
);
const config = fs.readFileSync(
  path.join(root, "agents", "hermes", "config", "hermes-config.ts"),
  "utf8",
);
const manifest = fs.readFileSync(path.join(root, "agents", "hermes", "manifest.yaml"), "utf8");
const cliAdapter = JSON.parse(
  fs.readFileSync(path.join(root, "agents", "hermes", "hermes-cli-adapter-v1.json"), "utf8"),
);
const review = fs.readFileSync(
  path.join(root, "docs", "security", "hermes-0.19.0-dependency-review.md"),
  "utf8",
);
const securityDependenciesPatch = fs.readFileSync(
  path.join(root, "agents", "hermes", "security-dependencies.patch"),
  "utf8",
);

function arg(name: string): string {
  const match = dockerfileBase.match(new RegExp(`^ARG ${name}=(.+)$`, "mu"));
  expect(match, `Missing Dockerfile ARG ${name}`).not.toBeNull();
  return match?.[1] ?? "";
}

function uvVersionCheckStatus(output: string, expectedVersion: string): number | null {
  const dockerfileLines = dockerfileBase.split("\n");
  const installIndex = dockerfileLines.findIndex(
    (line) => line.startsWith("RUN pip3 install ") && line.includes('"uv==${UV_VERSION}"'),
  );
  expect(installIndex, "Missing Dockerfile uv install command").toBeGreaterThanOrEqual(0);

  const commandLines = dockerfileLines.slice(installIndex);
  const commandEndIndex = commandLines.findIndex((line) => !line.endsWith("\\"));
  const versionCheckLines = commandLines.slice(1, commandEndIndex + 1);
  expect(versionCheckLines, "Missing Dockerfile uv version check").not.toHaveLength(0);

  const script = [
    'uv() { printf "%s\\n" "$UV_OUTPUT"; }',
    "set -e",
    ...versionCheckLines.map((line) => line.replace(/^\s*&&\s*/u, "").replace(/\s*\\$/u, "")),
  ].join("\n");
  return spawnSync("/bin/sh", ["-c", script], {
    env: { ...process.env, UV_OUTPUT: output, UV_VERSION: expectedVersion },
  }).status;
}

describe("Hermes 0.19.0 dependency review", () => {
  it("binds every active source identity to the reviewed release", () => {
    expect(arg("HERMES_VERSION")).toBe("v2026.7.20");
    expect(arg("HERMES_SEMVER")).toBe("0.19.0");
    expect(arg("HERMES_TARBALL_SHA256")).toBe(
      "285f3fc134ff466a90065e1517801a68993733b807158ee8f32aa01613786990",
    );
    expect(arg("HERMES_NPM_INTEGRITY")).toBe(
      "sha512-+oVKG3lXbk2kEP+J6BXZjtmSBSaFfczIdOWQ9CUSTdTqq2uyHbk4p+kPyZ6MeGs56JU5qXzMNbqGKRVOQRGC1A==",
    );
    expect(manifest).toContain('expected_version: "0.19.0"');
    expect(review).toContain("`3ef6bbd201263d354fd83ec55b3c306ded2eb72a`");
    expect(review).toContain("`bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f`");
    expect(review).toContain("`ac986bede64a2785436676c0ea084ec586574f8cb00a9d047e095b435d3e21c0`");
  });

  it("preserves the reviewed authorization and state migrations", () => {
    expect(config).toContain("_config_version: 33");
    expect(config).toMatch(/approvals:\s*\{\s*[\s\S]*?mode: "manual"/u);
    expect(config).toMatch(/session_reset:\s*\{\s*[\s\S]*?mode: "both"/u);
    expect(config).toMatch(/browser:\s*\{\s*[\s\S]*?restrict_evaluate: true/u);
    expect(config).toMatch(/display:\s*\{\s*[\s\S]*?show_reasoning: false/u);
    expect(config).toMatch(/display:\s*\{\s*[\s\S]*?show_commentary: false/u);
    expect(config).toMatch(/updates:\s*\{\s*[\s\S]*?pre_update_backup: false/u);
    expect(config).toMatch(/updates:\s*\{\s*[\s\S]*?refresh_cua_driver: false/u);
    expect(manifest).toContain("path: runtime/cron-executions.db\n    strategy: sqlite_backup");
    expect(manifest).toContain(
      "path: gateway/discord_message_recovery.db\n    strategy: sqlite_backup",
    );
    expect(review).toContain("mcp__server__tool");
    expect(review).toContain("default-profile");
    expect(review).toContain("named-profile");
    expect(review).toContain("`HERMES-13`");
    expect(review).toContain("`HERMES-14`");
    expect(review).toContain("`HERMES-15`");
    expect(review).toContain("`HERMES-16`");
    expect(review).toContain("`HERMES-17`");
    expect(review).toContain("`HERMES-18`");
    expect(review).toContain("Unresolved upgrade-created high-impact concerns: `0`");
  });

  it("binds the CLI adapter version and source-fix constraints to target Hermes", () => {
    expect(cliAdapter.adapter_version).toBe(1);
    expect(cliAdapter.upstream_cli_version).toBe("0.19.0");
    expect(cliAdapter.managed_commands).toEqual(["chat"]);
    expect(cliAdapter.session_name_coalescer).toEqual({
      module: "hermes_cli.main",
      function: "_coalesce_session_name_args",
      boundary_set: "_SUBCOMMANDS",
    });
    expect(Object.keys(cliAdapter.translations).sort()).toEqual([
      "provider_model_composition",
      "resumed_oneshot",
    ]);
    expect(
      (
        Object.values(cliAdapter.translations) as Array<{
          source_fix_constraint?: unknown;
        }>
      ).every(
        (translation) =>
          typeof translation.source_fix_constraint === "string" &&
          translation.source_fix_constraint.length > 0,
      ),
    ).toBe(true);
  });

  it("accepts uv build metadata and rejects a different semantic version", () => {
    const expectedVersion = arg("UV_VERSION");
    const differentVersion = expectedVersion.replace(/\d+$/u, (patch) =>
      String(Number.parseInt(patch, 10) + 1),
    );
    expect(
      uvVersionCheckStatus(
        `uv ${expectedVersion} (fece32fc5 2026-07-28 aarch64-unknown-linux-gnu)`,
        expectedVersion,
      ),
    ).toBe(0);
    expect(
      uvVersionCheckStatus(`uv ${differentVersion} (different build metadata)`, expectedVersion),
    ).toBe(1);
  });

  it("ships the reviewed Python dependency remediations and records residual debt", () => {
    expect(dockerfileBase).toContain(
      "COPY agents/hermes/security-dependencies.patch /tmp/hermes-security-dependencies.patch",
    );
    expect(dockerfileBase).toContain(
      "git -C /opt/hermes apply --check /tmp/hermes-security-dependencies.patch",
    );
    expect(dockerfileBase).toContain("uv pip check --python /opt/hermes/.venv/bin/python");
    expect(arg("NODE_VERSION")).toBe("24.18.1");
    expect(arg("UV_VERSION")).toBe("0.11.33");
    for (const selection of [
      '"cryptography==48.0.1"',
      '"mcp==1.28.1"',
      '"Pillow==12.3.0"',
      '"starlette==1.3.1"',
      '"tornado==6.5.7"',
    ]) {
      expect(securityDependenciesPatch).toContain(selection);
    }
    for (const installedVersion of [
      "'cryptography': '48.0.1'",
      "'mcp': '1.28.1'",
      "'pillow': '12.3.0'",
      "'starlette': '1.3.1'",
      "'tornado': '6.5.7'",
    ]) {
      expect(dockerfileBase).toContain(installedVersion);
    }
    expect(dockerfileBase).toContain("python-multipart==0.0.32");
    expect(dockerfileBase).toContain(
      "sha256:be54b7f3fa167bb83e4fcd936b887b708f4e57fe75911c02aebf53efaf8d938e",
    );
    expect(dockerfileBase).toContain(
      "sha256:ff6d3f776f16878c894e52e107296ffc890e913c611b1a4ec6c44e2821fe2e23",
    );
    for (const advisory of ["GHSA-5rvq-cxj2-64vf", "GHSA-6jv3-5f52-599m", "GHSA-v9pg-7xvm-68hf"]) {
      expect(review).toContain(advisory);
    }
    expect(review).toContain("`cryptography==48.0.1`");
    expect(review).toContain("`mcp==1.28.1`");
    expect(review).toContain("`Pillow==12.3.0`");
    expect(review).toContain("`starlette==1.3.1`");
    expect(review).toContain("`tornado==6.5.7`");
    expect(review).toContain("checksum-pinned Node.js `24.18.1`");
    expect(review).toContain("exact uv `0.11.33`");
  });
});
