// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
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

type MatrixEntry = {
  agent?: string;
  artifact_platform?: string;
  base_alias?: string;
  base_image?: string;
  base_repository?: string;
  display_name?: string;
  dockerfile?: string;
  image?: string;
  platform?: string;
  required_binary?: string;
};

type Job = {
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
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...parameters: string[]
) => (...args: unknown[]) => Promise<unknown>;
const managedInputPaths = [
  ".dockerignore",
  ".github/workflows/managed-images.yaml",
  "Dockerfile",
  "agents/**",
  "ci/npm-audit-exceptions.json",
  "nemoclaw/**",
  "nemoclaw-blueprint/**",
  "scripts/**",
  "src/lib/actions/sandbox/openshell-child-visible-credentials.v*.json",
  "src/lib/core/json-types.ts",
  "src/lib/core/ports.ts",
  "src/lib/messaging/**",
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

function managedBuilder(workflow: Workflow): Job {
  return required(
    workflow.jobs?.["build-and-validate"],
    "managed-image workflow is missing its build-and-validate matrix",
  );
}

function managedPromoter(workflow: Workflow): Job {
  return required(
    workflow.jobs?.promote,
    "managed-image workflow is missing its aggregate promoter",
  );
}

function managedPrBuilder(workflow: Workflow): Job {
  return required(
    workflow.jobs?.["pr-build-and-entrypoint"],
    "managed-image workflow is missing its pull-request build and entrypoint matrix",
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function publicationBoundaryErrors(baseWorkflow: Workflow, managedWorkflow: Workflow): string[] {
  const triggerPaths = baseWorkflow.on?.push?.paths ?? [];
  const caller = required(
    baseWorkflow.jobs?.["publish-managed-images"],
    "base-image workflow is missing the managed-image publisher",
  );
  const builder = managedBuilder(managedWorkflow);
  const promoter = managedPromoter(managedWorkflow);
  const buildSteps = builder.steps ?? [];
  const promoteSteps = promoter.steps ?? [];
  const build = step(builder, "Build and push managed image by digest");
  const base = step(builder, "Validate exact base image contract");
  const validate = step(builder, "Validate exact managed image before promotion");
  const candidate = step(builder, "Export validated managed image candidate");
  const barrier = step(promoter, "Validate complete managed image candidate set");
  const promote = step(promoter, "Promote validated managed image aliases");
  const workflowSource = JSON.stringify(managedWorkflow);
  const validationMarkers = [
    'mktemp -d "$RUNNER_TEMP/anonymous-docker-XXXXXX"',
    'DOCKER_CONFIG="$anonymous_config" docker pull --platform "$PLATFORM" "$reference"',
    "bootstrap the GHCR package",
    ".Config.Entrypoint",
    ".Config.Cmd",
    "/usr/local/bin/nemoclaw-start",
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
    "microsoft-teams-apps",
    "config.plugins?.entries?.[id]?.enabled !== false",
    'config["platforms"].get(name) != {"enabled": False}',
    "generate-managed-startup-profile-fixture.mts",
    "--corporate-ca",
    "--corporate-ca-b64",
    "/run/nemoclaw/managed-startup-ca-bundle.pem",
    "/opt/venv/bin/python3 -I",
    "_managed_fetch_ca_bundle",
    "--network none",
    "/tmp/nemoclaw-managed-command-uid",
    "/tmp/nemoclaw-managed-command-proxy-env",
    '/usr/local/bin/dcode -n ""',
    "/tmp/nemoclaw-managed-dcode-empty-prompt-status",
    "/tmp/nemoclaw-managed-dcode-empty-prompt-output",
    "NemoClaw: empty non-interactive prompt for -n; provide prompt text.",
    "managed DCode launcher/supervisor empty-prompt contract failed",
    "HTTP_PROXY=%s",
    "HTTPS_PROXY=%s",
    "NO_PROXY=%s",
    "http_proxy=%s",
    "https_proxy=%s",
    "no_proxy=%s",
    "http://10.200.0.1:3128",
    "localhost,127.0.0.1,::1,10.200.0.1",
    "is already committed",
    "recreate the sandbox",
    "--user sandbox",
  ];
  const candidateMarkers = [
    'phase: "candidate"',
    '--arg ref "$GITHUB_REF"',
    '--arg release "$release_tag"',
    '--arg cohort "$PUBLICATION_COHORT"',
    "cohort: $cohort",
    "^ghrun-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$",
    'and (has("aliases") | not)',
  ];
  const barrierMarkers = [
    "expected exactly three managed image candidate artifacts",
    "managed-image-candidate-openclaw-linux-amd64",
    "managed-image-candidate-hermes-linux-amd64",
    "managed-image-candidate-langchain-deepagents-code-linux-amd64",
    "length == 3",
    "([.[].source.repository] | unique) == [$repository]",
    "([.[].source.revision] | unique) == [$revision]",
    "([.[].source.ref] | unique) == [$ref]",
    "([.[].source.cohort] | unique) == [$cohort]",
    "^ghrun-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$",
    "([.[].run] | unique) == [{id: $runId, attempt: $runAttempt}]",
    'and .release == (if $release == "" then null else $release end)',
  ];
  const promotionMarkers = [
    'cohort="ghrun-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    "^ghrun-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$",
    'cohort_alias="${image}:cohort-${cohort}"',
    'docker buildx imagetools create --tag "$cohort_alias" "$reference"',
    'docker buildx imagetools inspect "$cohort_alias" --raw',
    'openclaw_candidate="$(jq -ce \'.[] | select(.agent == "openclaw")\' "$CANDIDATE_SET")"',
    'consumer_aliases=("${openclaw_image}:${GITHUB_SHA}")',
    'consumer_aliases+=("${openclaw_image}:${release_tag}")',
    'docker buildx imagetools create "${consumer_tag_args[@]}" "$openclaw_reference"',
    'docker buildx imagetools inspect "$reference" --raw',
    'docker buildx imagetools inspect "$alias" --raw',
    'cmp -s "$exact_raw" "$cohort_raw"',
    'cmp -s "$openclaw_exact_raw" "$alias_raw"',
  ];
  const buildIndex = buildSteps.indexOf(build);
  const validateIndex = buildSteps.indexOf(validate);
  const candidateIndex = buildSteps.indexOf(candidate);
  const barrierIndex = promoteSteps.indexOf(barrier);
  const promoteIndex = promoteSteps.indexOf(promote);
  const promotionSource = promote.run ?? "";
  const stageIndex = promotionSource.indexOf(
    "# Stage all three unique cohort aliases before any consumer pointer",
  );
  const verifyIndex = promotionSource.indexOf(
    "# Verify every staged cohort alias against its exact validated",
  );
  const pointerIndex = promotionSource.indexOf(
    'consumer_aliases=("${openclaw_image}:${GITHUB_SHA}")',
  );

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
    ...candidateMarkers
      .filter((marker) => !candidate.run?.includes(marker))
      .map((marker) => `managed image candidate contract is missing ${marker}`),
    ...barrierMarkers
      .filter((marker) => !barrier.run?.includes(marker))
      .map((marker) => `managed image all-three barrier is missing ${marker}`),
    ...promotionMarkers
      .filter((marker) => !promote.run?.includes(marker))
      .map((marker) => `managed image promotion is missing ${marker}`),
    ...(buildIndex >= 0 && buildIndex < validateIndex && validateIndex < candidateIndex
      ? []
      : ["managed image validation must finish before candidate publication"]),
    ...(promoter.needs === "build-and-validate" &&
    barrierIndex >= 0 &&
    barrierIndex < promoteIndex &&
    promoter.strategy === undefined
      ? []
      : ["all matrix validations must finish before aggregate alias promotion"]),
    ...(stageIndex >= 0 && stageIndex < verifyIndex && verifyIndex < pointerIndex
      ? []
      : ["all cohort aliases must be staged and verified before the OpenClaw pointer moves"]),
    ...(promotionSource.includes('consumer_aliases=("${image}:${GITHUB_SHA}")') ||
    promotionSource.includes('aliases=("${image}:${GITHUB_SHA}")')
      ? ["each agent must not receive an independent source-revision pointer"]
      : []),
  ];
}

describe("complete managed-image publication workflow", () => {
  it("starts after exact base contracts with complete main triggers and release-safe concurrency (#7744)", () => {
    const baseWorkflow = readWorkflow("base-image.yaml");
    const managedWorkflow = readWorkflow("managed-images.yaml");
    const publisher = required(
      baseWorkflow.jobs?.["publish-managed-images"],
      "base-image workflow is missing the managed-image publisher",
    );

    expect(publicationBoundaryErrors(baseWorkflow, managedWorkflow)).toEqual([]);
    expect(publisher).toMatchObject({
      needs: ["build-and-push", "build-and-push-openclaw"],
      permissions: {
        contents: "read",
        packages: "write",
      },
      uses: "./.github/workflows/managed-images.yaml",
    });
    expect(publisher.if).toContain("github.repository == 'NVIDIA/NemoClaw'");
    expect(publisher.if).toContain("github.ref == 'refs/heads/main'");
    expect(publisher.if).toContain("startsWith(github.ref, 'refs/tags/v')");

    const qemuPublisher = required(
      baseWorkflow.jobs?.["build-and-push"],
      "base-image workflow is missing Hermes and DCode publishers",
    );
    expect(step(qemuPublisher, "Build and push").id).toBe("build");
    expect(step(qemuPublisher, "Export managed base image contract").run).toContain(
      'reference="${IMAGE}@${DIGEST}"',
    );
    expect(step(qemuPublisher, "Upload managed base image contract").with?.name).toBe(
      "managed-base-${{ matrix.agent }}",
    );

    const openClawPublisher = required(
      baseWorkflow.jobs?.["build-and-push-openclaw"],
      "base-image workflow is missing the OpenClaw manifest publisher",
    );
    expect(step(openClawPublisher, "Create and verify multi-platform manifest").id).toBe(
      "manifest",
    );
    expect(step(openClawPublisher, "Export managed base image contract").env?.DIGEST).toBe(
      "${{ steps.manifest.outputs.digest }}",
    );
    expect(step(openClawPublisher, "Upload managed base image contract").with?.name).toBe(
      "managed-base-openclaw",
    );
  });

  it("publishes every complete agent image for the initial Linux x86_64 contract (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const builder = managedBuilder(workflow);
    const promoter = managedPromoter(workflow);

    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(["pull_request", "workflow_call"]);
    expect(workflow.permissions).toEqual({
      contents: "read",
      packages: "read",
    });
    expect(builder.if).toBe("github.event_name != 'pull_request'");
    expect(builder.permissions).toEqual({ contents: "read", packages: "write" });
    expect(promoter.if).toBe("github.event_name != 'pull_request'");
    expect(promoter.permissions).toEqual({ contents: "read", packages: "write" });
    expect(builder["runs-on"]).toBe("ubuntu-24.04");
    expect(builder["timeout-minutes"]).toBe(90);
    expect(builder.strategy?.["fail-fast"]).toBe(false);
    expect(builder.strategy?.matrix?.include).toEqual([
      {
        agent: "openclaw",
        display_name: "OpenClaw",
        dockerfile: "Dockerfile",
        base_image: "nvidia/nemoclaw/sandbox-base",
        image: "nvidia/nemoclaw/openclaw-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
        required_binary: "/usr/local/bin/openclaw",
      },
      {
        agent: "hermes",
        display_name: "Hermes",
        dockerfile: "agents/hermes/Dockerfile",
        base_image: "nvidia/nemoclaw/hermes-sandbox-base",
        image: "nvidia/nemoclaw/hermes-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
        required_binary: "/usr/local/bin/hermes",
      },
      {
        agent: "langchain-deepagents-code",
        display_name: "Deep Agents Code",
        dockerfile: "agents/langchain-deepagents-code/Dockerfile",
        base_image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
        image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
        required_binary: "/usr/local/bin/dcode",
      },
    ]);
    expect(promoter).toMatchObject({
      needs: "build-and-validate",
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 30,
    });
    expect(promoter.strategy).toBeUndefined();
  });

  it("rejects lightweight and unverified release tags before managed alias promotion", async () => {
    const workflow = readWorkflow("managed-images.yaml");
    const promoter = managedPromoter(workflow);
    const promoteSteps = promoter.steps ?? [];
    const verify = step(promoter, "Verify release tag before managed image promotion");
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const login = step(promoter, "Log in to GHCR for promotion");
    const promotion = step(promoter, "Promote validated managed image aliases");
    const script = required(verify.with?.script as string | undefined, "tag verifier is missing");
    const releaseTag = "v0.0.98";
    const releaseRevision = "b".repeat(40);
    const tagObjectSha = "a".repeat(40);
    const runVerify = (getRef: ReturnType<typeof vi.fn>, getTag: ReturnType<typeof vi.fn>) =>
      new AsyncFunction("github", "context", "core", script)(
        { rest: { git: { getRef, getTag } } },
        { repo: { owner: "NVIDIA", repo: "NemoClaw" } },
        { info: vi.fn() },
      );
    vi.stubEnv("RELEASE_TAG", releaseTag);
    vi.stubEnv("RELEASE_REVISION", releaseRevision);

    expect(verify.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(verify.uses).toBe("actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3");
    expect(promoteSteps.indexOf(barrier)).toBeLessThan(promoteSteps.indexOf(verify));
    expect(promoteSteps.indexOf(verify)).toBeLessThan(promoteSteps.indexOf(login));
    expect(promoteSteps.indexOf(verify)).toBeLessThan(promoteSteps.indexOf(promotion));

    const lightweightGetTag = vi.fn();
    await expect(
      runVerify(
        vi.fn().mockResolvedValue({
          data: { object: { sha: releaseRevision, type: "commit" } },
        }),
        lightweightGetTag,
      ),
    ).rejects.toThrow(`Release tag ${releaseTag} must be annotated`);
    expect(lightweightGetTag).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const unverifiedGetTag = vi.fn().mockResolvedValue({
      data: {
        object: { sha: releaseRevision, type: "commit" },
        tag: releaseTag,
        verification: { verified: false, reason: "unsigned" },
      },
    });
    const unverified = expect(
      runVerify(
        vi.fn().mockResolvedValue({
          data: { object: { sha: tagObjectSha, type: "tag" } },
        }),
        unverifiedGetTag,
      ),
    ).rejects.toThrow(`Release tag ${releaseTag} is not GitHub-Verified (unsigned)`);
    await vi.runAllTimersAsync();
    await unverified;
    expect(unverifiedGetTag).toHaveBeenCalledTimes(10);
  });

  it("builds all three images and exercises real entrypoints for stacked and main-target pull requests", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const prBuilder = managedPrBuilder(workflow);
    const steps = prBuilder.steps ?? [];
    const build = step(prBuilder, "Build PR managed image locally");
    const gate = step(prBuilder, "Exercise real managed-image entrypoint");
    const prPaths = workflow.on?.pull_request?.paths ?? [];

    expect(prBuilder).toMatchObject({
      if: "github.event_name == 'pull_request'",
      permissions: { contents: "read", packages: "read" },
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 90,
    });
    expect(prBuilder.strategy?.["fail-fast"]).toBe(false);
    expect(prBuilder.strategy?.matrix?.include).toEqual([
      {
        agent: "openclaw",
        display_name: "OpenClaw",
        dockerfile: "Dockerfile",
        base_alias: "ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
        base_repository: "ghcr.io/nvidia/nemoclaw/sandbox-base",
        image: "nemoclaw-managed-pr/openclaw",
      },
      {
        agent: "hermes",
        display_name: "Hermes",
        dockerfile: "agents/hermes/Dockerfile",
        base_alias: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest",
        base_repository: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
        image: "nemoclaw-managed-pr/hermes",
      },
      {
        agent: "langchain-deepagents-code",
        display_name: "Deep Agents Code",
        dockerfile: "agents/langchain-deepagents-code/Dockerfile",
        base_alias: "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest",
        base_repository: "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
        image: "nemoclaw-managed-pr/langchain-deepagents-code",
      },
    ]);
    expect(workflow.on?.pull_request?.branches).toBeUndefined();
    expect(managedInputPaths.filter((path) => !prPaths.includes(path))).toEqual([]);
    for (const action of steps.filter((candidate) => candidate.uses)) {
      expect(action.uses, action.name).toMatch(fullShaAction);
    }
    expect(steps.some((candidate) => candidate.name?.includes("Log in"))).toBe(false);
    expect(step(prBuilder, "Set up Node.js").with?.["node-version"]).toBe("22.19.0");
    const base = step(prBuilder, "Resolve exact linux/amd64 PR base");
    for (const marker of [
      'docker buildx imagetools inspect "$BASE_ALIAS" --raw',
      '.platform.os == "linux"',
      '.platform.architecture == "amd64"',
      "if length == 1 then .[0].digest",
      'reference="${BASE_REPOSITORY}@${digest}"',
      'docker buildx imagetools inspect "$reference" --raw',
      'actual="sha256:$(sha256sum "$exact_raw"',
      'printf \'ref=%s\\n\' "$reference" >> "$GITHUB_OUTPUT"',
    ]) {
      expect(base.run).toContain(marker);
    }
    expect(build.with).toMatchObject({
      context: ".",
      file: "${{ matrix.dockerfile }}",
      platforms: "linux/amd64",
      load: true,
      push: false,
      tags: "${{ matrix.image }}:${{ github.sha }}",
      provenance: false,
      sbom: false,
      "build-args":
        "BASE_IMAGE=${{ steps.base.outputs.ref }}\nNEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1\nNEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root\n",
    });
    expect(build.with?.outputs).toBeUndefined();
    expect(build.with?.["cache-to"]).toBeUndefined();
    for (const marker of [
      "generate-managed-startup-profile-fixture.mts",
      "--corporate-ca",
      "--corporate-ca-b64",
      "--without-host-proxy",
      "docker run -d",
      "--network none",
      "/tmp/nemoclaw-pr-command-uid",
      "/tmp/nemoclaw-pr-command-proxy-env",
      '/usr/local/bin/dcode -n ""',
      "/tmp/nemoclaw-pr-dcode-empty-prompt-status",
      "/tmp/nemoclaw-pr-dcode-empty-prompt-output",
      "NemoClaw: empty non-interactive prompt for -n; provide prompt text.",
      "managed DCode launcher/supervisor empty-prompt contract failed",
      "upper-http:upper-secret",
      "lower-http:lower-secret",
      "authenticated proxy material entered the startup profile",
      "authenticated proxy material entered the durable runtime file",
      "http://10.200.0.1:3128",
      "NEMOCLAW_MANAGED_STARTUP_APPLIED",
      'command_uid" != "$sandbox_uid',
      "/sandbox/.openclaw/openclaw.json",
      "/sandbox/.hermes/config.yaml",
      "/sandbox/.deepagents/config.toml",
      "/run/nemoclaw/managed-startup-runtime.env",
      "/usr/local/share/nemoclaw/corporate-ca.pem",
      "/run/nemoclaw/managed-startup-ca-bundle.pem",
    ]) {
      expect(gate.run).toContain(marker);
    }
    expect(
      gate.run?.match(
        /"\$IMAGE_REFERENCE" \\\n\s+env \\\n\s+"NEMOCLAW_STARTUP_PROFILE_B64=\$profile" \\\n\s+"NEMOCLAW_CORPORATE_CA_B64=\$corporate_ca_b64" \\\n[\s\S]*?\s+nemoclaw-start \\/gu,
      ),
    ).toHaveLength(1);
    expect(gate.run).not.toContain('--env "NEMOCLAW_STARTUP_PROFILE_B64=');
    expect(gate.run).not.toContain('--env "NEMOCLAW_CORPORATE_CA_B64=');
    expect(gate.run).not.toMatch(
      /if \[ "\$AGENT" = "langchain-deepagents-code" \]; then\s+expected_http_proxy=/u,
    );
    expect(gate.run).not.toContain(
      'expected_http_proxy="http://upper-http:upper-secret@upper-http.example.test:18080"',
    );
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

  it("pins actions, validates exact digests, and records the promoted image contract (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const builder = managedBuilder(workflow);
    const promoter = managedPromoter(workflow);
    const buildSteps = builder.steps ?? [];
    const promoteSteps = promoter.steps ?? [];

    for (const action of [...buildSteps, ...promoteSteps].filter((candidate) => candidate.uses)) {
      expect(action.uses, action.name).toMatch(fullShaAction);
    }
    expect(step(builder, "Checkout").with?.["persist-credentials"]).toBe(false);
    expect(step(builder, "Download exact base image contract").with).toMatchObject({
      name: "managed-base-${{ matrix.agent }}",
      path: "${{ runner.temp }}/managed-base-contract",
    });

    const guard = step(builder, "Validate production build args");
    const build = step(builder, "Build and push managed image by digest");
    const validate = step(builder, "Validate exact managed image before promotion");
    expect(buildSteps.indexOf(guard)).toBeLessThan(buildSteps.indexOf(build));
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
    expect(build.with?.labels).toContain("io.nvidia.nemoclaw.managed-image.startup-profile=1");
    expect(build.with?.labels).toContain("io.nvidia.nemoclaw.managed-image.capabilities=1");
    expect(build.with?.labels).toContain(
      "io.nvidia.nemoclaw.managed-image.cohort=ghrun-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(guard.run).toContain('--build-arg "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1"');
    expect(guard.run).toContain('--build-arg "NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root"');
    expect(validate.run).not.toMatch(
      /if \[ "\$AGENT" = "langchain-deepagents-code" \]; then\s+expected_http_proxy=/u,
    );
    expect(validate.run).not.toContain(
      'expected_http_proxy="http://fixture-http-proxy.example.test:18080"',
    );

    const candidate = step(builder, "Export validated managed image candidate");
    for (const marker of [
      "--arg baseReference",
      "--arg digest",
      "--arg platform",
      "--arg ref",
      "--arg release",
      "--arg revision",
      "--arg cohort",
      "--argjson runAttempt",
      "--argjson runId",
      "contractVersion: 1",
      'phase: "candidate"',
      '(has("aliases") | not)',
    ]) {
      expect(candidate.run).toContain(marker);
    }
    expect(candidate.run).not.toContain("aliases:");
    expect(step(builder, "Upload validated managed image candidate").with).toMatchObject({
      name: "managed-image-candidate-${{ matrix.agent }}-${{ matrix.artifact_platform }}",
      path: "${{ runner.temp }}/managed-image-candidate/contract.json",
      "if-no-files-found": "error",
      "retention-days": 1,
    });

    expect(step(promoter, "Download all validated managed image candidates").with).toEqual({
      pattern: "managed-image-candidate-*",
      path: "${{ runner.temp }}/managed-image-candidates",
      "merge-multiple": false,
    });
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(promoter, "Promote validated managed image aliases");
    expect(promoteSteps.indexOf(barrier)).toBeLessThan(promoteSteps.indexOf(promotion));
    expect(promotion.run).toContain(
      "# Stage all three unique cohort aliases before any consumer pointer",
    );
    expect(promotion.run).toContain(
      "# Verify every staged cohort alias against its exact validated",
    );
    expect(promotion.run).not.toContain('aliases=("${image}:${GITHUB_SHA}")');

    expect(step(promoter, "Upload OpenClaw managed image contract").with).toMatchObject({
      name: "managed-image-openclaw-linux-amd64",
      path: "${{ runner.temp }}/managed-image-contracts/openclaw/contract.json",
      "retention-days": 90,
    });
    expect(step(promoter, "Upload Hermes managed image contract").with).toMatchObject({
      name: "managed-image-hermes-linux-amd64",
      path: "${{ runner.temp }}/managed-image-contracts/hermes/contract.json",
      "retention-days": 90,
    });
    expect(step(promoter, "Upload Deep Agents Code managed image contract").with).toMatchObject({
      name: "managed-image-langchain-deepagents-code-linux-amd64",
      path: "${{ runner.temp }}/managed-image-contracts/langchain-deepagents-code/contract.json",
      "retention-days": 90,
    });

    const validation = required(
      step(builder, "Validate exact managed image before promotion").run,
      "managed image validation script is missing",
    );
    expect(validation.match(/docker run/g)).toHaveLength(4);
    expect(validation.match(/--platform "\$PLATFORM"/g)).toHaveLength(5);
    expect(
      validation.match(
        /"\$reference" \\\n\s+env \\\n\s+"NEMOCLAW_STARTUP_PROFILE_B64=\$profile" \\\n\s+"NEMOCLAW_CORPORATE_CA_B64=\$corporate_ca_b64" \\\n\s+nemoclaw-start \\/gu,
      ),
    ).toHaveLength(2);
  });

  it("executes the all-three barrier and rejects incomplete or stale sets before promotion", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const barrier = required(
      step(managedPromoter(workflow), "Validate complete managed image candidate set").run,
      "managed image all-three barrier script is missing",
    );
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-candidates-"));
    const candidateRoot = path.join(temporaryRoot, "candidates");
    const revision = "a".repeat(40);
    const repository = "NVIDIA/NemoClaw";
    const runId = "7744";
    const runAttempt = "2";
    const candidates = [
      {
        artifact: "managed-image-candidate-openclaw-linux-amd64",
        agent: "openclaw",
        image: "ghcr.io/nvidia/nemoclaw/openclaw-sandbox",
      },
      {
        artifact: "managed-image-candidate-hermes-linux-amd64",
        agent: "hermes",
        image: "ghcr.io/nvidia/nemoclaw/hermes-sandbox",
      },
      {
        artifact: "managed-image-candidate-langchain-deepagents-code-linux-amd64",
        agent: "langchain-deepagents-code",
        image: "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox",
      },
    ] as const;

    const writeCandidate = (
      candidate: (typeof candidates)[number],
      sourceRevision: string,
      cohort = `ghrun-${runId}-${runAttempt}`,
    ) => {
      const artifactRoot = path.join(candidateRoot, candidate.artifact);
      fs.mkdirSync(artifactRoot, { recursive: true });
      const digest = `sha256:${candidate.agent.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`;
      fs.writeFileSync(
        path.join(artifactRoot, "contract.json"),
        `${JSON.stringify(
          {
            contractVersion: 1,
            phase: "candidate",
            agent: candidate.agent,
            image: candidate.image,
            digest,
            reference: `${candidate.image}@${digest}`,
            baseReference: `ghcr.io/nvidia/nemoclaw/${candidate.agent}-base@${digest}`,
            platform: "linux/amd64",
            source: {
              repository,
              revision: sourceRevision,
              ref: "refs/heads/main",
              cohort,
            },
            run: {
              id: Number(runId),
              attempt: Number(runAttempt),
            },
            release: null,
          },
          null,
          2,
        )}\n`,
      );
    };
    const runBarrier = (outputName: string) =>
      spawnSync("bash", ["-c", barrier], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CANDIDATE_ROOT: candidateRoot,
          GITHUB_OUTPUT: path.join(temporaryRoot, outputName),
          GITHUB_REF: "refs/heads/main",
          GITHUB_REPOSITORY: repository,
          GITHUB_RUN_ATTEMPT: runAttempt,
          GITHUB_RUN_ID: runId,
          GITHUB_SHA: revision,
          RUNNER_TEMP: temporaryRoot,
        },
      });

    try {
      for (const candidate of candidates) writeCandidate(candidate, revision);
      const accepted = runBarrier("accepted-output");
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(fs.readFileSync(path.join(temporaryRoot, "accepted-output"), "utf8")).toContain(
        "candidate_set=",
      );

      writeCandidate(candidates[1], "b".repeat(40));
      const rejected = runBarrier("rejected-output");
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        "complete managed image candidate set failed closed validation",
      );

      writeCandidate(candidates[1], revision);
      writeCandidate(candidates[2], revision, "ghrun-7744-3");
      const mixedCohort = runBarrier("mixed-cohort-output");
      expect(mixedCohort.status).not.toBe(0);
      expect(mixedCohort.stderr).toContain(
        "complete managed image candidate set failed closed validation",
      );

      writeCandidate(candidates[2], revision);
      fs.rmSync(path.join(candidateRoot, candidates[2].artifact), {
        recursive: true,
        force: true,
      });
      const incomplete = runBarrier("incomplete-output");
      expect(incomplete.status).not.toBe(0);
      expect(incomplete.stderr).toContain(
        "expected exactly three managed image candidate artifacts",
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("stages the complete cohort before moving only OpenClaw consumer pointers", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const promotion = required(
      step(managedPromoter(workflow), "Promote validated managed image aliases").run,
      "managed image promotion script is missing",
    );
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-promotion-"));
    const fakeBin = path.join(temporaryRoot, "bin");
    const callLog = path.join(temporaryRoot, "docker-calls.log");
    const candidateSet = path.join(temporaryRoot, "candidate-set.json");
    const revision = "a".repeat(40);
    const cohort = "ghrun-7744-2";
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_CALL_LOG"
if [ "\${FAIL_OPENCLAW_COHORT:-0}" = "1" ] &&
   [[ "$*" == *"imagetools create"* ]] &&
   [[ "$*" == *"openclaw-sandbox:cohort-${cohort}"* ]]; then
  exit 91
fi
if [[ "$*" == *"imagetools inspect"* ]]; then
  printf '%s\\n' "validated-manifest"
fi
`,
      { mode: 0o755 },
    );
    const candidates = [
      ["hermes", "ghcr.io/nvidia/nemoclaw/hermes-sandbox", "1"],
      [
        "langchain-deepagents-code",
        "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox",
        "2",
      ],
      ["openclaw", "ghcr.io/nvidia/nemoclaw/openclaw-sandbox", "3"],
    ].map(([agent, image, digestSeed]) => {
      const digest = `sha256:${digestSeed.repeat(64)}`;
      return {
        contractVersion: 1,
        phase: "candidate",
        agent,
        image,
        digest,
        reference: `${image}@${digest}`,
        baseReference: `${image}-base@${digest}`,
        platform: "linux/amd64",
        source: {
          repository: "NVIDIA/NemoClaw",
          revision,
          ref: "refs/tags/v0.0.97",
          cohort,
        },
        run: { id: 7744, attempt: 2 },
        release: "v0.0.97",
      };
    });
    fs.writeFileSync(candidateSet, `${JSON.stringify(candidates)}\n`);

    try {
      const result = spawnSync("bash", ["-c", promotion], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CANDIDATE_SET: candidateSet,
          DOCKER_CALL_LOG: callLog,
          FAIL_OPENCLAW_COHORT: "1",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_RUN_ID: "7744",
          GITHUB_SHA: revision,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: temporaryRoot,
        },
      });

      expect(result.status).toBe(91);
      const calls = fs.readFileSync(callLog, "utf8");
      expect(calls).toContain(`hermes-sandbox:cohort-${cohort}`);
      expect(calls).toContain(`langchain-deepagents-code-sandbox:cohort-${cohort}`);
      expect(calls).toContain(`openclaw-sandbox:cohort-${cohort}`);
      expect(calls).not.toContain(`openclaw-sandbox:${revision}`);
      expect(calls).not.toContain("openclaw-sandbox:v0.0.97");
      expect(calls).not.toContain(`hermes-sandbox:${revision}`);
      expect(calls).not.toContain("hermes-sandbox:v0.0.97");
      expect(calls).not.toContain(`langchain-deepagents-code-sandbox:${revision}`);
      expect(calls).not.toContain("langchain-deepagents-code-sandbox:v0.0.97");

      fs.writeFileSync(callLog, "");
      const accepted = spawnSync("bash", ["-c", promotion], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CANDIDATE_SET: candidateSet,
          DOCKER_CALL_LOG: callLog,
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_RUN_ID: "7744",
          GITHUB_SHA: revision,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: temporaryRoot,
        },
      });
      expect(accepted.status, accepted.stderr).toBe(0);
      const acceptedCalls = fs.readFileSync(callLog, "utf8");
      const lastCohortStage = Math.max(
        acceptedCalls.indexOf(`hermes-sandbox:cohort-${cohort}`),
        acceptedCalls.indexOf(`langchain-deepagents-code-sandbox:cohort-${cohort}`),
        acceptedCalls.indexOf(`openclaw-sandbox:cohort-${cohort}`),
      );
      const consumerPointer = acceptedCalls.indexOf(`openclaw-sandbox:${revision}`);
      expect(lastCohortStage).toBeGreaterThanOrEqual(0);
      expect(consumerPointer).toBeGreaterThan(lastCohortStage);
      expect(acceptedCalls).toContain("openclaw-sandbox:v0.0.97");
      expect(acceptedCalls).not.toContain(`hermes-sandbox:${revision}`);
      expect(acceptedCalls).not.toContain("hermes-sandbox:v0.0.97");
      expect(acceptedCalls).not.toContain(`langchain-deepagents-code-sandbox:${revision}`);
      expect(acceptedCalls).not.toContain("langchain-deepagents-code-sandbox:v0.0.97");

      const contractsRoot = path.join(temporaryRoot, "managed-image-contracts");
      const contractAliases = (agent: string) =>
        JSON.parse(fs.readFileSync(path.join(contractsRoot, agent, "contract.json"), "utf8")) as {
          aliases: string[];
          source: { cohort: string };
        };
      expect(contractAliases("hermes")).toMatchObject({
        aliases: [`ghcr.io/nvidia/nemoclaw/hermes-sandbox:cohort-${cohort}`],
        source: expect.objectContaining({ cohort }),
      });
      expect(contractAliases("langchain-deepagents-code")).toMatchObject({
        aliases: [`ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox:cohort-${cohort}`],
        source: expect.objectContaining({ cohort }),
      });
      expect(contractAliases("openclaw")).toMatchObject({
        aliases: [
          `ghcr.io/nvidia/nemoclaw/openclaw-sandbox:cohort-${cohort}`,
          `ghcr.io/nvidia/nemoclaw/openclaw-sandbox:${revision}`,
          "ghcr.io/nvidia/nemoclaw/openclaw-sandbox:v0.0.97",
        ],
        source: expect.objectContaining({ cohort }),
      });
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
