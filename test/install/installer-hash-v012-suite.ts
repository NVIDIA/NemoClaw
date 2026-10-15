// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  preparedReleaseArgs,
  prepareReleaseFixtureRuntime,
} from "../helpers/openshell-installer-template";

const GUARDED_INSTALLER_SHA256 = "4d5970db104adeddcb90e38ff13f482c5e41e47897007c14b181c5ab2c3f9ff2";

function guardedInstaller(repoRoot: string, source: string): string {
  const fixture = fs.readFileSync(
    path.join(repoRoot, "test/fixtures/openshell-v012-installer-legacy-guard.sh"),
    "utf8",
  );
  const marker = "# Every installation entrypoint";
  assert.ok(fixture.includes(marker));
  const guard = fixture.slice(fixture.indexOf(marker)).trimEnd() + "\n\n";
  const before = [
    "  # MCP policy enforcement and credential replacement execute in",
    "  # openshell-sandbox. When that host artifact is present, require the native",
    "  # MCP policy marker from that exact binary.",
  ].join("\n");
  const after = [
    "  # OpenShell 0.1.2 enforces MCP policy in its supervisor image. Recognize",
    "  # only its exact pinned sandbox artifacts here, not version text alone.",
    "  # Runtime policy verification still precedes credential/provider changes.",
  ].join("\n");
  const fallback =
    [
      "    local sandbox_digest",
      '    sandbox_digest="$(file_sha256 "$sandbox_bin")" || return 1',
      '    if [ "$(pinned_sandbox_build_version "$sandbox_digest")" = "0.1.2" ]; then',
      "      return 0",
      "    fi",
    ].join("\n") + "\n";
  const featureCheck =
    '  if [[ "$sandbox_strings" != *"$OPENSHELL_SANDBOX_MCP_FEATURE"* ]]; then\n';
  const installStart = "# invalidState: a consumed";
  for (const required of [before, featureCheck, installStart]) assert.ok(source.includes(required));
  return source
    .replace(before, after)
    .replace(featureCheck, featureCheck + fallback)
    .replace(installStart, guard + installStart);
}

// Share the collected test file's fixture lifecycle and temporary-directory cleanup.
export function registerV012TemplateCases(
  repoRoot: string,
  createFixture: (version: string) => string,
): void {
  it("admits only the exact thread-group supervisor template with OpenShell 0.1.2", () => {
    const root = createFixture("0.1.2");
    prepareReleaseFixtureRuntime(repoRoot, root, { currentProcessReader: true });
    const run = () => spawnSync("node", preparedReleaseArgs(repoRoot, root), { encoding: "utf8" });
    expect(run().status).toBe(0);
    fs.appendFileSync(path.join(root, "src/lib/onboard/docker-driver-gateway-runtime.ts"), "//x");
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("not base-trusted") });
  });

  it("admits the exact standalone legacy guard but rejects altered guard behavior", () => {
    const root = createFixture("0.1.2");
    prepareReleaseFixtureRuntime(repoRoot, root);
    const installer = path.join(root, "scripts/install-openshell.sh");
    const source = guardedInstaller(repoRoot, fs.readFileSync(installer, "utf8"));
    fs.writeFileSync(installer, source);
    const run = () => spawnSync("node", preparedReleaseArgs(repoRoot, root), { encoding: "utf8" });
    const accepted = run();
    expect(accepted.status, accepted.stderr).toBe(0);
    const pins = JSON.parse(accepted.stdout) as {
      source: string;
      operationalTemplateSha256: string;
    }[];
    const installers = pins.filter((pin) => pin.source === "installer");
    expect(installers.length).toBeGreaterThan(0);
    expect(
      installers.every((pin) => pin.operationalTemplateSha256 === GUARDED_INSTALLER_SHA256),
    ).toBe(true);

    for (const [original, replacement] of [
      ["constants.O_NOFOLLOW", "0"],
      ["  verify();", "  // verify();"],
      ["if (missing(error)) continue;", "continue;"],
      [
        '    if (!version) deny("the installed CLI version is unknown");',
        '    if (!version) deny("the installed CLI version is unknown");\n    if (Number(version[1]) > 0 || Number(version[2]) > 0) return;',
      ],
    ]) {
      const mutated = source.replace(original, replacement);
      expect(mutated).not.toBe(source);
      fs.writeFileSync(installer, mutated);
      const denied = run();
      expect(denied).toMatchObject({
        status: 1,
        stdout: "",
        stderr: expect.stringContaining("installer operational template is not base-trusted"),
      });
    }
  });

  it.each(["0.1.2", "1.0.0"])(
    "preserves registered legacy data after a partial CLI upgrade to %s",
    (installedVersion) => {
      const root = createFixture("0.1.2");
      prepareReleaseFixtureRuntime(repoRoot, root);
      const installer = path.join(root, "scripts/install-openshell.sh");
      fs.writeFileSync(installer, guardedInstaller(repoRoot, fs.readFileSync(installer, "utf8")));
      const config = path.join(root, "config");
      const registration = path.join(config, "openshell/gateways/nemoclaw");
      fs.mkdirSync(registration, { recursive: true });
      const metadata = path.join(registration, "metadata.json");
      const retained = path.join(registration, "retained-state");
      const binary = path.join(root, "bin/openshell");
      const calls = path.join(root, "calls");
      const download = path.join(root, "download");
      fs.writeFileSync(
        metadata,
        JSON.stringify({ name: "nemoclaw", gateway_endpoint: "https://localhost:8080" }),
      );
      fs.writeFileSync(retained, "legacy user data\n");
      fs.writeFileSync(
        binary,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$1" in\n  --version) printf 'openshell ${installedVersion}\\n' ;;\n  sandbox) printf '[{"name":"retained-sandbox"}]\\n' ;;\n  *) exit 99 ;;\nesac\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(root, "bin/curl"), `#!/bin/sh\ntouch '${download}'\nexit 99\n`, {
        mode: 0o755,
      });
      const paths = [metadata, retained, binary];
      const before = paths.map((file) => fs.readFileSync(file, "utf8"));
      const result = spawnSync("bash", [installer], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: config,
          OPENSHELL_SYSTEM_GATEWAY_DIR: path.join(root, "system"),
          OPENSHELL_GATEWAY_ENDPOINT: "",
          PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
        },
      });
      expect(result).toMatchObject({
        status: 1,
        stderr: expect.stringContaining(
          "a legacy gateway has sandboxes or an incomplete inventory",
        ),
      });
      expect(fs.readFileSync(calls, "utf8")).toBe("--version\nsandbox list -g nemoclaw -o json\n");
      expect(fs.existsSync(download)).toBe(false);
      expect(paths.map((file) => fs.readFileSync(file, "utf8"))).toEqual(before);
    },
  );
}
