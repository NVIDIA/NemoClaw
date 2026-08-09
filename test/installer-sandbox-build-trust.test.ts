// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const PARSER = path.join(REPO_ROOT, "scripts/checks/extract-installer-pins.mts");
const INSTALLER_TEMPLATE = fs.readFileSync(
  path.join(REPO_ROOT, "scripts/install-openshell.sh"),
  "utf8",
);
const BREV_TEMPLATE = fs.readFileSync(
  path.join(REPO_ROOT, "scripts/brev-launchable-ci-cpu.sh"),
  "utf8",
);
const BLUEPRINT_TEMPLATE = fs.readFileSync(
  path.join(REPO_ROOT, "nemoclaw-blueprint/blueprint.yaml"),
  "utf8",
);
const V00101_SANDBOX_BUILD_DIGESTS = [
  "a2704babbb468fd0a359bfdd9844de71095b730758541b4ca8cbab77d4018920",
  "88300e35f153123e4dc3021c537834dd6c0a09665a4a6d3974cd285d512345c4",
] as const;
const ARBITRARY_SANDBOX_BUILD_DIGESTS = ["a".repeat(64), "b".repeat(64)] as const;
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

function mutateSandboxBuildFunction(
  source: string,
  mutate: (functionSource: string) => string,
): string {
  const start = source.indexOf("pinned_sandbox_build_version() {");
  const end = source.indexOf("\ncomponent_build_version() {", start);
  assert.notEqual(start, -1, "sandbox build function start marker must exist");
  assert.notEqual(end, -1, "sandbox build function end marker must exist");
  const functionSource = source.slice(start, end);
  const mutated = mutate(functionSource);
  assert.notEqual(
    mutated,
    functionSource,
    "sandbox build fixture mutation must change the function",
  );
  return `${source.slice(0, start)}${mutated}${source.slice(end)}`;
}

function addSandboxBuildPins(
  source: string,
  version: string,
  digests: readonly [string, string],
): string {
  return mutateSandboxBuildFunction(source, (functionSource) =>
    functionSource.replace(
      "    *)",
      `    ${digests[0]} | \\
      ${digests[1]})
      printf '%s\\n' "${version}"
      ;;
    *)`,
    ),
  );
}

function runParser(mutate: (source: string) => string = (source) => source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sandbox-build-trust-"));
  const scriptsDir = path.join(root, "scripts");
  const blueprintDir = path.join(root, "nemoclaw-blueprint");
  const installer = path.join(scriptsDir, "install-openshell.sh");
  const brevInstaller = path.join(scriptsDir, "brev-launchable-ci-cpu.sh");
  const blueprint = path.join(blueprintDir, "blueprint.yaml");
  tempDirs.push(root);
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(blueprintDir, { recursive: true });
  fs.writeFileSync(installer, mutate(INSTALLER_TEMPLATE));
  fs.writeFileSync(brevInstaller, BREV_TEMPLATE);
  fs.writeFileSync(blueprint, BLUEPRINT_TEMPLATE);
  return spawnSync(
    "node",
    [
      "--experimental-strip-types",
      "--no-warnings",
      PARSER,
      "--blueprint",
      blueprint,
      "--installer",
      installer,
      "--brev-installer",
      brevInstaller,
      "--format",
      "tsv",
    ],
    { encoding: "utf8" },
  );
}

describe("standalone sandbox build trust", () => {
  it("accepts the complete required fallback identity set", () => {
    expect(runParser().status).toBe(0);
  });

  it("accepts the dormant reviewed v0.0.101 identities before selection", () => {
    const result = runParser((source) =>
      addSandboxBuildPins(source, "0.0.101", V00101_SANDBOX_BUILD_DIGESTS),
    );

    expect(result.status).toBe(0);
  });

  it("rejects an arbitrary structurally valid identity addition", () => {
    const result = runParser((source) =>
      addSandboxBuildPins(source, "0.0.98", ARBITRARY_SANDBOX_BUILD_DIGESTS),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must use only base-trusted binary identities");
    expect(result.stderr).toContain(`unexpected=[0.0.98:${"a".repeat(64)}`);
  });

  it("prevents a selected release from self-authorizing replacement binaries", () => {
    const result = runParser((source) =>
      mutateSandboxBuildFunction(source, (functionSource) =>
        functionSource
          .replace(
            "a4b0c38ed90a6dd4b4f312ad3727824a25ec478d88d4e65d22a82377b18e6214",
            ARBITRARY_SANDBOX_BUILD_DIGESTS[0],
          )
          .replace(
            "f60ce5b76e4dbd645f690c8519852d261c8cf6a70b5fc56db329a23d68bc7b2e",
            ARBITRARY_SANDBOX_BUILD_DIGESTS[1],
          ),
      ),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must use only base-trusted binary identities");
    expect(result.stderr).toContain(`unexpected=[0.0.99:${"a".repeat(64)}`);
  });

  it("rejects a missing required platform identity", () => {
    const result = runParser((source) =>
      mutateSandboxBuildFunction(source, (functionSource) =>
        functionSource.replace(
          `a4b0c38ed90a6dd4b4f312ad3727824a25ec478d88d4e65d22a82377b18e6214 | \\
      f60ce5b76e4dbd645f690c8519852d261c8cf6a70b5fc56db329a23d68bc7b2e`,
          "a4b0c38ed90a6dd4b4f312ad3727824a25ec478d88d4e65d22a82377b18e6214",
        ),
      ),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "missing=[0.0.99:f60ce5b76e4dbd645f690c8519852d261c8cf6a70b5fc56db329a23d68bc7b2e]",
    );
  });

  it("rejects a trusted digest bound to the wrong release", () => {
    const result = runParser((source) =>
      mutateSandboxBuildFunction(source, (functionSource) =>
        functionSource.replace(`printf '%s\\n' "0.0.99"`, `printf '%s\\n' "0.0.82"`),
      ),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must use only base-trusted binary identities");
    expect(result.stderr).toContain(
      "unexpected=[0.0.82:a4b0c38ed90a6dd4b4f312ad3727824a25ec478d88d4e65d22a82377b18e6214",
    );
  });

  it.each([
    ["altered control flow", (source: string) => source.replace("return 1", "return 0")],
    [
      "duplicate digest",
      (source: string) =>
        source.replace(
          "      32ca44fe7d9e6d332f2a753c6b8a1a6117b7388281dad9b5274d23ffc67e216f)",
          "      32ca44fe7d9e6d332f2a753c6b8a1a6117b7388281dad9b5274d23ffc67e216f | \\\n      f9f991a24d10772ad5d24ae27a8ea6baad8cac671695bd90fcd0355e0e0ad198)",
        ),
    ],
    [
      "literalized input",
      (source: string) => source.replace('local digest="$1"', "local digest='$1'"),
    ],
    [
      "literalized selector",
      (source: string) => source.replace('case "$digest" in', "case '$digest' in"),
    ],
    [
      "malformed version",
      (source: string) => source.replace(`printf '%s\\n' "0.0.72"`, `printf '%s\\n' "v0.0.72"`),
    ],
    [
      "unknown command",
      (source: string) =>
        source.replace(`printf '%s\\n' "0.0.72"`, `printf '%s\\n' "0.0.72"\n      echo unexpected`),
    ],
  ] as const)("rejects an untrusted grammar mutation: %s", (_name, mutate) => {
    const result = runParser((source) => mutateSandboxBuildFunction(source, mutate));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Installer pin extraction failed: pinned_sandbox_build_version",
    );
  });
});
