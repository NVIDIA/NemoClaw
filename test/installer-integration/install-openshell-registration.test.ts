// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLinuxArm64DownloadFixture } from "../support/openshell-arm64-download";
import { runCommandWithInstalledVersion } from "../support/openshell-installed-version";

function registryArrivalHook(directory: string): string {
  const hook = path.join(directory, "registry-arrival.sh");
  fs.writeFileSync(
    hook,
    `seed_concurrent_registry() {
  local root="$HOME/.nemoclaw"
  if [ "\${NEMOCLAW_TEST_SCOPED_REGISTRY:-}" = 1 ]; then root="$root/gateways/19260"; fi
  mkdir -p "$root"
  printf '%s\\n' '{"sandboxes":{"concurrent-box":{"name":"concurrent-box"}}}' > "$root/sandboxes.json"
}
curl() {
  if [ "$NEMOCLAW_TEST_STATE_APPEARS_AT" = download ]; then seed_concurrent_registry; fi
  command curl "$@"
}
brew() {
  if [ "$NEMOCLAW_TEST_STATE_APPEARS_AT" = "formula probe" ] && [ "$*" = "list --formula openshell" ]; then
    seed_concurrent_registry
  fi
  command brew "$@"
}
`,
  );
  return hook;
}

describe("OpenShell installer gateway registrations", { timeout: 15_000 }, () => {
  it.each(["user", "system", "fixed-system"] as const)(
    "preserves components when the %s gateway registration is a regular file",
    (legacyRegistrationFile) => {
      const result = runCommandWithInstalledVersion("0.0.116", {}, { legacyRegistrationFile });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("a legacy gateway registration is not a directory");
      expect(result.downloads).toBe("");
      expect(result.retainedFilesUnchanged).toBe(true);
    },
  );

  it.each([false, true])(
    "preserves binaries when a registry appears during download [scoped=%s]",
    (scoped) => {
      const { tmp, fakeBin } = createLinuxArm64DownloadFixture();
      try {
        const binary = path.join(fakeBin, "openshell");
        const original = fs.readFileSync(binary);
        const result = spawnSync(
          "bash",
          [path.join(import.meta.dirname, "../../scripts/install-openshell.sh")],
          {
            encoding: "utf8",
            timeout: 10_000,
            env: {
              ...process.env,
              HOME: tmp,
              XDG_CONFIG_HOME: path.join(tmp, "config"),
              OPENSHELL_SYSTEM_GATEWAY_DIR: path.join(tmp, "system-openshell"),
              XDG_BIN_HOME: "",
              NEMOCLAW_NON_INTERACTIVE: "1",
              NEMOCLAW_OPENSHELL_CHANNEL: "stable",
              NEMOCLAW_TEST_STATE_APPEARS_AT: "download",
              NEMOCLAW_TEST_SCOPED_REGISTRY: scoped ? "1" : "0",
              BASH_ENV: registryArrivalHook(tmp),
              PATH: `${fakeBin}:/usr/bin:/bin`,
            },
          },
        );
        expect(result.status, result.stdout + result.stderr).not.toBe(0);
        expect(result.stderr).toContain("retained NemoClaw sandbox records");
        expect(result.stderr).toContain("concurrent-box");
        expect(fs.readFileSync(binary)).toEqual(original);
        const registry = path.join(
          tmp,
          ".nemoclaw",
          ...(scoped ? ["gateways", "19260"] : []),
          "sandboxes.json",
        );
        expect(JSON.parse(fs.readFileSync(registry, "utf8"))).toEqual({
          sandboxes: { "concurrent-box": { name: "concurrent-box" } },
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.each(["download", "formula probe"])(
    "does not replace Homebrew components when a registry appears during %s",
    (phase) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-homebrew-state-arrival-"));
      try {
        const operations = path.join(root, "brew.log");
        const result = runCommandWithInstalledVersion(
          "0.1.6",
          {
            BASH_ENV: registryArrivalHook(root),
            NEMOCLAW_TEST_STATE_APPEARS_AT: phase,
          },
          {
            os: "Darwin",
            arch: "arm64",
            homebrewFormulaDownload: true,
            homebrewOperationLog: operations,
          },
        );
        expect(result.status, result.stdout + result.stderr).not.toBe(0);
        expect(result.stderr).toContain("retained NemoClaw sandbox records");
        expect(result.retainedFilesUnchanged).toBe(true);
        const observed = fs.existsSync(operations) ? fs.readFileSync(operations, "utf8") : "";
        expect(observed).not.toMatch(/^(?:install|reinstall) --formula /mu);
        expect(observed.includes("list --formula openshell")).toBe(phase === "formula probe");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
