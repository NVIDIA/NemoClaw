// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

type CandidateScenario = {
  attestationCount?: number;
  attestationDigest?: string;
  attestationLink?: string;
  attestationSizeAdjustment?: number;
  configArch?: string;
  configSizeAdjustment?: number;
  inspectArch?: string;
  inspectIdentity?: "config" | "workload";
  inspectId?: string;
  layerSizeAdjustment?: number;
  mutateLayer?: (layerPath: string, root: string) => void;
  sourceDigest?: string;
  sourceMalformed?: boolean;
  sourceSizeAdjustment?: number;
  workloadArch?: string;
  workloadMediaType?: string;
  workloadSizeAdjustment?: number;
};

type OciDescriptor = {
  digest: string;
  mediaType: string;
  platform?: { architecture: string; os: string };
  size: number;
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

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function writeBlob(root: string, content: string, digest = sha256(content)): void {
  const blobPath = path.join(root, "blobs", "sha256", digest.slice("sha256:".length));
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(blobPath, content, "utf8");
}

function createCandidateArchive(root: string, arch: string, scenario: CandidateScenario) {
  const sourceLayout = path.join(root, "source-layout");
  const configContent = JSON.stringify({
    architecture: scenario.configArch ?? arch,
    os: "linux",
  });
  const configDigest = sha256(configContent);
  const layerContent = `layer-${arch}`;
  const layerDigest = sha256(layerContent);
  const workloadContent = JSON.stringify({
    config: {
      digest: configDigest,
      mediaType: "application/vnd.oci.image.config.v1+json",
      size: Buffer.byteLength(configContent) + (scenario.configSizeAdjustment ?? 0),
    },
    layers: [
      {
        digest: layerDigest,
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        size: Buffer.byteLength(layerContent) + (scenario.layerSizeAdjustment ?? 0),
      },
    ],
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  });
  const workloadDigest = sha256(workloadContent);
  const workloadDescriptor: OciDescriptor = {
    digest: workloadDigest,
    mediaType: scenario.workloadMediaType ?? "application/vnd.oci.image.manifest.v1+json",
    platform: { architecture: scenario.workloadArch ?? arch, os: "linux" },
    size: Buffer.byteLength(workloadContent) + (scenario.workloadSizeAdjustment ?? 0),
  };
  const attestationContent = JSON.stringify({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  });
  const attestationDigest = scenario.attestationDigest ?? sha256(attestationContent);
  const attestationDescriptor = {
    annotations: {
      "vnd.docker.reference.digest": scenario.attestationLink ?? workloadDigest,
      "vnd.docker.reference.type": "attestation-manifest",
    },
    digest: attestationDigest,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    platform: { architecture: "unknown", os: "unknown" },
    size: Buffer.byteLength(attestationContent) + (scenario.attestationSizeAdjustment ?? 0),
  };
  const sourceIndex = {
    manifests: [
      workloadDescriptor,
      ...Array.from({ length: scenario.attestationCount ?? 1 }, () => attestationDescriptor),
    ],
    mediaType: "application/vnd.oci.image.index.v1+json",
    schemaVersion: 2,
  };
  const sourceContent = scenario.sourceMalformed ? "{" : JSON.stringify(sourceIndex);
  const sourceDigest = scenario.sourceDigest ?? sha256(sourceContent);
  const rootIndex = {
    manifests: [
      {
        digest: sourceDigest,
        mediaType: "application/vnd.oci.image.index.v1+json",
        size: Buffer.byteLength(sourceContent) + (scenario.sourceSizeAdjustment ?? 0),
      },
    ],
    mediaType: "application/vnd.oci.image.index.v1+json",
    schemaVersion: 2,
  };
  fs.mkdirSync(sourceLayout, { recursive: true });
  fs.writeFileSync(
    path.join(sourceLayout, "oci-layout"),
    '{"imageLayoutVersion":"1.0.0"}\n',
    "utf8",
  );
  fs.writeFileSync(path.join(sourceLayout, "index.json"), JSON.stringify(rootIndex), "utf8");
  writeBlob(sourceLayout, configContent);
  writeBlob(sourceLayout, layerContent);
  scenario.mutateLayer?.(
    path.join(sourceLayout, "blobs", "sha256", layerDigest.slice("sha256:".length)),
    root,
  );
  writeBlob(sourceLayout, workloadContent);
  writeBlob(sourceLayout, attestationContent, attestationDigest);
  writeBlob(sourceLayout, sourceContent, sourceDigest);
  const archive = path.join(root, "candidate.oci.tar");
  const tar = spawnSync("tar", ["-cf", archive, "-C", sourceLayout, "."], {
    encoding: "utf8",
  });
  expect(tar.status, tar.stderr).toBe(0);
  return {
    archive,
    configDigest,
    layerDigest,
    sourceDigest,
    sourceIndex,
    workloadDescriptor,
    workloadDigest,
  };
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
      provenance: "mode=min",
      sbom: false,
    });
    expect(localBuild.with?.outputs).toBe(
      "type=oci,dest=${{ runner.temp }}/dcode-base-${{ inputs.arch }}.oci.tar",
    );
    expect(JSON.stringify(localBuild)).not.toContain("push=true");
    expect(JSON.stringify(localBuild)).not.toContain("cache-to");
    expect(identity.run).toContain('[ "$local_image_id" != "$config_digest" ]');
    expect(identity.run).toContain('[ "$local_image_id" != "$workload_digest" ]');
    expect(identity.run).toContain("one provenance-wrapped source index");
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
printf '{"containerimage.descriptor":{"digest":"%s","mediaType":"%s"}}\\n' "$FAKE_PUBLISHED_DIGEST" "$FAKE_PUBLISHED_MEDIA_TYPE" > "$metadata"
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
          FAKE_PUBLISHED_MEDIA_TYPE: "application/vnd.oci.image.index.v1+json",
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
        "--tag",
        `${image}@${digest}`,
        "--metadata-file",
        path.join(temporaryRoot, "dcode-base-amd64-publication.json"),
        `oci-layout://${ociLayout}@${digest}`,
      ]);
      expect(fs.readFileSync(outputPath, "utf8")).toBe(`digest=${digest}\n`);
      const rejected = spawnSync("bash", ["-c", publish.run ?? ""], {
        encoding: "utf8",
        env: {
          ...process.env,
          ARCH: "arm64",
          DIGEST: digest,
          FAKE_DOCKER_ARGUMENTS: argumentsPath,
          FAKE_PUBLISHED_DIGEST: digest,
          FAKE_PUBLISHED_MEDIA_TYPE: "application/vnd.oci.image.manifest.v1+json",
          GITHUB_OUTPUT: path.join(temporaryRoot, "rejected-output"),
          IMAGE: image,
          OCI_LAYOUT: ociLayout,
          PATH: `${temporaryRoot}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: temporaryRoot,
        },
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        "published Deep Agents Code source index differs from the validated candidate",
      );
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ["a complete amd64 source index", "amd64", {}, 0, ""],
    ["a complete arm64 source index", "arm64", { inspectIdentity: "workload" }, 0, ""],
    [
      "malformed source index JSON",
      "amd64",
      { sourceMalformed: true },
      1,
      "source index is not one workload plus linked provenance",
    ],
    [
      "a malformed workload descriptor",
      "amd64",
      { workloadMediaType: "text/plain" },
      1,
      "source index is not one workload plus linked provenance",
    ],
    [
      "a source index without provenance",
      "amd64",
      { attestationCount: 0 },
      1,
      "source index is not one workload plus linked provenance",
    ],
    [
      "a source index with an extra descriptor",
      "amd64",
      { attestationCount: 2 },
      1,
      "source index is not one workload plus linked provenance",
    ],
    [
      "provenance linked to another workload",
      "amd64",
      { attestationLink: `sha256:${"b".repeat(64)}` },
      1,
      "source index is not one workload plus linked provenance",
    ],
    [
      "a workload for another architecture",
      "amd64",
      { workloadArch: "arm64" },
      1,
      "source index is not one workload plus linked provenance",
    ],
    [
      "a source descriptor with the wrong digest",
      "amd64",
      { sourceDigest: `sha256:${"c".repeat(64)}` },
      1,
      "source index descriptor does not match its blob",
    ],
    [
      "a source descriptor with the wrong size",
      "amd64",
      { sourceSizeAdjustment: 1 },
      1,
      "source index descriptor does not match its blob",
    ],
    [
      "a workload descriptor with the wrong size",
      "amd64",
      { workloadSizeAdjustment: 1 },
      1,
      "workload descriptor does not match its blob",
    ],
    [
      "a provenance descriptor with the wrong digest",
      "amd64",
      { attestationDigest: `sha256:${"e".repeat(64)}` },
      1,
      "provenance descriptor does not match its blob",
    ],
    [
      "a provenance descriptor with the wrong size",
      "amd64",
      { attestationSizeAdjustment: 1 },
      1,
      "provenance descriptor does not match its blob",
    ],
    [
      "a config descriptor with the wrong size",
      "amd64",
      { configSizeAdjustment: 1 },
      1,
      "runtime descriptor does not match its blob",
    ],
    [
      "a layer descriptor with the wrong size",
      "amd64",
      { layerSizeAdjustment: 1 },
      1,
      "runtime descriptor does not match its blob",
    ],
    [
      "a symlinked layer blob",
      "amd64",
      {
        mutateLayer: (layerPath: string, root: string) => {
          const externalLayer = path.join(root, "external-layer");
          fs.renameSync(layerPath, externalLayer);
          fs.symlinkSync(externalLayer, layerPath);
        },
      },
      1,
      "runtime blob is missing or unsafe",
    ],
    [
      "a config for another architecture",
      "amd64",
      { configArch: "arm64" },
      1,
      "config platform does not match the build",
    ],
    [
      "a loaded image with another config digest",
      "amd64",
      { inspectId: `sha256:${"d".repeat(64)}` },
      1,
      "Docker candidate does not match its OCI layout",
    ],
    [
      "a loaded image reporting another architecture",
      "amd64",
      { inspectArch: "arm64" },
      1,
      "Docker candidate does not match its OCI layout",
    ],
  ])(
    "accepts only %s for isolated runtime validation (#12086)",
    (_case, arch, scenario, expected, diagnostic) => {
      const action = YAML.parse(
        fs.readFileSync(
          path.join(repoRoot, ".github", "actions", "build-base-image-platform", "action.yaml"),
          "utf8",
        ),
      ) as { runs?: { steps?: Step[] } };
      const identity =
        (action.runs?.steps ?? []).find(
          (candidate) => candidate.name === "Bind Deep Agents Code local candidate to OCI layout",
        ) ??
        (() => {
          throw new Error("Base-image platform action is missing the DCode candidate identity");
        })();
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-identity-"));
      const fixture = createCandidateArchive(temporaryRoot, arch, scenario as CandidateScenario);
      const dockerPath = path.join(temporaryRoot, "docker");
      const argumentsPath = path.join(temporaryRoot, "docker-arguments");
      const loadedArchive = path.join(temporaryRoot, "loaded.tar");
      const outputPath = path.join(temporaryRoot, "github-output");
      const ociLayout = path.join(temporaryRoot, "extracted-source");
      const validationLayout = path.join(temporaryRoot, "validation-layout");
      const expectedImageId =
        (scenario as CandidateScenario).inspectId ??
        ((scenario as CandidateScenario).inspectIdentity === "workload"
          ? fixture.workloadDigest
          : fixture.configDigest);
      fs.writeFileSync(
        dockerPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_DOCKER_ARGUMENTS"
case "$1" in
  load)
    cat > "$FAKE_DOCKER_ARCHIVE"
    ;;
  image)
    printf '%s linux %s\\n' "$FAKE_IMAGE_ID" "$FAKE_IMAGE_ARCH"
    ;;
  *)
    exit 90
    ;;
esac
`,
        { mode: 0o755 },
      );
      try {
        const result = spawnSync("bash", ["-c", identity.run ?? ""], {
          encoding: "utf8",
          env: {
            ...process.env,
            ARCH: arch,
            FAKE_DOCKER_ARCHIVE: loadedArchive,
            FAKE_DOCKER_ARGUMENTS: argumentsPath,
            FAKE_IMAGE_ARCH: (scenario as CandidateScenario).inspectArch ?? arch,
            FAKE_IMAGE_ID: expectedImageId,
            GITHUB_OUTPUT: outputPath,
            OCI_ARCHIVE: fixture.archive,
            OCI_LAYOUT: ociLayout,
            PATH: `${temporaryRoot}:${process.env.PATH ?? ""}`,
            RUNNER_TEMP: temporaryRoot,
            VALIDATION_LAYOUT: validationLayout,
          },
        });
        expect(result.status === 0 ? 0 : 1, result.stderr).toBe(expected);
        expect(result.stderr).toContain(diagnostic);
        expected === 0
          ? (() => {
              const loadedLayout = path.join(temporaryRoot, "loaded-layout");
              fs.mkdirSync(loadedLayout);
              const unpack = spawnSync("tar", ["-xf", loadedArchive, "-C", loadedLayout], {
                encoding: "utf8",
              });
              expect(unpack.status, unpack.stderr).toBe(0);
              const loadedIndex = JSON.parse(
                fs.readFileSync(path.join(loadedLayout, "index.json"), "utf8"),
              );
              expect(loadedIndex).toEqual({
                manifests: [
                  {
                    ...fixture.workloadDescriptor,
                    annotations: {
                      "io.containerd.image.name": `docker.io/library/nemoclaw-dcode-base-candidate-${arch}:latest`,
                      "org.opencontainers.image.ref.name": "latest",
                    },
                  },
                ],
                mediaType: "application/vnd.oci.image.index.v1+json",
                schemaVersion: 2,
              });
              expect(fs.readdirSync(path.join(loadedLayout, "blobs", "sha256")).sort()).toEqual(
                [fixture.configDigest, fixture.layerDigest, fixture.workloadDigest]
                  .map((digest) => digest.slice("sha256:".length))
                  .sort(),
              );
              expect(fs.readFileSync(outputPath, "utf8")).toBe(
                `digest=${fixture.sourceDigest}\nreference=${expectedImageId}\n`,
              );
              expect(fs.readFileSync(argumentsPath, "utf8").trim().split("\n")).toEqual([
                "load",
                `image inspect --format {{.Id}} {{.Os}} {{.Architecture}} docker.io/library/nemoclaw-dcode-base-candidate-${arch}:latest`,
              ]);
            })()
          : undefined;
      } finally {
        fs.rmSync(temporaryRoot, { force: true, recursive: true });
      }
    },
  );

  it("produces platform source indexes accepted by the managed-base contract (#12086)", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-index-"));
    const amd64Root = path.join(temporaryRoot, "amd64");
    const arm64Root = path.join(temporaryRoot, "arm64");
    const fakeBin = path.join(temporaryRoot, "bin");
    fs.mkdirSync(amd64Root);
    fs.mkdirSync(arm64Root);
    fs.mkdirSync(fakeBin);
    const amd64 = createCandidateArchive(amd64Root, "amd64", {});
    const arm64 = createCandidateArchive(arm64Root, "arm64", {});
    const finalDigest = `sha256:${"f".repeat(64)}`;
    const image = "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base";
    fs.writeFileSync(
      path.join(temporaryRoot, "amd64.json"),
      JSON.stringify(amd64.sourceIndex),
      "utf8",
    );
    fs.writeFileSync(
      path.join(temporaryRoot, "arm64.json"),
      JSON.stringify(arm64.sourceIndex),
      "utf8",
    );
    fs.writeFileSync(
      path.join(temporaryRoot, "published.json"),
      JSON.stringify({
        manifests: [...amd64.sourceIndex.manifests, ...arm64.sourceIndex.manifests],
        mediaType: "application/vnd.oci.image.index.v1+json",
        schemaVersion: 2,
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      `#!/bin/sh
set -eu
test "$1 $2 $3 $5" = "buildx imagetools inspect --raw"
case "$4" in
  "$FINAL_REFERENCE") cat "$FIXTURE_ROOT/published.json" ;;
  "$AMD64_REFERENCE") cat "$FIXTURE_ROOT/amd64.json" ;;
  "$ARM64_REFERENCE") cat "$FIXTURE_ROOT/arm64.json" ;;
  *) exit 90 ;;
esac
`,
      { mode: 0o755 },
    );
    try {
      const result = spawnSync(
        path.join(repoRoot, "scripts", "checks", "validate-managed-base-index.sh"),
        [`${image}@${finalDigest}`, amd64.sourceDigest, arm64.sourceDigest],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            AMD64_REFERENCE: `${image}@${amd64.sourceDigest}`,
            ARM64_REFERENCE: `${image}@${arm64.sourceDigest}`,
            FINAL_REFERENCE: `${image}@${finalDigest}`,
            FIXTURE_ROOT: temporaryRoot,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        "linux/amd64": amd64.workloadDigest,
        "linux/arm64": arm64.workloadDigest,
      });
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
