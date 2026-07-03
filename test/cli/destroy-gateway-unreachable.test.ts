// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * #6046: when the OpenShell gateway is down, `sandbox delete` fails with a
 * connection-refused transport error. `destroy` used to abort fatally with no
 * bypass. `--force` must now fall back to local cleanup; without it, destroy
 * still fails but points at the recovery paths.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runWithEnv, testTimeoutOptions } from "./helpers";

// Fake openshell whose `sandbox delete` fails as if the gateway is down; every
// other call succeeds so the destroy flow reaches the delete.
const GATEWAY_DOWN_OPENSHELL = [
  "#!/bin/sh",
  'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then exit 0; fi',
  'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
  '  printf "tcp connect error: Connection refused (os error 61)\\n" >&2',
  "  exit 1",
  "fi",
  "exit 0",
].join("\n");

function fixture(): { home: string; registryPath: string; localBin: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-destroy-gwdown-"));
  const localBin = path.join(home, "bin");
  const registryDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(localBin, { recursive: true });
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      sandboxes: {
        alpha: {
          name: "alpha",
          model: "test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
      },
      defaultSandbox: "alpha",
    }),
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(localBin, "openshell"), GATEWAY_DOWN_OPENSHELL, { mode: 0o755 });
  fs.writeFileSync(path.join(localBin, "docker"), ["#!/bin/sh", "exit 0"].join("\n"), {
    mode: 0o755,
  });
  return { home, registryPath: path.join(registryDir, "sandboxes.json"), localBin };
}

function registryHasAlpha(registryPath: string): boolean {
  const reg = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  return Boolean(reg.sandboxes?.alpha);
}

describe("CLI destroy when the gateway is unreachable (#6046)", () => {
  it("removes the local sandbox record with --force", testTimeoutOptions(30_000), () => {
    const { home, registryPath, localBin } = fixture();
    try {
      const r = runWithEnv("alpha destroy --force", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      // --force succeeds (exit 0); the gateway-unreachable warning goes to
      // stderr (not captured on success), so assert the behavioral outcome:
      // the local record is removed and destroy reports success on stdout.
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("Sandbox 'alpha' destroyed");
      expect(registryHasAlpha(registryPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails with a recovery hint when --force is absent", testTimeoutOptions(30_000), () => {
    const { home, registryPath, localBin } = fixture();
    try {
      const r = runWithEnv("alpha destroy -y", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).not.toBe(0);
      expect(r.out).toContain("The OpenShell gateway is unreachable");
      expect(r.out).toContain("--force");
      expect(registryHasAlpha(registryPath)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
