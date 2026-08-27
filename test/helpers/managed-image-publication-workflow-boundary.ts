// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  managedPromoter,
  managedPublisher,
  required,
  step,
} from "./managed-image-publication-workflow";
import type { Workflow } from "./managed-image-publication-workflow-types";

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
  "src/lib/actions/sandbox/mcp-bridge-*.ts",
  "src/lib/actions/sandbox/openshell-child-visible-credentials.v*.json",
  "src/lib/core/json-types.ts",
  "src/lib/core/ports.ts",
  "src/lib/messaging/**",
  "src/lib/onboard/managed-bootstrap/envelope.ts",
  "src/lib/onboard/managed-startup/**",
  "src/lib/onboard/managed-workload/onboard-orchestration.ts",
  "src/lib/security/credential-hash.ts",
  "src/lib/state/paths.ts",
  "src/lib/state/state-root.ts",
  "src/lib/tool-disclosure.ts",
  "tools/mcp-tool-discovery-runtime/**",
  "tsconfig.runtime-preloads.json",
] as const;

export function publicationBoundaryErrors(
  baseWorkflow: Workflow,
  managedWorkflow: Workflow,
): string[] {
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
    "/usr/local/share/nemoclaw/corporate-ca.pem",
    '--entrypoint "$REQUIRED_BINARY"',
    "io.nvidia.nemoclaw.managed-image.contract",
    "io.nvidia.nemoclaw.managed-image.startup-profile",
    "io.nvidia.nemoclaw.managed-image.capabilities",
    "io.nvidia.nemoclaw.managed-image.cohort",
    'cohort_prefix="ghrun-${GITHUB_RUN_ID}-"',
    '[ "$cohort_attempt" -gt "$GITHUB_RUN_ATTEMPT" ]',
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
    base.run.includes(".run.id == $runId") &&
    base.run.includes(".run.attempt <= $runAttempt")
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
    ...(JSON.stringify(promoter.needs) ===
    JSON.stringify(["publication-identity", "build-and-validate"])
      ? []
      : ["aggregate promotion must require every matrix lane"]),
  ];
}
