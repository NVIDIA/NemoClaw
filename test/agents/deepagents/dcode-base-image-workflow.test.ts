// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type Step = {
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const baseDockerfiles = [
  "Dockerfile.base",
  "agents/hermes/Dockerfile.base",
  "agents/langchain-deepagents-code/Dockerfile.base",
] as const;

function pinnedAptVersion(dockerfile: string, packageName: string): string {
  const source = fs.readFileSync(path.join(repoRoot, dockerfile), "utf8");
  const version = source.match(new RegExp(`^\\s*${packageName}=([^\\s\\\\]+)`, "m"))?.[1];
  expect(version, `${dockerfile} must pin ${packageName}`).toBeDefined();
  return version as string;
}

function writePythonDistribution(
  root: string,
  moduleName: string,
  distributionName: string,
  version: string,
): void {
  const moduleRoot = path.join(root, moduleName);
  fs.mkdirSync(moduleRoot, { recursive: true });
  fs.writeFileSync(path.join(moduleRoot, "__init__.py"), "", "utf8");
  const metadataRoot = path.join(
    root,
    `${distributionName.replaceAll("-", "_")}-${version}.dist-info`,
  );
  fs.mkdirSync(metadataRoot, { recursive: true });
  fs.writeFileSync(
    path.join(metadataRoot, "METADATA"),
    `Metadata-Version: 2.1\nName: ${distributionName}\nVersion: ${version}\n`,
    "utf8",
  );
}

describe("base-image dependency contracts", () => {
  it.each(Array.from(baseDockerfiles, (value) => [value]))(
    "keeps shared apt dependencies in %s pinned and aligned (#6679)",
    (dockerfile) => {
      const curlVersions = baseDockerfiles.map((dockerfile) =>
        pinnedAptVersion(dockerfile, "curl"),
      );

      expect(new Set(curlVersions).size).toBe(1);

      const source = fs.readFileSync(path.join(repoRoot, dockerfile), "utf8");
      expect(source, dockerfile).toMatch(/^FROM\s+\S+@sha256:[0-9a-f]{64}\s*$/m);
    },
  );

  it("validates each local Deep Agents Code candidate before publication (#12086)", () => {
    const action = YAML.parse(
      fs.readFileSync(
        path.join(repoRoot, ".github", "actions", "build-base-image-platform", "action.yaml"),
        "utf8",
      ),
    ) as { runs?: { steps?: Step[] } };
    const steps = action.runs?.steps ?? [];
    const setupBuildx =
      steps.find((candidate) => candidate.name === "Set up Docker Buildx") ??
      (() => {
        throw new Error("Base-image platform action is missing the Buildx setup");
      })();
    const localBuild =
      steps.find((candidate) => candidate.name === "Build Deep Agents Code platform candidate") ??
      (() => {
        throw new Error("Base-image platform action is missing the local DCode build");
      })();
    const identity =
      steps.find(
        (candidate) => candidate.name === "Bind Deep Agents Code local candidate to OCI layout",
      ) ??
      (() => {
        throw new Error("Base-image platform action is missing the DCode candidate identity");
      })();
    const validate =
      steps.find((candidate) => candidate.name === "Validate Deep Agents Code base runtime") ??
      (() => {
        throw new Error("Base-image platform action is missing the runtime validation");
      })();
    const publish =
      steps.find(
        (candidate) => candidate.name === "Push validated Deep Agents Code platform digest",
      ) ??
      (() => {
        throw new Error("Base-image platform action is missing the DCode publication");
      })();
    const registryBuild = steps.find(
      (candidate) => candidate.name === "Build and push platform digest",
    );
    const localBuildIndex = steps.indexOf(localBuild);
    const identityIndex = steps.indexOf(identity);
    const validateIndex = steps.indexOf(validate);
    const publishIndex = steps.indexOf(publish);
    const exportIndex = steps.findIndex((candidate) => candidate.name === "Export platform digest");

    expect(setupBuildx.with).toMatchObject({ version: "v0.37.1" });
    expect(localBuild.if).toBe("${{ inputs.agent == 'langchain-deepagents-code' }}");
    expect(localBuild.with).toMatchObject({
      platforms: "${{ inputs.platform }}",
      provenance: false,
      sbom: false,
    });
    expect(localBuild.with?.outputs).toContain("type=docker");
    expect(localBuild.with?.outputs).toContain("type=oci");
    expect(JSON.stringify(localBuild)).not.toContain("push=true");
    expect(JSON.stringify(localBuild)).not.toContain("cache-to");
    expect(identity.run).toContain('if [ "$local_image_id" != "$config_digest" ]');
    expect(identity.run).toContain("expected one platform manifest");
    expect(validate.if).toBe("${{ inputs.agent == 'langchain-deepagents-code' }}");
    expect(validate.env).toEqual({
      PLATFORM: "${{ inputs.platform }}",
      REFERENCE: "${{ steps.dcode-candidate-identity.outputs.reference }}",
    });
    expect(validate.run).toContain("scripts/checks/validate-dcode-runtime-contract.mts");
    expect(validate.run).toContain("test -x /usr/bin/dos2unix");
    expect(registryBuild?.if).toBe("${{ inputs.agent != 'langchain-deepagents-code' }}");
    expect(
      JSON.stringify(steps.slice(0, validateIndex)),
      "DCode validation must precede every registry write",
    ).not.toMatch(/push=true|cache-to|imagetools create/u);
    expect([
      localBuildIndex < identityIndex,
      identityIndex < validateIndex,
      validateIndex < publishIndex,
      publishIndex < exportIndex,
    ]).toEqual([true, true, true, true]);

    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-publish-"));
    const dockerPath = path.join(temporaryRoot, "docker");
    const argumentsPath = path.join(temporaryRoot, "arguments");
    const outputPath = path.join(temporaryRoot, "github-output");
    const ociLayout = path.join(temporaryRoot, "candidate-oci");
    const digest = `sha256:${"a".repeat(64)}`;
    const image = "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base";
    fs.writeFileSync(
      dockerPath,
      `#!/bin/sh
set -eu
printf '%s\\n' "$@" > "$FAKE_DOCKER_ARGUMENTS"
metadata=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --metadata-file)
      shift
      metadata="$1"
      ;;
  esac
  shift
done
test -n "$metadata"
printf '{"containerimage.descriptor":{"digest":"%s"}}\\n' "$FAKE_PUBLISHED_DIGEST" > "$metadata"
`,
      { mode: 0o755 },
    );
    try {
      const result = spawnSync("bash", ["-c", publish.run ?? ""], {
        encoding: "utf8",
        env: {
          ...process.env,
          ARCH: "amd64",
          DIGEST: digest,
          FAKE_DOCKER_ARGUMENTS: argumentsPath,
          FAKE_PUBLISHED_DIGEST: digest,
          GITHUB_OUTPUT: outputPath,
          IMAGE: image,
          OCI_LAYOUT: ociLayout,
          PATH: `${temporaryRoot}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: temporaryRoot,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(fs.readFileSync(argumentsPath, "utf8").trim().split("\n")).toEqual([
        "buildx",
        "imagetools",
        "create",
        "--prefer-index=false",
        "--tag",
        `${image}@${digest}`,
        "--metadata-file",
        path.join(temporaryRoot, "dcode-base-amd64-publication.json"),
        `oci-layout://${ociLayout}@${digest}`,
      ]);
      expect(fs.readFileSync(outputPath, "utf8")).toBe(`digest=${digest}\n`);
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ["a complete runtime", "complete", 0, ""],
    [
      "a missing deepagents module",
      "missing-deepagents",
      1,
      "missing required runtime module: deepagents",
    ],
    [
      "a missing deepagents_code module",
      "missing-deepagents-code",
      1,
      "missing required runtime module: deepagents_code",
    ],
    [
      "a Docker command failure",
      "command-failure",
      1,
      "Docker command failed without a recognized runtime diagnostic",
    ],
    ["noisy success evidence", "noisy-success", 1, "returned invalid evidence"],
  ])(
    "accepts only %s from the shared runtime validator (#12086)",
    (_case, outcome, expected, diagnostic) => {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-runtime-"));
      const dockerPath = path.join(temporaryRoot, "docker");
      const argumentsPath = path.join(temporaryRoot, "arguments");
      const validatorPath = path.join(
        repoRoot,
        "scripts/checks/validate-dcode-runtime-contract.mts",
      );
      const reference = `sha256:${"a".repeat(64)}`;
      fs.writeFileSync(
        dockerPath,
        `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_DOCKER_ARGUMENTS"
case "$FAKE_DOCKER_OUTCOME" in
  complete) printf '%s\\n' 'nemoclaw-dcode-runtime-contract-ok' ;;
  noisy-success) printf '%s\\n' 'nemoclaw-dcode-runtime-contract-ok' 'unexpected-output' ;;
  missing-deepagents) printf '%s\\n' "ModuleNotFoundError: No module named 'deepagents'" >&2; exit 31 ;;
  missing-deepagents-code) printf '%s\\n' "ModuleNotFoundError: No module named 'deepagents_code'" >&2; exit 32 ;;
  command-failure) printf '%s\\n' 'Authorization: Bearer should-not-leak' >&2; exit 33 ;;
  *) exit 34 ;;
esac
`,
        { mode: 0o755 },
      );
      try {
        const result = spawnSync(
          process.execPath,
          ["--no-warnings", validatorPath, "--reference", reference, "--platform", "linux/amd64"],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              FAKE_DOCKER_ARGUMENTS: argumentsPath,
              FAKE_DOCKER_OUTCOME: outcome,
              PATH: `${temporaryRoot}:${process.env.PATH ?? ""}`,
            },
          },
        );
        expect(result.status === 0 ? 0 : 1, result.stderr).toBe(expected);
        const args = fs.readFileSync(argumentsPath, "utf8").trim().split("\n");
        expect(args).toEqual([
          "run",
          "--rm",
          "--platform",
          "linux/amd64",
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--read-only",
          "--user",
          "999:999",
          "--entrypoint",
          "/opt/venv/bin/python3",
          reference,
          "-I",
          "/usr/local/lib/nemoclaw/validate-dcode-runtime-contract.py",
        ]);
        expect(result.stderr).not.toContain("ModuleNotFoundError");
        expect(result.stderr).not.toContain("should-not-leak");
        expect(result.stderr).toContain(diagnostic);
        const reportsMissingModule = outcome.startsWith("missing-");
        expect(result.stderr).toContain(
          reportsMissingModule ? `reference=${JSON.stringify(reference)}` : "",
        );
        expect(result.stderr).toContain(reportsMissingModule ? 'platform="linux/amd64"' : "");
      } finally {
        fs.rmSync(temporaryRoot, { force: true, recursive: true });
      }
    },
  );

  it.each([
    ["a complete runtime", undefined, "0.7.5", "0.1.55", "0.7.5", 0, ""],
    [
      "a missing deepagents module",
      "deepagents",
      "0.7.5",
      "0.1.55",
      "0.7.5",
      1,
      "No module named 'deepagents'",
    ],
    [
      "a missing deepagents_code module",
      "deepagents_code",
      "0.7.5",
      "0.1.55",
      "0.7.5",
      1,
      "No module named 'deepagents_code'",
    ],
    [
      "the wrong installed version",
      undefined,
      "0.7.4",
      "0.1.55",
      "0.7.5",
      1,
      "runtime versions do not match",
    ],
    [
      "a lock mismatch",
      undefined,
      "0.7.5",
      "0.1.55",
      "0.7.4",
      1,
      "runtime contract does not match deepagents lock",
    ],
  ])(
    "accepts only %s in the isolated Python runtime contract (#12086)",
    (
      _case,
      missingModule,
      deepagentsVersion,
      dcodeVersion,
      lockedDeepagentsVersion,
      expected,
      expectedError,
    ) => {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-python-"));
      const sitePackages = path.join(temporaryRoot, "site-packages");
      const lockPath = path.join(temporaryRoot, "requirements.lock");
      const validatorPath = path.join(
        repoRoot,
        "agents/langchain-deepagents-code/validate-runtime-contract.py",
      );
      fs.mkdirSync(sitePackages, { recursive: true });
      writePythonDistribution(sitePackages, "deepagents", "deepagents", deepagentsVersion);
      writePythonDistribution(sitePackages, "deepagents_code", "deepagents-code", dcodeVersion);
      fs.rmSync(
        missingModule
          ? path.join(sitePackages, missingModule)
          : path.join(sitePackages, "no-missing-module"),
        { force: true, recursive: true },
      );
      fs.writeFileSync(
        lockPath,
        [`deepagents==${lockedDeepagentsVersion} \\`, "deepagents-code==0.1.55 \\", ""].join("\n"),
        "utf8",
      );
      try {
        const result = spawnSync(
          "python3",
          [
            "-I",
            "-S",
            "-c",
            `import runpy, sys
site_packages, script, *arguments = sys.argv[1:]
sys.path.insert(0, site_packages)
sys.argv = [script, *arguments]
runpy.run_path(script, run_name="__main__")`,
            sitePackages,
            validatorPath,
            "--requirements-lock",
            lockPath,
          ],
          { encoding: "utf8" },
        );
        expect(result.status === 0 ? 0 : 1, result.stderr).toBe(expected);
        expect(result.stdout.trim()).toBe(
          expected === 0 ? "nemoclaw-dcode-runtime-contract-ok" : "",
        );
        expect(result.stderr).toContain(expectedError);
      } finally {
        fs.rmSync(temporaryRoot, { force: true, recursive: true });
      }
    },
  );
});
