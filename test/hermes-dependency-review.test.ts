// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { dockerfileInstructions } from "./helpers/dockerfile-run-commands";

const root = path.join(import.meta.dirname, "..");
const dockerfileBase = fs.readFileSync(
  path.join(root, "agents", "hermes", "Dockerfile.base"),
  "utf8",
);
const dockerfile = fs.readFileSync(path.join(root, "agents", "hermes", "Dockerfile"), "utf8");
const config = fs.readFileSync(
  path.join(root, "agents", "hermes", "config", "managed-policy.ts"),
  "utf8",
);
const manifest = fs.readFileSync(path.join(root, "agents", "hermes", "manifest.yaml"), "utf8");
const cliAdapter = JSON.parse(
  fs.readFileSync(path.join(root, "agents", "hermes", "hermes-cli-adapter-v1.json"), "utf8"),
);
const review = fs.readFileSync(
  path.join(root, "internal", "security-reviews", "hermes-0.19.0-dependency-review.md"),
  "utf8",
);
const securityDependenciesPatch = fs.readFileSync(
  path.join(root, "agents", "hermes", "security-dependencies.patch"),
  "utf8",
);
const hindsightProbeRequirementsPath = path.join(
  root,
  "agents",
  "hermes",
  "hindsight-client-probe-requirements.txt",
);
const hindsightProbeRequirements = fs.readFileSync(hindsightProbeRequirementsPath, "utf8");

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
    const pinnedBaseDigest = dockerfile.match(
      /^ARG BASE_IMAGE=ghcr[.]io\/nvidia\/nemoclaw\/hermes-sandbox-base@(sha256:[0-9a-f]{64})$/mu,
    )?.[1];

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
    expect(pinnedBaseDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(review).toContain(
      `The \`BASE_IMAGE\` argument in \`agents/hermes/Dockerfile\` pins the patched multi-platform Open Container Initiative (OCI) index \`${pinnedBaseDigest}\`.`,
    );
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
    expect(dockerfile).toContain(
      "COPY agents/hermes/security-dependencies.patch /scripts/hermes-security-dependencies.patch",
    );
    expect(dockerfile).toContain("/scripts/hermes-security-dependencies.patch");
    expect(dockerfileBase).toContain(
      "git -C /opt/hermes apply --check /tmp/hermes-security-dependencies.patch",
    );
    expect(dockerfile).toContain("--include=hermes_cli/memory_setup.py");
    expect(dockerfile).toContain("--include=plugins/memory/hindsight/plugin.yaml");
    expect(dockerfile).toContain(
      "grep -Fq 'ensure(\"memory.hindsight\", prompt=False)' /opt/hermes/hermes_cli/memory_setup.py",
    );
    expect(dockerfile).toContain(
      "grep -Fqx '  - \"hindsight-client==0.6.1\"' /opt/hermes/plugins/memory/hindsight/plugin.yaml",
    );
    expect(dockerfile).toContain(
      "from tools.lazy_deps import ensure; ensure('memory.hindsight', prompt=False)",
    );
    expect(dockerfileBase).toContain(
      "HERMES_LAZY_INSTALL_TARGET=/tmp/nemoclaw-hindsight-client-probe",
    );
    expect(dockerfileBase).toContain(
      "COPY --chmod=0444 agents/hermes/hindsight-client-probe-requirements.txt /tmp/nemoclaw-hindsight-client-probe-requirements.txt",
    );
    expect(dockerfileBase).toContain(
      "ADD --chmod=0444 --checksum=sha256:9fdda176ab50f7cec8d7339c6608c148f0cd9ad7e65d9d76192f2db730bc330a https://files.pythonhosted.org/",
    );
    expect(dockerfileBase).toContain(
      "ADD --chmod=0444 --checksum=sha256:66d2759d1921838256a05a3f80ad7e724936f083e35be5abb5e16eed6be6dc54 https://files.pythonhosted.org/",
    );
    expect(hindsightProbeRequirements).toContain(
      "hindsight-client==0.6.1 \\\n    --hash=sha256:9fdda176ab50f7cec8d7339c6608c148f0cd9ad7e65d9d76192f2db730bc330a",
    );
    expect(hindsightProbeRequirements).toContain(
      "aiohttp-retry==2.9.1 \\\n    --hash=sha256:66d2759d1921838256a05a3f80ad7e724936f083e35be5abb5e16eed6be6dc54",
    );
    expect(dockerfileBase).toContain(`&& rm -rf \\
        /tmp/nemoclaw-hindsight-client-artifacts \\
        /tmp/nemoclaw-hindsight-client-probe \\
        /tmp/nemoclaw-hindsight-client-cache \\
        /tmp/nemoclaw-hindsight-client-probe-requirements.txt \\
        /sandbox/.hermes/lazy-packages \\
    && install -d -o sandbox -g sandbox -m 0750 /sandbox/.hermes/lazy-packages`);
    expect(dockerfileBase).toContain(
      "chmod 0555 /tmp/nemoclaw-hindsight-client-artifacts",
    );
    expect(dockerfileBase).toContain("import hindsight_client, importlib.metadata as m");
    const compatibilityLayer = dockerfileInstructions(dockerfileBase).find(
      (instruction) =>
        instruction.keyword === "RUN" &&
        instruction.body.includes("nemoclaw-hindsight-client-probe-requirements.txt"),
    );
    expect(compatibilityLayer).toBeDefined();
    const compatibilityInstall = compatibilityLayer?.body ?? "";
    expect(compatibilityInstall).toContain("--network=none");
    expect(compatibilityInstall).toContain("--no-deps --no-cache --offline --no-index");
    expect(compatibilityInstall).toContain("--require-hashes");
    expect(compatibilityInstall).not.toContain("ensure('memory.hindsight'");
    expect(compatibilityInstall.indexOf("/usr/local/bin/uv pip install")).toBeLessThan(
      compatibilityInstall.indexOf("import hindsight_client"),
    );
    expect(dockerfile).toContain("state-dir-guard.py lock");
    expect(dockerfile).toContain("--reuid=gateway --regid=gateway --init-groups");
    expect(dockerfile).toContain("gateway can modify locked Hermes lazy packages");
    expect(dockerfile).toContain("sandbox can modify locked Hermes lazy packages");
    expect(dockerfile).toContain(
      `test "$(stat -c '%U:%G %a' /sandbox/.hermes/lazy-packages)" = "sandbox:sandbox 750"`,
    );
    expect(dockerfile).toContain(
      `test "$(stat -c '%U:%G %a' /sandbox/.hermes)" = "sandbox:sandbox 3770"`,
    );
    expect(dockerfileBase).toContain("uv pip check --python /opt/hermes/.venv/bin/python");
    expect(arg("NODE_VERSION")).toBe("24.18.1");
    expect(arg("UV_VERSION")).toBe("0.11.33");
    expect(securityDependenciesPatch).toContain('hindsight = ["hindsight-client==0.6.1"]');
    expect(securityDependenciesPatch).not.toContain("hindsight-client==0.8.");
    expect(securityDependenciesPatch).toContain('ensure("memory.hindsight", prompt=False)');
    expect(securityDependenciesPatch).toContain('-  - "hindsight-client>=0.6.1"');
    expect(securityDependenciesPatch).toContain('+  - "hindsight-client==0.6.1"');
    for (const selection of [
      '"aiohttp==3.14.3"',
      '"cryptography==50.0.0"',
      '"alibabacloud-dingtalk==2.2.54"',
      '"mcp==1.28.1"',
      '"Pillow==12.3.0"',
      '"starlette==1.3.1"',
      '"tornado==6.5.7"',
    ]) {
      expect(securityDependenciesPatch).toContain(selection);
    }
    const addedPatchLines = securityDependenciesPatch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .join("\n");
    for (const supersededSelection of [
      '"aiohttp==3.14.1"',
      '"cryptography==48.0.1"',
      '"alibabacloud-dingtalk==2.2.42"',
    ]) {
      expect(addedPatchLines).not.toContain(supersededSelection);
    }
    for (const installedVersion of [
      "'agent-client-protocol': '0.9.0'",
      "'aiohttp': '3.14.3'",
      "'cryptography': '50.0.0'",
      "'mcp': '1.28.1'",
      "'pillow': '12.3.0'",
      "'starlette': '1.3.1'",
      "'tornado': '6.5.7'",
    ]) {
      expect(dockerfileBase).toContain(installedVersion);
    }
    expect(dockerfileBase).not.toContain("'aiohttp': '3.14.1'");
    expect(dockerfileBase).not.toContain("'cryptography': '48.0.1'");
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
    for (const advisory of ["GHSA-cq5v-8q36-5273", "GHSA-g6cj-pr64-35w5"]) {
      expect(review).toContain(advisory);
    }
    expect(review).toContain("`aiohttp==3.14.3`");
    expect(review).toContain("`cryptography==50.0.0`");
    expect(review).toContain("`alibabacloud-dingtalk==2.2.54`");
    expect(review).toContain(
      "contains 95 unique third-party package names across all retained environment markers",
    );
    expect(review).toContain(
      "Six exported packages—`colorama`, `concurrent-log-handler`, `portalocker`, `pywin32`, `pywinpty`, and `tzdata`—are guarded by `sys_platform == 'win32'`",
    );
    expect(review).toContain(
      "both published base jobs prepared, installed, and compatibility-checked 90 distributions",
    );
    expect(review).toContain("`agent-client-protocol==0.9.0`");
    expect(review).toContain("PyPI serves no PEP 740 provenance");
    expect(review).toContain("does not validate protocol sessions");
    expect(review).toContain("require separate product acceptance and end-to-end evidence");
    expect(review).toContain("95-package amd64 and arm64 capability-union evidence predates ACP");
    expect(review).toContain(
      "ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:0d07845fa3b02a0657d28e134eb2e1f4a96cc6260e2538f3d4eafe831c7e5c17",
    );
    expect(review).toContain("found 97 installed distributions");
    expect(review).toContain("contains 95 third-party runtime distributions");
    expect(review).toContain("Tornado `6.5.7` is the lowest version");
    expect(review).toContain("source-distribution-only");
    expect(review).toContain("`mcp==1.28.1`");
    expect(review).toContain("`Pillow==12.3.0`");
    expect(review).toContain("`starlette==1.3.1`");
    expect(review).toContain("`tornado==6.5.7`");
    expect(review).toContain("checksum-pinned Node.js `24.18.1`");
    expect(review).toContain("exact uv `0.11.33`");
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
      expect(output).toContain(
        "Expected sha256 9fdda176ab50f7cec8d7339c6608c148f0cd9ad7e65d9d76192f2db730bc330a",
      );
      expect(fs.existsSync(path.join(installTarget, "hindsight_client"))).toBe(false);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("keeps the sandbox lazy-installer probe offline", () => {
    const instructions = dockerfileInstructions(dockerfile);
    const lazyInstallLayer = instructions.find(
      (instruction) =>
        instruction.keyword === "RUN" &&
        instruction.body.includes(
          "from tools.lazy_deps import ensure; ensure('memory.hindsight', prompt=False)",
        ),
    );
    expect(lazyInstallLayer).toBeDefined();

    const layer = lazyInstallLayer?.body ?? "";
    const orderedContracts = [
      "/opt/hermes/.venv/bin/python -I -m ensurepip --upgrade --default-pip",
      "/opt/hermes/.venv/bin/python -I -m pip --version",
      "chmod 644 /opt/hermes/.venv/.lock",
      `test "$(stat -c '%U:%G %a' /opt/hermes/.venv/.lock)" = "root:root 644"`,
      `test "$(stat -c '%U:%G %a' /opt/hermes/.venv/bin/pip)" = "root:root 755"`,
      `venv_violation="$(find -P /opt/hermes/.venv ! -type l`,
      `test -z "$venv_violation"`,
      `venv_link_owner_violation="$(find -P /opt/hermes/.venv -type l`,
      `test -z "$venv_link_owner_violation"`,
      `venv_links_file="$(mktemp)"`,
      `find -P /opt/hermes/.venv -type l -printf '%P -> %l\\n' > "$venv_links_file"`,
      `LC_ALL=C sort -o "$venv_links_file" "$venv_links_file"`,
      `venv_links="$(cat "$venv_links_file")"`,
      `rm -f "$venv_links_file"`,
      `expected_venv_links="$(printf '%s\\n'`,
      "'bin/python -> /usr/bin/python3'",
      "'bin/python3 -> python'",
      "'bin/python3.13 -> python'",
      `"lib/python3.13/site-packages/certifi/cacert.pem -> $SSL_CERT_FILE"`,
      "'lib64 -> lib'",
      `test "$venv_links" = "$expected_venv_links"`,
      `test "$(readlink -e /opt/hermes/.venv/bin/python)" = "/usr/bin/python3.13"`,
      `test "$(readlink -e /opt/hermes/.venv/lib64)" = "/opt/hermes/.venv/lib"`,
      `test "$(stat -Lc '%U:%G %a %F' /opt/hermes/.venv/bin/python)" = "root:root 755 regular file"`,
      `test "$(stat -Lc '%U:%G %a %F' /opt/hermes/.venv/lib64)" = "root:root 755 directory"`,
      "/usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups --",
      "sh -eu -c",
      "/opt/hermes/.venv/bin/python -I -m pip --version >/dev/null",
      `if printf "" >> /opt/hermes/.venv/.lock 2>/dev/null; then exit 1; fi`,
      `if printf "" >> /opt/hermes/.venv/bin/pip 2>/dev/null; then exit 1; fi`,
      `if printf "" >> /opt/hermes/.venv/lib/python3.13/site-packages/pip/__init__.py 2>/dev/null; then exit 1; fi`,
      `if printf "" >> /opt/hermes/.venv/bin/python 2>/dev/null; then exit 1; fi`,
      `if printf "" > /opt/hermes/.venv/lib64/.nemoclaw-sandbox-write-probe 2>/dev/null; then exit 1; fi`,
      `if ln -sf /usr/bin/false /opt/hermes/.venv/bin/python 2>/dev/null; then exit 1; fi`,
      `exit 0`,
      `test ! -e /opt/hermes/.venv/lib/.nemoclaw-sandbox-write-probe`,
      `chmod 0444 /tmp/nemoclaw-hindsight-probe/hindsight_client-0.6.1-py3-none-any.whl`,
      `rm -rf /sandbox/.hermes/lazy-packages`,
      `install -d -o sandbox -g sandbox -m 0750 /sandbox/.hermes/lazy-packages`,
      `chmod u=rwx,g=rx,o=,g-s /sandbox/.hermes/lazy-packages`,
      `test "$(stat -c '%U:%G %a' /sandbox/.hermes/lazy-packages)" = "sandbox:sandbox 750"`,
      `test -z "$(find /sandbox/.hermes/lazy-packages -mindepth 1 -print -quit)"`,
      "from tools.lazy_deps import ensure; ensure('memory.hindsight', prompt=False)",
    ];
    let previousIndex = -1;
    orderedContracts.forEach((contract) => {
      const contractIndex = layer.indexOf(contract);
      expect(
        contractIndex,
        `Missing or misordered lazy-install contract: ${contract}`,
      ).toBeGreaterThan(previousIndex);
      previousIndex = contractIndex;
    });
    expect(layer).toContain("-perm /022");
    expect(layer).not.toContain("--network=none");
    expect(layer).toContain("PIP_NO_INDEX=1");
    expect(layer).toContain("UV_FIND_LINKS=/tmp/nemoclaw-hindsight-probe");
    expect(layer).toContain("UV_OFFLINE=1");
    expect(layer).toContain("NEMOCLAW_BUILD_PROBE_FIXTURE");
    expect(
      layer.match(/chmod u=rwx,g=rx,o=,g-s \/sandbox\/\.hermes\/lazy-packages/g),
    ).toHaveLength(2);
    expect(layer.lastIndexOf("rm -rf /sandbox/.cache")).toBeGreaterThan(
      layer.indexOf("from tools.lazy_deps import ensure; ensure('memory.hindsight', prompt=False)"),
    );
    expect(layer).not.toContain("https://");
    expect(layer).not.toContain(`test -z "$(find -P /opt/hermes/.venv`);
    expect(layer).not.toContain(`printf ''`);

    const activeUser = instructions
      .filter(
        (instruction) =>
          instruction.keyword === "USER" &&
          instruction.start < (lazyInstallLayer?.start ?? Number.POSITIVE_INFINITY),
      )
      .at(-1);
    expect(activeUser?.body.trim()).toBe("root");
  });
});
