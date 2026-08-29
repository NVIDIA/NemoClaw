// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { dockerfileInstructions } from "../../helpers/dockerfile-run-commands";

const root = path.join(import.meta.dirname, "../../..");
const dockerfileBase = fs.readFileSync(path.join(root, "agents/hermes/Dockerfile.base"), "utf8");
const dockerfile = fs.readFileSync(path.join(root, "agents/hermes/Dockerfile"), "utf8");
const config = fs.readFileSync(path.join(root, "agents/hermes/config/managed-policy.ts"), "utf8");
const manifest = fs.readFileSync(path.join(root, "agents/hermes/manifest.yaml"), "utf8");
const cliAdapter = JSON.parse(
  fs.readFileSync(path.join(root, "agents/hermes/hermes-cli-adapter-v1.json"), "utf8"),
);
const review = fs.readFileSync(
  path.join(root, "internal/security-reviews/hermes-0.20.6-dependency-review.md"),
  "utf8",
);
const securityDependenciesPatch = fs.readFileSync(
  path.join(root, "agents/hermes/security-dependencies.patch"),
  "utf8",
);
const hindsightProbeRequirementsPath = path.join(
  root,
  "agents/hermes/hindsight-client-probe-requirements.txt",
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
  const script = [
    'uv() { printf "%s\\n" "$UV_OUTPUT"; }',
    "set -e",
    ...versionCheckLines.map((line) => line.replace(/^\s*&&\s*/u, "").replace(/\s*\\$/u, "")),
  ].join("\n");
  return spawnSync("/bin/sh", ["-c", script], {
    env: { ...process.env, UV_OUTPUT: output, UV_VERSION: expectedVersion },
  }).status;
}

describe("Hermes 0.20.6 dependency review", () => {
  // source-shape-contract: security -- The image must bind every upstream version, patch, and offline dependency gate to reviewed source bytes before construction.
  it("binds the image to the reviewed Hermes migration", () => {
    expect(arg("HERMES_VERSION")).toBe("v2026.8.27");
    expect(arg("HERMES_SEMVER")).toBe("0.20.6");
    expect(arg("HERMES_TARBALL_SHA256")).toBe(
      "e622723b5bf3cd6c1db974d92d32242f1cb63f61c1112b6f708b34d619ef0fc7",
    );
    expect(arg("HERMES_NPM_INTEGRITY")).toBe(
      "sha512-s5q1IEBifCBb77QMwkse4MRaAaoZSxIa4IkicIO3jL7MIdq15YvnSyiNvsTOWNBi6t3shFpIg+H7+9MJsOiSkg==",
    );
    expect(arg("NODE_VERSION")).toBe("24.18.1");
    expect(arg("UV_VERSION")).toBe("0.11.33");

    expect(manifest).toContain('expected_version: "0.20.6"');
    expect(manifest).toContain("path: runtime/cron-executions.db\n    strategy: sqlite_backup");
    expect(review).toContain("`5fc308a70719a83cccdbba4c0e39c23f5a8239d5`");
    expect(review).toContain("`4e0e663a9a4cf6bac8df8972ea23dfc26ce3c309`");
    expect(review).toContain("`b12bede8bfa5bc7a8c083f54fc79a4f5663b81df`");
    expect(review).toContain(
      "`sha256:ec3f152824a843b9970aa8342de0ad15289d99899af06e6eb94baec8e29e5744`",
    );
    expect(review).toContain("five exact preview queries");
    expect(review).toContain("Unresolved upgrade-created high-impact concerns: `0`");

    expect(config).toContain("_config_version: 33");
    expect(config).toMatch(/approvals:\s*\{\s*[\s\S]*?mode: "manual"/u);
    expect(config).toMatch(/session_reset:\s*\{\s*[\s\S]*?mode: "both"/u);
    expect(config).toMatch(/browser:\s*\{\s*[\s\S]*?restrict_evaluate: true/u);
    expect(config).toMatch(/display:\s*\{\s*[\s\S]*?show_reasoning: false/u);
    expect(config).toMatch(/display:\s*\{\s*[\s\S]*?show_commentary: false/u);
    expect(config).toMatch(/updates:\s*\{\s*[\s\S]*?pre_update_backup: false/u);
    expect(config).toMatch(/updates:\s*\{\s*[\s\S]*?refresh_cua_driver: false/u);

    expect(cliAdapter).toMatchObject({
      adapter_version: 1,
      upstream_cli_version: "0.20.6",
      managed_commands: ["chat"],
      session_name_coalescer: {
        module: "hermes_cli.main",
        function: "_coalesce_session_name_args",
        boundary_set: "_SUBCOMMANDS",
      },
    });
    expect(Object.keys(cliAdapter.translations).sort()).toEqual([
      "provider_model_composition",
      "resumed_oneshot",
    ]);

    expect(dockerfileBase).toContain(
      "git -C /opt/hermes apply --check /tmp/hermes-security-dependencies.patch",
    );
    expect(dockerfileBase).toContain("uv pip check --python /opt/hermes/.venv/bin/python");
    expect(dockerfileBase).toContain("assert mcp_tool._ensure_mcp_sdk()");
    expect(dockerfile).toContain(
      "mcp_tool._ensure_mcp_sdk() or sys.exit",
    );
    expect(dockerfile).toContain("--include=plugins/memory/hindsight/plugin.yaml");
    expect(dockerfile).not.toContain("--include=hermes_cli/memory_setup.py");
    expect(dockerfile).toContain(
      "grep -Fq 'from tools.lazy_deps import install_specs' /opt/hermes/hermes_cli/memory_setup.py",
    );
    expect(dockerfile).toContain(
      "grep -Fq 'outcome = install_specs(missing, timeout=120)' /opt/hermes/hermes_cli/memory_setup.py",
    );
    expect(securityDependenciesPatch).toContain('-  - "hindsight-client>=0.6.1"');
    expect(securityDependenciesPatch).toContain('+  - "hindsight-client==0.6.1"');
    expect(securityDependenciesPatch).not.toContain("diff --git a/uv.lock");
    expect(securityDependenciesPatch).not.toContain("diff --git a/pyproject.toml");

    for (const installedVersion of [
      "'agent-client-protocol': '0.9.0'",
      "'aiohttp': '3.14.3'",
      "'cryptography': '50.0.0'",
      "'mcp': '2.0.0'",
      "'pillow': '12.3.0'",
      "'starlette': '1.3.1'",
      "'tornado': '6.5.7'",
    ]) {
      expect(dockerfileBase).toContain(installedVersion);
      expect(review.toLowerCase()).toContain(
        `\`${installedVersion.slice(1, -1).replace("': '", "==").toLowerCase()}\``,
      );
    }

    const lazyInstallLayer = dockerfileInstructions(dockerfile).find(
      (instruction) =>
        instruction.keyword === "RUN" &&
        instruction.body.includes(
          "from tools.lazy_deps import ensure; ensure('memory.hindsight', prompt=False)",
        ),
    );
    expect(lazyInstallLayer).toBeDefined();
    expect(lazyInstallLayer?.body).toContain("HERMES_LAZY_INSTALL_TARGET");
    expect(lazyInstallLayer?.body).toContain("PIP_NO_INDEX=1");
    expect(lazyInstallLayer?.body).toContain("UV_OFFLINE=1");
  });

  it("accepts uv build metadata and rejects a different semantic version", () => {
    const expectedVersion = arg("UV_VERSION");
    const differentVersion = expectedVersion.replace(/\d+$/u, (patchVersion) =>
      String(Number.parseInt(patchVersion, 10) + 1),
    );
    expect(
      uvVersionCheckStatus(
        `uv ${expectedVersion} (fece32fc5 2026-07-28 aarch64-unknown-linux-gnu)`,
        expectedVersion,
      ),
    ).toBe(0);
    expect(uvVersionCheckStatus(`uv ${differentVersion} (different)`, expectedVersion)).toBe(1);
  });

  it("rejects an altered Hindsight wheel before the compatibility import", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hindsight-hash-"));
    const artifact = path.join(temporaryRoot, "hindsight_client-0.6.1-py3-none-any.whl");
    const installTarget = path.join(temporaryRoot, "install");
    fs.writeFileSync(artifact, "same version, altered wheel digest\n", "utf8");
    try {
      const result = spawnSync(
        "python3",
        [
          "-m",
          "pip",
          "install",
          "--target",
          installTarget,
          "--no-deps",
          "--no-index",
          "--find-links",
          temporaryRoot,
          "--require-hashes",
          "-r",
          hindsightProbeRequirementsPath,
        ],
        { encoding: "utf8" },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      expect(result.status, output).not.toBe(0);
      expect(output).toContain("DO NOT MATCH THE HASHES");
      expect(fs.existsSync(path.join(installTarget, "hindsight_client"))).toBe(false);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
