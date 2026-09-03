// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { dockerfileInstructions } from "../../helpers/dockerfile-run-commands";

const root = path.join(import.meta.dirname, "../../..");
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
  path.join(root, "internal", "security-reviews", "hermes-0.20.6-dependency-review.md"),
  "utf8",
);
const securityDependenciesPatch = fs.readFileSync(
  path.join(root, "agents", "hermes", "security-dependencies.patch"),
  "utf8",
);
const runtimeBoundariesPatch = fs.readFileSync(
  path.join(root, "agents", "hermes", "runtime-boundaries.patch"),
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

describe("Hermes 0.20.6 dependency review", () => {
  it("binds every active source identity to the reviewed release", () => {
    expect(arg("HERMES_VERSION")).toBe("v2026.8.27");
    expect(arg("HERMES_SEMVER")).toBe("0.20.6");
    expect(arg("HERMES_TARBALL_SHA256")).toBe(
      "e622723b5bf3cd6c1db974d92d32242f1cb63f61c1112b6f708b34d619ef0fc7",
    );
    expect(arg("HERMES_NPM_INTEGRITY")).toBe(
      "sha512-s5q1IEBifCBb77QMwkse4MRaAaoZSxIa4IkicIO3jL7MIdq15YvnSyiNvsTOWNBi6t3shFpIg+H7+9MJsOiSkg==",
    );
    expect(manifest).toContain('expected_version: "0.20.6"');
    expect(review).toContain("`5fc308a70719a83cccdbba4c0e39c23f5a8239d5`");
    expect(review).toContain("`e622723b5bf3cd6c1db974d92d32242f1cb63f61c1112b6f708b34d619ef0fc7`");
    expect(review).toContain("`a20c97b37910b6550d5ea50fbcc2d4187defe58cd57070b73863d069419c9440`");
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
    expect(review).toContain("config-less profile");
    expect(review).toContain("one-shot completion linger");
    expect(review).toContain("neutral-platform patch");
    expect(review).toContain("Unresolved upgrade-created high-impact concerns: `0`");
  });

  it("binds the CLI adapter version and source-fix constraints to target Hermes", () => {
    expect(cliAdapter.adapter_version).toBe(1);
    expect(cliAdapter.upstream_cli_version).toBe("0.20.6");
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

  it("ships the reviewed 0.20.6 dependency and runtime boundaries", () => {
    expect(dockerfileBase).toContain(
      "git -C /opt/hermes apply --check /tmp/hermes-security-dependencies.patch",
    );
    expect(dockerfileBase).toContain(
      "git -C /opt/hermes apply --check /tmp/hermes-runtime-boundaries.patch",
    );
    expect(dockerfile).toContain(
      "COPY agents/hermes/runtime-boundaries.patch /scripts/hermes-runtime-boundaries.patch",
    );
    expect(dockerfile).toContain("from tools.lazy_deps import install_specs");
    expect(dockerfile).toContain('hindsight-client==0.6.1');
    expect(dockerfileBase).toContain(
      "COPY agents/hermes/agent-browser-runtime/package.json",
    );
    expect(dockerfileBase).toContain(
      "/opt/nemoclaw-agent-browser-runtime/node_modules/.bin/agent-browser",
    );
    expect(arg("NEMOCLAW_HERMES_RUNTIME_BOUNDARIES_PATCH_SHA256")).toBe(
      "85c61b2391784bef749d955c0a6c84b3918c73ae752b1a984bd5a2fe42b2da57",
    );

    expect(securityDependenciesPatch).toContain('-  - "hindsight-client>=0.6.1"');
    expect(securityDependenciesPatch).toContain('+  - "hindsight-client==0.6.1"');
    expect(securityDependenciesPatch).toContain('AGENT_BROWSER_NPX_SPEC = "agent-browser@0.26.0"');
    expect(securityDependenciesPatch).toContain(
      "process_registry.wait_for_pending_completions(oneshot_task_id)",
    );
    expect(securityDependenciesPatch).toContain('lock_dir = hermes_home / "runtime"');

    for (const evidence of [
      "def nemoclaw_managed_gateway_plugins_only()",
      "nemoclaw_protected_process_control",
      "nemoclaw_sanitized_installer_env",
      'uv_bin = "/usr/local/bin/uv"',
      "cwd=trusted_cwd",
      "_NEMOCLAW_HINDSIGHT_REQUIREMENTS",
      "plugins/platforms/a2a/plugin.yaml",
      'return Path("/run/nemoclaw/hermes-gateway-lazy-packages")',
      'return Path("/opt/hermes/plugins")',
      'logger.debug("Managed gateway: user and project plugins disabled")',
    ]) {
      expect(runtimeBoundariesPatch).toContain(evidence);
    }
    expect(runtimeBoundariesPatch).toContain('-  - a2a_discover');
    expect(runtimeBoundariesPatch).toContain('-        from .tools import register_tools');

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
    }
    expect(dockerfileBase).toContain("uv pip check --python /opt/hermes/.venv/bin/python");
    expect(dockerfileBase).toContain("python-multipart==0.0.32");
    expect(dockerfileBase).toContain(
      "sha256:be54b7f3fa167bb83e4fcd936b887b708f4e57fe75911c02aebf53efaf8d938e",
    );
    expect(dockerfileBase).toContain(
      "sha256:ff6d3f776f16878c894e52e107296ffc890e913c611b1a4ec6c44e2821fe2e23",
    );
    expect(hindsightProbeRequirements).toContain(
      "hindsight-client==0.6.1",
    );
    expect(hindsightProbeRequirements).toContain(
      "aiohttp-retry==2.9.1",
    );

    expect(review).toContain("Hermes 0.20.6 already carries the security floors");
    expect(review).toContain("A reviewed npm lockfile binds the package archive");
    expect(review).toContain("Unresolved upgrade-created high-impact concerns: `0`");
    expect(review).toContain("They do not prove the");
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

  it("keeps the gateway installer offline and isolated from sandbox packages", () => {
    const instructions = dockerfileInstructions(dockerfile);
    const lazyInstallLayer = instructions.find(
      (instruction) =>
        instruction.keyword === "RUN" &&
        instruction.body.includes(
          "lazy_deps._venv_pip_install(('/tmp/nemoclaw-hindsight-probe/nemoclaw_lazy_probe-1.0.0-py3-none-any.whl',))",
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
      `chmod 0444 /tmp/nemoclaw-hindsight-probe/nemoclaw_lazy_probe-1.0.0-py3-none-any.whl`,
      `install -d -o root -g root -m 0755 /run/nemoclaw`,
      `printf '1\\n' > /run/nemoclaw/hermes-bundled-plugins-only`,
      `chmod 0444 /run/nemoclaw/hermes-bundled-plugins-only`,
      `rm -rf /run/nemoclaw/hermes-gateway-lazy-packages`,
      `install -d -o gateway -g gateway -m 0700 /run/nemoclaw/hermes-gateway-lazy-packages`,
      `test "$(stat -c '%U:%G %a' /run/nemoclaw/hermes-gateway-lazy-packages)" = "gateway:gateway 700"`,
      `rm -rf /sandbox/.hermes/lazy-packages`,
      `install -d -o sandbox -g sandbox -m 0750 /sandbox/.hermes/lazy-packages/nemoclaw_lazy_probe`,
      "NEMOCLAW_SANDBOX_TAMPER_FIXTURE = True",
      "nemoclaw_sandbox_tamper.pth",
      `chown -R sandbox:sandbox /sandbox/.hermes/lazy-packages`,
      `HERMES_LAZY_INSTALL_TARGET=/run/nemoclaw/hermes-gateway-lazy-packages`,
      "/usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups --",
      "lazy_deps._venv_pip_install(('/tmp/nemoclaw-hindsight-probe/nemoclaw_lazy_probe-1.0.0-py3-none-any.whl',))",
      "assert result.success, result.stderr or result.stdout",
      "import hermes_bootstrap, nemoclaw_lazy_probe",
      "assert m.version('nemoclaw-lazy-probe') == '1.0.0'",
      "assert pathlib.Path(nemoclaw_lazy_probe.__file__).resolve().is_relative_to(gateway_target)",
      "assert str(sandbox_target) not in sys.path",
      "assert not pathlib.Path('/tmp/nemoclaw-sandbox-lazy-pth-executed').exists()",
      `test "$(stat -c '%U:%G' /run/nemoclaw/hermes-gateway-lazy-packages/nemoclaw_lazy_probe/__init__.py)" = "gateway:gateway"`,
      `test ! -r /run/nemoclaw/hermes-gateway-lazy-packages/nemoclaw_lazy_probe/__init__.py`,
      `/run/nemoclaw/hermes-gateway-lazy-packages/.nemoclaw-sandbox-write-probe`,
      `test ! -e /run/nemoclaw/hermes-gateway-lazy-packages/.nemoclaw-sandbox-write-probe`,
      `rm -rf /run/nemoclaw/hermes-gateway-lazy-packages`,
      `rm -f /run/nemoclaw/hermes-bundled-plugins-only`,
      `rm -rf /sandbox/.hermes/lazy-packages`,
      `install -d -o sandbox -g sandbox -m 0750 /sandbox/.hermes/lazy-packages`,
      `chmod u=rwx,g=rx,o=,g-s /sandbox/.hermes/lazy-packages`,
    ];
    let previousIndex = -1;
    orderedContracts.forEach((contract) => {
      const contractIndex = layer.indexOf(contract, previousIndex + 1);
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
    expect(layer.match(/chmod u=rwx,g=rx,o=,g-s \/sandbox\/\.hermes\/lazy-packages/g)).toHaveLength(
      1,
    );
    expect(layer.lastIndexOf("rm -rf /sandbox/.cache")).toBeGreaterThan(
      layer.indexOf(
        "lazy_deps._venv_pip_install(('/tmp/nemoclaw-hindsight-probe/nemoclaw_lazy_probe-1.0.0-py3-none-any.whl',))",
      ),
    );
    expect(layer).not.toContain("https://");
    expect(layer).not.toContain(`test -z "$(find -P /opt/hermes/.venv`);
    expect(layer).not.toContain(`printf ''`);
    expect(layer).not.toContain("state-dir-guard");

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
