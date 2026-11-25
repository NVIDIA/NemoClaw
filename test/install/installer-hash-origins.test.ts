// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const checker = new URL("../../scripts/check-installer-hash.sh", import.meta.url).pathname;
const digest = (body: string) => createHash("sha256").update(body).digest("hex");

// The real shell verifier owns URL validation and downloads. The parser and
// release transport are fixtures; parser admission has separate real-CLI tests.
function checkOrigins(version: string, repository: string) {
  const root = mkdtempSync(join(tmpdir(), "installer-origin-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const base = `https://github.com/${repository}/releases/download/v${version}`;
    const officialRepository = version === "0.1.10" ? "ai-openshell/openshell" : "NVIDIA/OpenShell";
    const archive = "openshell-x86_64-unknown-linux-musl.tar.gz";
    const formula = "fixture formula\n";
    const manifests = {
      "openshell-checksums-sha256.txt": `${digest("archive")}  ${archive}\n`,
      "openshell-gateway-checksums-sha256.txt": "",
      "openshell-sandbox-checksums-sha256.txt": "",
    };
    writeFileSync(join(root, "openshell.rb"), formula);
    Object.entries(manifests).forEach(([name, body]) => writeFileSync(join(root, name), body));
    const records = [
      ...Object.entries(manifests).map(([name, body]) =>
        ["manifest", version, "OpenShell release", name, digest(body)].join("\t"),
      ),
      ["formula", version, `${base}/openshell.rb`, "openshell.rb", digest(formula)].join("\t"),
      ["pin", version, "installer", archive, digest("archive")].join("\t"),
      ["pin", version, "installer", "openshell.rb", digest(formula)].join("\t"),
      ["pin", version, "Brev launchable", archive, digest("archive")].join("\t"),
    ];
    writeFileSync(join(root, "records.tsv"), records.join("\n") + "\n");
    writeFileSync(join(bin, "node"), '#!/bin/sh\ncat "$FIXTURE_ROOT/records.tsv"\n', {
      mode: 0o755,
    });
    writeFileSync(
      join(bin, "curl"),
      `#!/bin/bash
set -eu
output=""
url=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
[[ "$url" == "$EXPECTED_RELEASE_BASE/"* && -n "$output" ]]
printf '%s\\n' "$url" >> "$FIXTURE_ROOT/downloads"
cp "$FIXTURE_ROOT/\u0024{url##*/}" "$output"
`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", [checker], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FIXTURE_ROOT: root,
        EXPECTED_RELEASE_BASE: `https://github.com/${officialRepository}/releases/download/v${version}`,
      },
      timeout: 10_000,
    });
    const downloads =
      result.status === 0 ? readFileSync(join(root, "downloads"), "utf8").trim().split("\n") : [];
    return { ...result, downloads };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("installer release origins", () => {
  it.each([
    ["0.0.116", "NVIDIA/OpenShell"],
    ["0.1.9", "NVIDIA/OpenShell"],
    ["0.1.10", "ai-openshell/openshell"],
  ])("checks manifests and formula at the official %s origin", (version, repository) => {
    const result = checkOrigins(version, repository);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain("All installer hashes are current.");
    expect(result.downloads).toHaveLength(4);
    expect(
      result.downloads.every((url) =>
        url.startsWith(`https://github.com/${repository}/releases/download/v${version}/`),
      ),
    ).toBe(true);
  });

  it.each([
    ["0.1.10", "NVIDIA/OpenShell"],
    ["0.1.9", "ai-openshell/openshell"],
    ["0.1.10", "other/openshell"],
  ])("rejects a formula from the wrong %s origin %s", (version, repository) => {
    const result = checkOrigins(version, repository);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("invalid OpenShell formula record");
  });
});
