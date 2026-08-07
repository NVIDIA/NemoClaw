// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  publicationAgents,
  publicationPlatforms,
  runManagedImagePromotion,
  runPublicationBarrier,
} from "./helpers/managed-image-publication-barrier";

type Step = {
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type MatrixEntry = {
  agent?: string;
  arch?: string;
  artifact_platform?: string;
  base_alias?: string;
  base_image?: string;
  base_repository?: string;
  display_name?: string;
  dockerfile?: string;
  image?: string;
  repository?: string;
  platform?: string;
  required_binary?: string;
  runner?: string;
};

type Job = {
  env?: Record<string, unknown>;
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  "runs-on"?: string;
  steps?: Step[];
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: { include?: MatrixEntry[] };
  };
  "timeout-minutes"?: number;
  uses?: string;
};

type Workflow = {
  concurrency?: {
    "cancel-in-progress"?: string | boolean;
    group?: string;
  };
  env?: Record<string, string>;
  jobs?: Record<string, Job>;
  on?: {
    pull_request?: {
      branches?: string[];
      paths?: string[];
    };
    push?: {
      paths?: string[];
    };
    workflow_call?: unknown;
  };
  permissions?: Record<string, string>;
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const fullShaAction = /^[^@]+@[0-9a-f]{40}$/iu;
const managedInputPaths = [
  ".dockerignore",
  ".github/actions/ci-reviewed-npm-audit/**",
  ".github/workflows/managed-images.yaml",
  "Dockerfile",
  "agents/**",
  "ci/npm-audit-exceptions.json",
  "ci/reviewed-npm-audit.json",
  "nemoclaw/**",
  "nemoclaw-blueprint/**",
  "scripts/**",
  "src/lib/actions/sandbox/openshell-child-visible-credentials.v*.json",
  "src/lib/core/json-types.ts",
  "src/lib/core/ports.ts",
  "src/lib/messaging/**",
  "src/lib/onboard/managed-bootstrap/envelope.ts",
  "src/lib/onboard/managed-startup/**",
  "src/lib/security/credential-hash.ts",
  "src/lib/state/paths.ts",
  "src/lib/state/state-root.ts",
  "src/lib/tool-disclosure.ts",
  "tools/mcp-tool-discovery-runtime/**",
  "tsconfig.runtime-preloads.json",
] as const;

function readWorkflow(file: string): Workflow {
  return YAML.parse(
    fs.readFileSync(path.join(repoRoot, ".github", "workflows", file), "utf8"),
  ) as Workflow;
}

function required<T>(value: T | undefined, message: string): T {
  return (
    value ??
    (() => {
      throw new Error(message);
    })()
  );
}

function step(job: Job, name: string): Step {
  return required(
    job.steps?.find((candidate) => candidate.name === name),
    `managed-image workflow is missing '${name}'`,
  );
}

function isStrictChildPath(root: string, candidate: string): boolean {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function managedPublisher(workflow: Workflow): Job {
  return required(
    workflow.jobs?.["build-and-validate"],
    "managed-image workflow is missing its publisher",
  );
}

const managedBuilder = managedPublisher;

function managedPrBuilder(workflow: Workflow): Job {
  return required(
    workflow.jobs?.["pr-build-and-entrypoint"],
    "managed-image workflow is missing its all-agent PR build and runtime gate",
  );
}

function managedPrActivation(workflow: Workflow): Job {
  return required(
    workflow.jobs?.["pr-managed-activation"],
    "managed-image workflow is missing its exact all-agent PR activation gate",
  );
}

function managedPromoter(workflow: Workflow): Job {
  return required(
    workflow.jobs?.promote,
    "managed-image workflow is missing its aggregate promoter",
  );
}

function publicationBoundaryErrors(baseWorkflow: Workflow, managedWorkflow: Workflow): string[] {
  const triggerPaths = baseWorkflow.on?.push?.paths ?? [];
  const caller = required(
    baseWorkflow.jobs?.["publish-managed-images"],
    "base-image workflow is missing the managed-image publisher",
  );
  const publisher = managedPublisher(managedWorkflow);
  const promoter = managedPromoter(managedWorkflow);
  const steps = publisher.steps ?? [];
  const build = step(publisher, "Build and push managed image by digest");
  const base = step(publisher, "Validate exact base image contract");
  const validate = step(publisher, "Validate exact managed image before promotion");
  const workflowSource = JSON.stringify(managedWorkflow);
  const publisherSource = JSON.stringify(publisher);
  const validationMarkers = [
    'mktemp -d "$RUNNER_TEMP/anonymous-docker-XXXXXX"',
    'DOCKER_CONFIG="$anonymous_config" docker pull --platform "$PLATFORM" "$reference"',
    "bootstrap the GHCR package",
    "/opt/nemoclaw-blueprint/blueprint.yaml",
    "/usr/local/share/nemoclaw/node-tar-inventory.json",
    "/usr/local/share/nemoclaw/corporate-ca.pem",
    'entry.status !== "fixed"',
    '--entrypoint "$REQUIRED_BINARY"',
    "io.nvidia.nemoclaw.managed-image.contract",
    "io.nvidia.nemoclaw.managed-image.startup-profile",
    "io.nvidia.nemoclaw.managed-image.capabilities",
    "io.nvidia.nemoclaw.managed-image.cohort",
    "^ghrun-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$",
    "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION",
    "@openclaw/diagnostics-otel",
    "@openclaw/brave-plugin",
    "@openclaw/discord",
    "@tencent-weixin/openclaw-weixin",
    "@openclaw/slack",
    "@openclaw/whatsapp",
    "@openclaw/msteams",
    "@openclaw/googlechat",
    "/sandbox/.openclaw/npm/projects",
    'const nodeModulesRoot = path.join(projectRoot, "node_modules")',
    'path.join(nodeModulesRoot, ...name.split("/"))',
    "lstatSync(packageRoot).isDirectory()",
    "lstatSync(manifestPath).isFile()",
    "realpathSync(nodeModulesRoot)",
    "realpathSync(packageRoot)",
    "packageRelative.startsWith(`..${path.sep}`)",
    "path.isAbsolute(packageRelative)",
    "matches.length !== 1",
    "microsoft-teams-apps",
    "config.plugins?.entries?.[id]?.enabled !== false",
    'config["platforms"].get(name) != {"enabled": False}',
    "run-managed-image-direct-e2e.ts",
    '--agent "$AGENT"',
    '--image "$reference"',
    '--platform "$PLATFORM"',
  ];
  const forbiddenPerLanePromotionMarkers = [
    'aliases=("${IMAGE}:${GITHUB_SHA}")',
    "docker buildx imagetools create",
    "docker tag ",
    "docker push ",
  ];
  const buildIndex = steps.indexOf(build);
  const validateIndex = steps.indexOf(validate);

  return [
    ...managedInputPaths
      .filter((input) => !triggerPaths.includes(input))
      .map((input) => `managed image trigger is missing ${input}`),
    ...(baseWorkflow.concurrency?.group === "base-image-${{ github.ref }}"
      ? []
      : ["base image concurrency must be scoped by github.ref"]),
    ...(baseWorkflow.concurrency?.["cancel-in-progress"] ===
    "${{ !startsWith(github.ref, 'refs/tags/v') }}"
      ? []
      : ["v* release runs must never be cancelled"]),
    ...(caller.if?.includes("inputs.openclaw_version == ''")
      ? []
      : ["custom OpenClaw base builds must not publish managed images"]),
    ...(build.with?.outputs ===
      "type=image,name=${{ env.REGISTRY }}/${{ matrix.image }},push-by-digest=true,name-canonical=true,push=true" &&
    build.with.push === undefined &&
    build.with.tags === undefined
      ? []
      : ["managed images must be pushed by digest without consumer tags"]),
    ...(!workflowSource.includes("GITHUB_SHA:0:8") && !workflowSource.includes("format=short")
      ? []
      : ["managed image handoff and aliases must not use short source SHAs"]),
    ...(base.run?.includes('.reference == (.image + "@" + .digest)') &&
    base.run.includes(".sourceRevision == $revision") &&
    base.run.includes(".run == {id: $runId, attempt: $runAttempt}")
      ? []
      : ["managed image build must consume the same-run exact base digest contract"]),
    ...validationMarkers
      .filter((marker) => !validate.run?.includes(marker))
      .map((marker) => `exact managed image validation is missing ${marker}`),
    ...forbiddenPerLanePromotionMarkers
      .filter((marker) => publisherSource.includes(marker))
      .map((marker) => `per-agent lane must not publish mutable alias with ${marker}`),
    ...(buildIndex >= 0 && buildIndex < validateIndex
      ? []
      : ["managed image validation must follow its immutable digest build"]),
    ...(promoter.needs === "build-and-validate"
      ? []
      : ["aggregate promotion must require every matrix lane"]),
  ];
}

describe("complete managed-image publication workflow", () => {
  it("rejects managed package paths redirected outside node_modules", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-plugin-"));
    try {
      const nodeModulesRoot = path.join(fixtureRoot, "project", "node_modules");
      const outsideScope = path.join(fixtureRoot, "outside-scope");
      const installedPackageRoot = path.join(nodeModulesRoot, "direct-package");
      const escapedPackageRoot = path.join(nodeModulesRoot, "@scope", "plugin");
      fs.mkdirSync(installedPackageRoot, { recursive: true });
      fs.mkdirSync(path.join(outsideScope, "plugin"), { recursive: true });
      fs.symlinkSync(outsideScope, path.join(nodeModulesRoot, "@scope"));

      expect(isStrictChildPath(nodeModulesRoot, installedPackageRoot)).toBe(true);
      expect(isStrictChildPath(nodeModulesRoot, escapedPackageRoot)).toBe(false);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("starts after exact base contracts with complete main triggers and does not cancel release-tag runs (#7744)", () => {
    const baseWorkflow = readWorkflow("base-image.yaml");
    const managedWorkflow = readWorkflow("managed-images.yaml");
    const publisher = required(
      baseWorkflow.jobs?.["publish-managed-images"],
      "base-image workflow is missing the managed-image publisher",
    );

    expect(publicationBoundaryErrors(baseWorkflow, managedWorkflow)).toEqual([]);
    expect(JSON.stringify(managedWorkflow)).not.toContain("config.plugins?.installs?.[id]");
    const validationRun =
      step(managedPublisher(managedWorkflow), "Validate exact managed image before promotion")
        .run ?? "";
    expect(validationRun).not.toContain('path.join(projectsRoot, entry.name, "package.json")');
    const channelGuardEnd = validationRun.indexOf("managed OpenClaw channel");
    const channelGuardStart = validationRun.lastIndexOf("for (const id of [", channelGuardEnd);
    expect(channelGuardStart).toBeGreaterThan(-1);
    expect(validationRun.slice(channelGuardStart, channelGuardEnd)).toContain('"googlechat",');
    const weakenedWorkflow = structuredClone(managedWorkflow);
    const weakenedValidation = step(
      managedPublisher(weakenedWorkflow),
      "Validate exact managed image before promotion",
    );
    weakenedValidation.run = weakenedValidation.run?.replace(
      "!fs.lstatSync(manifestPath).isFile()",
      "false",
    );
    expect(publicationBoundaryErrors(baseWorkflow, weakenedWorkflow)).toContain(
      "exact managed image validation is missing lstatSync(manifestPath).isFile()",
    );
    const projectRootWeakenedWorkflow = structuredClone(managedWorkflow);
    const projectRootWeakenedValidation = step(
      managedPublisher(projectRootWeakenedWorkflow),
      "Validate exact managed image before promotion",
    );
    projectRootWeakenedValidation.run = projectRootWeakenedValidation.run?.replace(
      'path.join(nodeModulesRoot, ...name.split("/"))',
      "",
    );
    expect(publicationBoundaryErrors(baseWorkflow, projectRootWeakenedWorkflow)).toContain(
      'exact managed image validation is missing path.join(nodeModulesRoot, ...name.split("/"))',
    );
    expect(publisher).toMatchObject({
      needs: [
        "build-and-push-hermes",
        "build-and-push-dcode",
        "build-and-push-openclaw",
        "reviewed-npm-audit",
      ],
      permissions: {
        contents: "read",
        packages: "write",
      },
      uses: "./.github/workflows/managed-images.yaml",
    });
    expect(publisher.if).toContain("github.repository == 'NVIDIA/NemoClaw'");
    expect(publisher.if).toContain("github.ref == 'refs/heads/main'");
    expect(publisher.if).toContain("startsWith(github.ref, 'refs/tags/v')");

    const reviewedAudit = required(
      baseWorkflow.jobs?.["reviewed-npm-audit"],
      "base-image workflow is missing the reviewed npm audit",
    );
    expect(reviewedAudit).toMatchObject({
      if: "github.repository == 'NVIDIA/NemoClaw'",
      permissions: { contents: "read" },
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 15,
    });
    expect(step(reviewedAudit, "Checkout").with?.["persist-credentials"]).toBe(false);
    expect(step(reviewedAudit, "Audit reviewed production npm graphs")).toMatchObject({
      uses: "./.github/actions/ci-reviewed-npm-audit",
      with: {
        "report-dir": "artifacts/reviewed-npm-audit",
        "target-root": "${{ github.workspace }}",
      },
    });

    const basePublishers = [
      {
        agent: "hermes",
        artifact: "managed-base-${{ github.run_id }}-${{ github.run_attempt }}-hermes",
        job: "build-and-push-hermes",
        platformsJob: "build-hermes-platforms",
      },
      {
        agent: "langchain-deepagents-code",
        artifact:
          "managed-base-${{ github.run_id }}-${{ github.run_attempt }}-langchain-deepagents-code",
        job: "build-and-push-dcode",
        platformsJob: "build-dcode-platforms",
      },
      {
        agent: "openclaw",
        artifact: "managed-base-${{ github.run_id }}-${{ github.run_attempt }}-openclaw",
        job: "build-and-push-openclaw",
        platformsJob: "build-openclaw-platforms",
      },
    ] as const;

    for (const expectedPublisher of basePublishers) {
      const basePublisher = required(
        baseWorkflow.jobs?.[expectedPublisher.job],
        `base-image workflow is missing ${expectedPublisher.agent} manifest publisher`,
      );
      expect(basePublisher.needs).toEqual([expectedPublisher.platformsJob, "reviewed-npm-audit"]);
      const manifest = step(basePublisher, "Create and verify multi-platform manifest");
      const manifestRun = manifest.run ?? "";
      expect(manifest.id).toBe("manifest");
      expect(manifest.env?.AGENT).toBe(expectedPublisher.agent);
      expect(manifest.run).toContain('reference="$IMAGE@$digest"');
      expect(manifest.run).toContain('.["containerimage.descriptor"].digest');
      expect(manifest.run).toContain('--metadata-file "$candidate_metadata"');
      expect(manifest.run).toContain("scripts/checks/validate-managed-base-index.sh");
      expect(manifest.run).toContain("declare -A source_digests=()");
      expect(manifest.run).toContain('"${source_digests[linux/amd64]}"');
      expect(manifest.run).toContain('"${source_digests[linux/arm64]}"');
      expect(manifest.run).toContain("platform_digests_json=");
      expect(manifest.run).toContain("declare -A platform_digests=()");
      expect(manifest.run).toContain("scripts/export-managed-base-image-contract.sh");
      expect(manifest.run).toContain('"${platform_digests[linux/amd64]}"');
      expect(manifest.run).toContain('"${platform_digests[linux/arm64]}"');
      const validationIndex = manifestRun.indexOf("scripts/checks/validate-managed-base-index.sh");
      const promotionIndex = manifestRun.indexOf("publication_metadata=");
      expect(manifestRun.indexOf("candidate_tag=")).toBeLessThan(validationIndex);
      expect(validationIndex).toBeLessThan(promotionIndex);
      expect(manifestRun).toContain("published_digest=");
      expect(manifestRun).toContain('if [ "$published_digest" != "$digest" ]; then');
      expect(manifestRun).not.toContain("first_tag=");
      expect(manifestRun).not.toContain('imagetools create "${tag_args[@]}" "${sources[@]}"');
      expect(step(basePublisher, "Checkout").with?.["persist-credentials"]).toBe(false);
      expect(step(basePublisher, "Upload managed base image contract").with?.name).toBe(
        expectedPublisher.artifact,
      );

      const nativePlatforms = required(
        baseWorkflow.jobs?.[expectedPublisher.platformsJob],
        `base-image workflow is missing native ${expectedPublisher.agent} platforms`,
      );
      expect(nativePlatforms.needs).toEqual(["reviewed-npm-audit"]);
      expect(nativePlatforms.strategy?.matrix?.include).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            arch: "amd64",
            platform: "linux/amd64",
            runner: "ubuntu-24.04",
          }),
          expect.objectContaining({
            arch: "arm64",
            platform: "linux/arm64",
            runner: "ubuntu-24.04-arm",
          }),
        ]),
      );
    }
  });

  it("builds and exercises every shipped agent from an exact PR image before merge (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const prBuilder = managedPrBuilder(workflow);
    const matrix = prBuilder.strategy?.matrix?.include ?? [];
    const steps = prBuilder.steps ?? [];

    expect(prBuilder.if).toBe("github.event_name == 'pull_request'");
    expect(prBuilder["runs-on"]).toBe("ubuntu-24.04");
    expect(prBuilder["timeout-minutes"]).toBe(90);
    expect(prBuilder.permissions).toEqual({ contents: "read", packages: "write" });
    expect(step(prBuilder, "Checkout").with?.["persist-credentials"]).toBe(false);
    expect(step(prBuilder, "Checkout").with?.ref).toBe("${{ github.event.pull_request.head.sha }}");
    expect(matrix.map(({ agent }) => agent)).toEqual([
      "openclaw",
      "hermes",
      "langchain-deepagents-code",
    ]);
    expect(matrix.every(({ base_alias }) => base_alias?.endsWith(":latest"))).toBe(true);

    for (const action of steps.filter((candidate) => candidate.uses)) {
      expect(action.uses, action.name).toMatch(fullShaAction);
    }

    const resolveBase = required(
      step(prBuilder, "Resolve exact linux/amd64 PR base").run,
      "PR base resolution is missing",
    );
    expect(resolveBase).toContain('.platform.architecture == "amd64"');
    expect(resolveBase).toContain('reference="${BASE_REPOSITORY}@${digest}"');
    expect(resolveBase).toContain('actual="sha256:$(sha256sum "$exact_raw"');

    expect(step(prBuilder, "Build PR managed image locally").with).toMatchObject({
      platforms: "linux/amd64",
      load: true,
      push: false,
    });
    expect(step(prBuilder, "Exercise managed startup root stdin and hold").run).toContain(
      "run-managed-image-direct-e2e.ts",
    );
    const login = step(prBuilder, "Log in to GHCR for exact same-repository PR digest");
    const publish = step(prBuilder, "Publish exact same-repository PR managed image by digest");
    const logout = step(prBuilder, "Remove PR publication credentials");
    const exportContract = step(prBuilder, "Export exact published PR managed-image contract");
    const uploadContract = step(prBuilder, "Upload exact published PR managed-image contract");
    const sameRepository = "github.event.pull_request.head.repo.full_name == github.repository";
    expect(login.if).toBe(sameRepository);
    expect(publish.if).toBe(sameRepository);
    expect(publish.with).toMatchObject({
      platforms: "linux/amd64",
      outputs:
        "type=image,name=${{ matrix.repository }},push-by-digest=true,name-canonical=true,push=true",
      provenance: false,
      sbom: false,
    });
    expect(publish.with?.tags).toBeUndefined();
    expect(logout.if).toContain(sameRepository);
    expect(exportContract.if).toBe(sameRepository);
    expect(uploadContract.if).toBe(sameRepository);
    expect(steps.indexOf(logout)).toBeLessThan(steps.indexOf(exportContract));
    expect(exportContract.run).toContain('DOCKER_CONFIG="$anonymous_config" docker pull');
    expect(exportContract.run).toContain("revision: $revision");
    expect(JSON.stringify(prBuilder).match(/secrets\.GITHUB_TOKEN/gu)).toHaveLength(1);
    expect(JSON.stringify(prBuilder)).not.toContain("github.token");
  });

  it("runs the exact candidate CLI through real all-agent Docker and OpenShell activation (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const activation = managedPrActivation(workflow);
    const steps = activation.steps ?? [];

    expect(workflow.on?.pull_request?.paths).toEqual(
      expect.arrayContaining([
        "src/lib/onboard/**",
        "test/e2e/live/managed-image-activation-e2e*.ts",
      ]),
    );
    expect(activation.needs).toBe("pr-build-and-entrypoint");
    expect(activation.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(activation.permissions).toEqual({ contents: "read" });
    expect(activation.env?.CANDIDATE_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    expect(activation.env?.NEMOCLAW_MANAGED_ACTIVATION_CATALOG).toBe(
      "${{ github.workspace }}/managed-pr-catalog.json",
    );
    expect(JSON.stringify(activation)).not.toContain("secrets.");
    expect(JSON.stringify(activation)).not.toContain("github.token");
    expect(step(activation, "Checkout exact PR head").with?.ref).toBe(
      "${{ github.event.pull_request.head.sha }}",
    );
    expect(step(activation, "Build exact candidate CLI").run).toContain("npm run build:cli");
    expect(step(activation, "Install OpenShell CLI").run).toContain("scripts/install-openshell.sh");
    const run = step(activation, "Run real all-agent managed runtime activation").run ?? "";
    expect(run).toContain('[[ "$(git rev-parse --verify HEAD)" == "$CANDIDATE_SHA" ]]');
    expect(run).toContain("test/e2e/live/managed-image-activation-e2e.test.ts");
    expect(steps.map(({ name }) => name)).toContain("Upload managed runtime activation evidence");
  });

  it("keeps the activation proof outside mocked runtime boundaries (#7744)", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "test/e2e/live/managed-image-activation-e2e-helpers.ts"),
      "utf8",
    );

    expect(source).toContain('"--temp-managed-runtime-catalog"');
    expect(source).toContain("await host.nemoclaw(");
    expect(source).toContain("await lifecycle.restartGatewayRuntime(");
    expect(source).toContain("await runAgentTurn(");
    expect(source).toContain("await host.destroySandbox(");
    expect(source).toContain("managed activation attempted a forbidden Dockerfile build");
    expect(source).toContain("startFakeOpenAiCompatibleServer");
    expect(source).not.toContain("runSandboxGpuCreateFlow");
    expect(source).not.toContain("createDockerManagedBootstrapAdapter");
    expect(source).not.toMatch(/\bvi\.(?:fn|mock|spyOn)\b/u);
  });

  it("pins a single linux/amd64 PR base descriptor and fails closed on torn index evidence", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const resolver = required(
      step(managedPrBuilder(workflow), "Resolve exact linux/amd64 PR base").run,
      "PR base resolver script is missing",
    );
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-base-"));
    const fakeBin = path.join(temporaryRoot, "bin");
    const aliasRaw = path.join(temporaryRoot, "alias.raw");
    const exactRaw = path.join(temporaryRoot, "exact.raw");
    const output = path.join(temporaryRoot, "output");
    const summary = path.join(temporaryRoot, "summary");
    fs.mkdirSync(fakeBin);
    const exactBody = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: `sha256:${"a".repeat(64)}`, size: 1 },
      layers: [],
    });
    const digest = `sha256:${createHash("sha256").update(exactBody).digest("hex")}`;
    const descriptor = {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest,
      size: exactBody.length,
      platform: { os: "linux", architecture: "amd64" },
    };
    const writeAlias = (manifests: unknown[]) => {
      fs.writeFileSync(
        aliasRaw,
        JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests,
        }),
      );
    };
    writeAlias([descriptor]);
    fs.writeFileSync(exactRaw, exactBody);
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      `#!/bin/bash
set -euo pipefail
if [ "\${1:-} \${2:-} \${3:-}" != "buildx imagetools inspect" ]; then
  exit 90
fi
if [[ "\${4:-}" == *":latest" ]]; then
  cat "$ALIAS_RAW"
else
  cat "$EXACT_RAW"
fi
`,
      { mode: 0o755 },
    );
    const runResolver = () =>
      spawnSync("bash", ["-c", resolver], {
        encoding: "utf8",
        env: {
          ...process.env,
          ALIAS_RAW: aliasRaw,
          BASE_ALIAS: "ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
          BASE_REPOSITORY: "ghcr.io/nvidia/nemoclaw/sandbox-base",
          DISPLAY_NAME: "OpenClaw",
          EXACT_RAW: exactRaw,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: temporaryRoot,
        },
      });

    try {
      const accepted = runResolver();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(fs.readFileSync(output, "utf8")).toContain(
        `ref=ghcr.io/nvidia/nemoclaw/sandbox-base@${digest}`,
      );

      writeAlias([descriptor, descriptor]);
      const duplicate = runResolver();
      expect(duplicate.status).not.toBe(0);
      expect(duplicate.stderr).toContain("does not contain exactly one linux/amd64 image");

      writeAlias([descriptor]);
      fs.appendFileSync(exactRaw, " ");
      const wrongBody = runResolver();
      expect(wrongBody.status).not.toBe(0);
      expect(wrongBody.stderr).toContain(
        "exact PR base bytes do not match the selected descriptor digest",
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("publishes an exact native amd64 and arm64 lane for every shipped agent (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const builder = managedBuilder(workflow);

    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(["pull_request", "workflow_call"]);
    expect(workflow.permissions).toEqual({
      contents: "read",
      packages: "write",
    });
    expect(builder.if).toBe("github.event_name != 'pull_request'");
    expect(builder["runs-on"]).toBe("${{ matrix.runner }}");
    expect(builder["timeout-minutes"]).toBe(120);
    expect(builder.strategy?.["fail-fast"]).toBe(false);
    expect(builder.strategy?.matrix?.include).toEqual([
      {
        agent: "openclaw",
        arch: "amd64",
        display_name: "OpenClaw",
        dockerfile: "Dockerfile",
        base_image: "nvidia/nemoclaw/sandbox-base",
        image: "nvidia/nemoclaw/openclaw-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
        required_binary: "/usr/local/bin/openclaw",
        runner: "ubuntu-24.04",
      },
      {
        agent: "openclaw",
        arch: "arm64",
        display_name: "OpenClaw",
        dockerfile: "Dockerfile",
        base_image: "nvidia/nemoclaw/sandbox-base",
        image: "nvidia/nemoclaw/openclaw-sandbox",
        platform: "linux/arm64",
        artifact_platform: "linux-arm64",
        required_binary: "/usr/local/bin/openclaw",
        runner: "ubuntu-24.04-arm",
      },
      {
        agent: "hermes",
        arch: "amd64",
        display_name: "Hermes",
        dockerfile: "agents/hermes/Dockerfile",
        base_image: "nvidia/nemoclaw/hermes-sandbox-base",
        image: "nvidia/nemoclaw/hermes-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
        required_binary: "/usr/local/bin/hermes",
        runner: "ubuntu-24.04",
      },
      {
        agent: "hermes",
        arch: "arm64",
        display_name: "Hermes",
        dockerfile: "agents/hermes/Dockerfile",
        base_image: "nvidia/nemoclaw/hermes-sandbox-base",
        image: "nvidia/nemoclaw/hermes-sandbox",
        platform: "linux/arm64",
        artifact_platform: "linux-arm64",
        required_binary: "/usr/local/bin/hermes",
        runner: "ubuntu-24.04-arm",
      },
      {
        agent: "langchain-deepagents-code",
        arch: "amd64",
        display_name: "Deep Agents Code",
        dockerfile: "agents/langchain-deepagents-code/Dockerfile",
        base_image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
        image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
        required_binary: "/usr/local/bin/dcode",
        runner: "ubuntu-24.04",
      },
      {
        agent: "langchain-deepagents-code",
        arch: "arm64",
        display_name: "Deep Agents Code",
        dockerfile: "agents/langchain-deepagents-code/Dockerfile",
        base_image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
        image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox",
        platform: "linux/arm64",
        artifact_platform: "linux-arm64",
        required_binary: "/usr/local/bin/dcode",
        runner: "ubuntu-24.04-arm",
      },
    ]);
    expect(
      builder.strategy?.matrix?.include?.map(({ agent, platform }) => `${agent}|${platform}`),
    ).toEqual(
      publicationAgents.flatMap((agent) =>
        publicationPlatforms.map((platform) => `${agent}|${platform}`),
      ),
    );
  });

  it("pins actions, validates exact digests, and records the immutable image contract (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const publisher = managedPublisher(workflow);
    const promoter = managedPromoter(workflow);
    const steps = publisher.steps ?? [];

    for (const action of [...steps, ...(promoter.steps ?? [])].filter(
      (candidate) => candidate.uses,
    )) {
      expect(action.uses, action.name).toMatch(fullShaAction);
    }
    expect(step(publisher, "Checkout").with?.["persist-credentials"]).toBe(false);
    expect(step(publisher, "Download exact base image contract").with).toMatchObject({
      name: "managed-base-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.agent }}",
      path: "${{ runner.temp }}/managed-base-contract",
    });

    const guard = step(publisher, "Validate production build args");
    const build = step(publisher, "Build and push managed image by digest");
    const validate = step(publisher, "Validate exact managed image before promotion");
    const evidence = step(publisher, "Capture exact managed image publication evidence");
    const dependencies = step(publisher, "Install managed-image publication harness dependencies");
    expect(steps.indexOf(guard)).toBeLessThan(steps.indexOf(build));
    expect(guard.run).toContain('scripts/check-production-build-args.sh "${build_args[@]}"');
    expect(build.uses).toBe("docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a");
    expect(build.with).toMatchObject({
      context: ".",
      file: "${{ matrix.dockerfile }}",
      platforms: "${{ matrix.platform }}",
      "build-args":
        "BASE_IMAGE=${{ steps.base.outputs.ref }}\nNEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1\nNEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root\n",
      provenance: "mode=max",
      sbom: true,
    });
    expect(build.with?.push).toBeUndefined();
    expect(build.with?.tags).toBeUndefined();
    expect(build.with?.labels).toContain("org.opencontainers.image.revision=${{ github.sha }}");
    expect(build.with?.labels).toContain("io.nvidia.nemoclaw.managed-image.contract=1");
    expect(build.with?.labels).toContain(
      "io.nvidia.nemoclaw.managed-image.cohort=ghrun-${{ github.run_id }}-${{ github.run_attempt }}",
    );

    const base = step(publisher, "Validate exact base image contract");
    expect(base.run).toContain(".platformReferences[$platform]");
    expect(base.run).toContain('imagetools inspect "$platform_reference"');

    const contract = step(publisher, "Export validated managed image candidate");
    for (const marker of [
      "--arg baseReference",
      "--arg digest",
      "--arg platform",
      "--arg cohort",
      "--arg revision",
      "--arg cohort",
      "--argjson runAttempt",
      "--argjson runId",
      "contractVersion: 2",
      'phase: "candidate"',
      "--slurpfile publicationEvidence",
      "publicationEvidence: $publicationEvidence[0]",
      "https://slsa.dev/provenance/v1",
      "https://spdx.dev/Document",
    ]) {
      expect(contract.run).toContain(marker);
    }
    expect(step(publisher, "Upload validated managed image candidate").with).toMatchObject({
      name: "managed-image-candidate-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.agent }}-${{ matrix.artifact_platform }}",
      path: "${{ runner.temp }}/managed-image-candidate/contract.json",
      "if-no-files-found": "error",
      "retention-days": 1,
    });
    const validation = required(validate.run, "managed image validation script is missing");
    expect(validation.match(/docker run/g)).toHaveLength(2);
    expect(validation).toContain("run-managed-image-direct-e2e.ts");
    expect(validation).toContain("npx --no-install tsx");
    expect(validation).toContain('--image "$reference"');
    expect(validation).toContain("printf 'local_id=%s\\n' \"$image_id\"");
    expect(validation).not.toContain("NEMOCLAW_STARTUP_PROFILE_B64");
    expect(validation).not.toContain("NEMOCLAW_CORPORATE_CA_B64");
    expect(validation).not.toContain(".Config.Entrypoint");
    expect(validation).not.toContain(".Config.Cmd");
    expect(evidence.run).toContain("verify-managed-image-publication-evidence.sh");
    expect(evidence.run).toContain('--reference "$REFERENCE"');
    expect(evidence.run).toContain('--digest "$DIGEST"');
    expect(evidence.run).toContain('--platform "$PLATFORM"');
    expect(evidence.run).toContain('--agent "$AGENT"');
    expect(evidence.run).toContain('--base-reference "$BASE_REFERENCE"');
    expect(evidence.run).toContain('--repository "$GITHUB_REPOSITORY"');
    expect(evidence.run).toContain('--revision "$GITHUB_SHA"');
    expect(evidence.run).toContain('--cohort "$COHORT"');
    expect(evidence.run).toContain('--run-id "$GITHUB_RUN_ID"');
    expect(evidence.run).toContain('--run-attempt "$GITHUB_RUN_ATTEMPT"');
    expect(steps.indexOf(dependencies)).toBeLessThan(steps.indexOf(validate));
    expect(steps.indexOf(validate)).toBeLessThan(steps.indexOf(evidence));
    expect(steps.indexOf(evidence)).toBeLessThan(steps.indexOf(contract));
  });

  it("cannot publish a public mutable alias from an individual agent lane (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const publisher = managedPublisher(workflow);
    const steps = publisher.steps ?? [];
    const source = steps.map((candidate) => candidate.run ?? "").join("\n");
    const contract = step(publisher, "Export validated managed image candidate");

    expect(publisher.strategy?.matrix?.include).toHaveLength(6);
    expect(steps.map((candidate) => candidate.name)).not.toContain(
      "Promote validated managed image aliases",
    );
    expect(source).not.toContain('aliases=("${IMAGE}:${GITHUB_SHA}")');
    expect(source).not.toContain("docker buildx imagetools create");
    expect(source).not.toMatch(/(?:^|\s)docker\s+(?:tag|push)\s/u);
    expect(contract.run).toContain('(has("aliases") | not)');
    expect(contract.run).not.toContain("aliases:");
  });

  it("holds every alias behind the exact six-candidate aggregate barrier (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const promoter = managedPromoter(workflow);
    const steps = promoter.steps ?? [];
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const revalidate = step(promoter, "Revalidate exact managed image publication evidence");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const pointer = step(promoter, "Promote durable managed image cohort pointers");
    const durableUploads = steps.filter(
      (candidate) =>
        candidate.uses?.startsWith("actions/upload-artifact@") &&
        String(candidate.with?.name ?? "").startsWith("managed-image-"),
    );

    expect(promoter.needs).toBe("build-and-validate");
    expect(step(promoter, "Download all validated managed image candidates").with).toEqual({
      pattern: "managed-image-candidate-${{ github.run_id }}-${{ github.run_attempt }}-*",
      path: "${{ runner.temp }}/managed-image-candidates",
      "merge-multiple": false,
    });
    expect(barrier.run).toContain("expected exactly six managed image candidate artifacts");
    expect(barrier.run).toContain("length == 6");
    expect(barrier.run).toContain('([.[].platform] | sort) == ["linux/amd64", "linux/arm64"]');
    expect(barrier.run).toContain("([.[].reference] | unique | length) == 6");
    expect(barrier.run).toContain("([.[].baseReference] | unique | length) == 6");
    expect(barrier.run).toContain("publicationEvidence.workloadDescriptor.digest");
    expect(barrier.run).toContain("publicationEvidence.attestations.manifestDescriptor.digest");
    expect(barrier.run).toContain("https://slsa.dev/provenance/v1");
    expect(barrier.run).toContain("https://in-toto.io/Statement/v1");
    expect(barrier.run).toContain("publicationEvidence.attestations.slsa.statement");
    expect(barrier.run).toContain("publicationEvidence.attestations.spdx.statement");
    expect(barrier.run).toContain("https://spdx.dev/Document");
    expect(barrier.run).not.toContain("docker buildx imagetools create");
    expect(revalidate.run).toContain("verify-managed-image-publication-evidence.sh");
    expect(revalidate.run).toContain('--base-reference "$base_reference"');
    expect(revalidate.run).toContain('--run-attempt "$run_attempt"');
    expect(revalidate.run).toContain("registry publication evidence changed");
    expect(steps.indexOf(barrier)).toBeLessThan(steps.indexOf(promotion));
    expect(steps.indexOf(revalidate)).toBeLessThan(steps.indexOf(promotion));
    expect(durableUploads).toHaveLength(7);
    for (const upload of durableUploads) {
      expect(steps.indexOf(promotion)).toBeLessThan(steps.indexOf(upload));
      expect(steps.indexOf(upload)).toBeLessThan(steps.indexOf(pointer));
    }

    expect(promotion.run).toContain("for agent in openclaw hermes langchain-deepagents-code");
    expect(promotion.run).toContain('--metadata-file "$cohort_metadata"');
    expect(promotion.run).toContain('"${descriptor_args[@]}"');
    expect(promotion.run).toContain('cmp -s "$expected_descriptors" "$actual_descriptors"');
    expect(promotion.run).toContain(') == ["linux/amd64", "linux/arm64"]');
    expect(promotion.run).toContain(
      'consumer_aliases=("$(jq -r \'.image\' <<<"$openclaw_manifest"):${GITHUB_SHA}")',
    );
    expect(promotion.run).not.toContain('imagetools create "${consumer_tag_args[@]}"');
    expect(pointer.run).toContain("exact_reference=\"$(jq -er '.agents.openclaw.reference'");
    expect(pointer.run).toContain('imagetools create "${consumer_tag_args[@]}" "$exact_reference"');
    expect(pointer.run).toContain('cmp -s "$exact_raw" "$alias_raw"');
    expect(pointer.run).not.toContain("$openclaw_alias");
    expect(promotion.run).not.toContain(":latest");
  });

  it("fails the barrier before alias code when either architecture is absent (#7744)", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) => candidates.slice(0, -1),
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected exactly six managed image candidate artifacts");
    expect(result.dockerCalls).toEqual([]);
    expect(barrier.run).not.toContain("imagetools create");
  });

  it("fails the barrier before alias code on a duplicated architecture (#7744)", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) =>
        candidates.map((candidate) =>
          candidate.artifact === "managed-image-candidate-7744-2-openclaw-linux-arm64"
            ? {
                ...candidate,
                contract: { ...candidate.contract, platform: "linux/amd64" },
              }
            : candidate,
        ),
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate artifact identity is invalid");
    expect(result.dockerCalls).toEqual([]);
    expect(barrier.run).not.toContain("imagetools create");
  });

  it("fails the barrier before alias code on a mixed-run cohort (#7744)", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) =>
        candidates.map((candidate, index) =>
          index === 0
            ? {
                ...candidate,
                contract: {
                  ...candidate.contract,
                  source: {
                    ...(candidate.contract.source as Record<string, unknown>),
                    revision: "b".repeat(40),
                  },
                },
              }
            : candidate,
        ),
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "complete managed image candidate set failed closed validation",
    );
    expect(result.dockerCalls).toEqual([]);
    expect(barrier.run).not.toContain("imagetools create");
  });

  it("fails closed before alias code when a candidate omits real SPDX evidence", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) => {
        const candidate = candidates[0]!;
        const contract = structuredClone(candidate.contract);
        const evidence = contract.publicationEvidence as Record<string, unknown>;
        const attestations = evidence.attestations as Record<string, unknown>;
        delete attestations.spdx;
        return [{ ...candidate, contract }, ...candidates.slice(1)];
      },
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "complete managed image candidate set failed closed validation",
    );
    expect(result.dockerCalls).toEqual([]);
  });

  it("fails closed before alias code on mixed workload and attestation descriptors", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) => {
        const candidate = candidates[0]!;
        const contract = structuredClone(candidate.contract);
        const evidence = contract.publicationEvidence as Record<string, unknown>;
        const attestations = evidence.attestations as Record<string, unknown>;
        const manifest = attestations.manifestDescriptor as Record<string, unknown>;
        const annotations = manifest.annotations as Record<string, unknown>;
        annotations["vnd.docker.reference.digest"] = `sha256:${"f".repeat(64)}`;
        return [{ ...candidate, contract }, ...candidates.slice(1)];
      },
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "complete managed image candidate set failed closed validation",
    );
    expect(result.dockerCalls).toEqual([]);
  });

  it("accepts one exact candidate for every agent and architecture (#7744)", () => {
    const barrier = step(
      managedPromoter(readWorkflow("managed-images.yaml")),
      "Validate complete managed image candidate set",
    );

    expect(runPublicationBarrier(barrier.run ?? "").status).toBe(0);
  });

  it("stages all multi-platform cohort aliases before moving the sole root pointer (#7744)", () => {
    const promotion = required(
      step(
        managedPromoter(readWorkflow("managed-images.yaml")),
        "Stage validated multi-platform managed image cohort and contracts",
      ).run,
      "managed image promotion script is missing",
    );
    const pointer = required(
      step(
        managedPromoter(readWorkflow("managed-images.yaml")),
        "Promote durable managed image cohort pointers",
      ).run,
      "managed image pointer script is missing",
    );
    const cohort = "ghrun-7744-2";
    const revision = "a".repeat(40);

    const failed = runManagedImagePromotion(promotion, "langchain-deepagents-code");
    const failedCalls = failed.calls.join("\n");
    expect(failed.status, failed.stderr).toBe(91);
    expect(failedCalls).toContain(`hermes-sandbox:cohort-${cohort}`);
    expect(failedCalls).toContain(`langchain-deepagents-code-sandbox:cohort-${cohort}`);
    expect(failedCalls).toContain(`openclaw-sandbox:cohort-${cohort}`);
    expect(failedCalls).not.toContain(`openclaw-sandbox:${revision}`);

    const accepted = runManagedImagePromotion(promotion, "", pointer);
    const acceptedCalls = accepted.calls.join("\n");
    expect(accepted.status, accepted.stderr).toBe(0);
    const cohortAgents = (accepted.cohortContract?.agents ?? {}) as Record<
      string,
      { reference?: string }
    >;
    const expectedPullCalls = publicationAgents.flatMap((agent) => {
      const reference = cohortAgents[agent]?.reference;
      expect(reference).toMatch(/^ghcr\.io\/nvidia\/nemoclaw\/.+@sha256:[0-9a-f]{64}$/u);
      return publicationPlatforms.map((platform) => `pull --platform ${platform} ${reference}`);
    });
    const lastCohortStage = Math.max(
      acceptedCalls.indexOf(`hermes-sandbox:cohort-${cohort}`),
      acceptedCalls.indexOf(`langchain-deepagents-code-sandbox:cohort-${cohort}`),
      acceptedCalls.indexOf(`openclaw-sandbox:cohort-${cohort}`),
    );
    const rootPointer = acceptedCalls.indexOf(`openclaw-sandbox:${revision}`);

    expect(accepted.calls.filter((call) => call.startsWith("pull ")).sort()).toEqual(
      expectedPullCalls.sort(),
    );
    for (const pull of expectedPullCalls) {
      const index = accepted.calls.indexOf(pull);
      const reference = pull.match(/^pull --platform linux\/(?:amd64|arm64) (.+)$/u)?.[1];
      expect(reference).toBeDefined();
      expect(index).toBeGreaterThanOrEqual(0);
      expect(accepted.calls[index + 1]).toBe(`image rm ${reference}`);
    }
    expect(lastCohortStage).toBeGreaterThanOrEqual(0);
    expect(rootPointer).toBeGreaterThan(lastCohortStage);
    expect(acceptedCalls).not.toContain(`hermes-sandbox:${revision}`);
    expect(acceptedCalls).not.toContain(`langchain-deepagents-code-sandbox:${revision}`);
    expect(Object.keys(accepted.platformContracts).sort()).toEqual(
      publicationAgents
        .flatMap((agent) => publicationPlatforms.map((platform) => `${agent}|${platform}`))
        .sort(),
    );
    expect(accepted.cohortContract).toMatchObject({
      contractVersion: 2,
      cohort,
      platforms: ["linux/amd64", "linux/arm64"],
      agents: {
        openclaw: expect.objectContaining({
          descriptor: expect.objectContaining({
            mediaType: "application/vnd.oci.image.index.v1+json",
            digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          }),
          platforms: expect.objectContaining({
            "linux/amd64": expect.objectContaining({
              publicationEvidence: expect.objectContaining({
                workloadDescriptor: expect.any(Object),
                attestations: expect.any(Object),
              }),
            }),
            "linux/arm64": expect.any(Object),
          }),
        }),
        hermes: expect.any(Object),
        "langchain-deepagents-code": expect.any(Object),
      },
    });
  });

  it("retains exact platform and aggregate cohort contracts for ninety days (#7744)", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const uploads = (promoter.steps ?? [])
      .filter((candidate) => candidate.uses?.startsWith("actions/upload-artifact@"))
      .map((candidate) => candidate.with);

    expect(uploads).toEqual([
      {
        name: "managed-image-cohort-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "${{ runner.temp }}/managed-image-contracts/cohort.json",
        "if-no-files-found": "error",
        "retention-days": 90,
      },
      ...publicationAgents.flatMap((agent) =>
        publicationPlatforms.map((platform) => {
          const artifactPlatform = platform.replaceAll("/", "-");
          return {
            name:
              "managed-image-${{ github.run_id }}-${{ github.run_attempt }}-" +
              `${agent}-${artifactPlatform}`,
            path: `\${{ runner.temp }}/managed-image-contracts/${agent}/${artifactPlatform}/contract.json`,
            "if-no-files-found": "error",
            "retention-days": 90,
          };
        }),
      ),
    ]);
  });
});
