// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const RESOLVER = path.join(import.meta.dirname, "e2e", "lib", "cloudflared-version-resolver.sh");

/** Quote a string for the inline bash resolver harness. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Provide deterministic Debian-version ordering for resolver unit tests. */
function fakeDpkgScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" != "--compare-versions" ]]; then
  exit 2
fi
rank() {
  case "\${1:-}" in
    2026.4.30) printf '20260430' ;;
    2026.5.1~rc1) printf '20260500' ;;
    2026.5.1) printf '20260501' ;;
    2026.5.9) printf '20260509' ;;
    2026.5.10) printf '20260510' ;;
    2026.6.0) printf '20260600' ;;
    1:2026.5.1) printf '120260501' ;;
    *) printf 'bad version syntax: %s\\n' "\${1:-}" >&2; return 1 ;;
  esac
}
left="$(rank "\${2:-}")" || exit 2
right="$(rank "\${4:-}")" || exit 2
case "\${3:-}" in
  eq) [[ "$left" -eq "$right" ]] ;;
  ge) [[ "$left" -ge "$right" ]] ;;
  gt) [[ "$left" -gt "$right" ]] ;;
  *) exit 2 ;;
esac
`;
}

/** Execute the resolver in an isolated PATH with the fake dpkg shim first. */
function runResolver(
  availableVersions: string,
  minVersion = "2026.5.1",
  overrideVersion?: string,
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloudflared-resolver-"));
  const fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "dpkg"), fakeDpkgScript(), { mode: 0o755 });
  const args = [shQuote(availableVersions), shQuote(minVersion)];
  if (overrideVersion !== undefined) {
    args.push(shQuote(overrideVersion));
  }
  try {
    return spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `source ${shQuote(RESOLVER)}; cloudflared_resolve_package_version ${args.join(" ")}`,
      ],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ""}` },
      },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("cloudflared APT package resolver", () => {
  it("fails closed when the Cloudflare APT repo returns no versions", () => {
    const result = runResolver("");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no cloudflared versions available");
  });

  it("fails when no signed APT version meets the configured floor", () => {
    const result = runResolver("2026.4.30\n2026.5.1~rc1", "2026.5.1");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("meets minimum 2026.5.1");
  });

  it("preserves exact CLOUDFLARED_VERSION overrides for emergency repro", () => {
    const result = runResolver("2026.5.1\n2026.5.10", "2026.5.1", "2020.1.1");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("2020.1.1");
  });

  it("rejects invalid minimum versions before comparing package versions", () => {
    const result = runResolver("2026.5.1", "bad/min");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid CLOUDFLARED_MIN_VERSION");
  });

  it("fails closed when Cloudflare APT metadata includes an invalid version", () => {
    const result = runResolver("2026.5.1\nbad/min", "2026.5.1");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid cloudflared version from Cloudflare APT repo");
  });

  it("uses Debian package ordering when choosing the newest version", () => {
    const result = runResolver("2026.5.9\n2026.5.10\n2026.6.0\n1:2026.5.1", "2026.5.1");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("1:2026.5.1");
  });
});
