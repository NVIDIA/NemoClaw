// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob, type WorkflowStep } from "./helpers/e2e-workflow-contract";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const DEPENDENCY_REVIEW = path.join(
  REPO_ROOT,
  "docs",
  "security",
  "openclaw-2026.6.10-dependency-review.md",
);
const CODEX_ACP_TARBALL =
  "https://registry.npmjs.org/@zed-industries/codex-acp/-/codex-acp-0.11.1.tgz";
const OPENCLAW_TARBALL = "https://registry.npmjs.org/openclaw/-/openclaw-2026.6.10.tgz";
const MESSAGING_BUILD_APPLIER = path.join(
  REPO_ROOT,
  "src",
  "lib",
  "messaging",
  "applier",
  "build",
  "messaging-build-applier.mts",
);
const ISSUE_4434_PATCH = path.join(
  REPO_ROOT,
  "scripts",
  "patch-openclaw-issue-4434-diagnostics.ts",
);
const DEVICE_SELF_APPROVAL_PATCH = path.join(
  REPO_ROOT,
  "scripts",
  "patch-openclaw-device-self-approval.ts",
);
const REBUILD_RESUME_SESSION = path.join(
  REPO_ROOT,
  "src",
  "lib",
  "actions",
  "sandbox",
  "rebuild-resume-session.ts",
);

type Workflow = {
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

function requiredStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `Missing workflow step: ${name}`).toBeDefined();
  return step as WorkflowStep;
}

function requiredStepIndex(job: WorkflowJob, name: string): number {
  const index = job.steps?.findIndex((candidate) => candidate.name === name) ?? -1;
  expect(index, `Missing workflow step: ${name}`).toBeGreaterThanOrEqual(0);
  return index;
}

function expectProductionDockerBuildGuard(job: WorkflowJob, stepName: string): void {
  const run = requiredStep(job, stepName).run ?? "";
  const guardIndex = run.indexOf("scripts/check-production-build-args.sh");
  const buildIndex = run.indexOf("docker build");

  expect(guardIndex, stepName).toBeGreaterThanOrEqual(0);
  expect(buildIndex, stepName).toBeGreaterThanOrEqual(0);
  expect(guardIndex, stepName).toBeLessThan(buildIndex);
}

function expectBuildPushGuard(job: WorkflowJob, guardStepName: string): void {
  const guardIndex = requiredStepIndex(job, guardStepName);
  const buildIndex =
    job.steps?.findIndex((step) =>
      String(step.uses ?? "").startsWith("docker/build-push-action@"),
    ) ?? -1;

  expect(buildIndex, guardStepName).toBeGreaterThanOrEqual(0);
  expect(guardIndex, guardStepName).toBeLessThan(buildIndex);
  expect(requiredStep(job, guardStepName).run).toContain("scripts/check-production-build-args.sh");
}

function findProductionBuildGuardCoverage(
  workflowName: string,
  workflow: Workflow,
): Array<{ label: string; guarded: boolean }> {
  return Object.entries(workflow.jobs).flatMap(([jobName, job]) => {
    const steps = job.steps ?? [];
    return steps
      .map((step, index) => ({ step, index, run: step.run ?? "" }))
      .filter(
        ({ step, run }) =>
          (/\bdocker build\b/.test(run) &&
            /(?:^|\s)-t\s+["']?nemoclaw-(?:hermes-)?production(?:-arm64)?["']?(?:\s|$)/.test(
              run,
            )) ||
          String(step.uses ?? "").startsWith("docker/build-push-action@"),
      )
      .map(({ step, index, run }) => ({
        label: `${workflowName}:${jobName}:${step.name ?? step.uses}`,
        guarded:
          (run.indexOf("scripts/check-production-build-args.sh") >= 0 &&
            run.indexOf("scripts/check-production-build-args.sh") < run.indexOf("docker build")) ||
          steps
            .slice(0, index)
            .some((candidate) =>
              (candidate.run ?? "").includes("scripts/check-production-build-args.sh"),
            ),
      }));
  });
}

function runBaseImageBuildArgGuard(
  step: WorkflowStep,
  openclawVersion: string,
): { output: string; result: ReturnType<typeof spawnSync> } {
  const tmp = mkdtempSync(path.join(tmpdir(), "nemoclaw-base-image-build-args-"));
  const githubOutput = path.join(tmp, "github-output");
  try {
    const result = spawnSync("bash", ["-c", step.run ?? ""], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: githubOutput,
        OPENCLAW_VERSION_INPUT: openclawVersion,
      },
    });
    const output = existsSync(githubOutput) ? readFileSync(githubOutput, "utf-8") : "";
    return { output, result };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("OpenClaw 2026.6.10 dependency review contract", () => {
  it("keeps advisor disposition evidence in the dependency review note", () => {
    const review = readFileSync(DEPENDENCY_REVIEW, "utf-8");

    expect(review).toContain("Issue #5591 Acceptance Mapping");
    expect(review).toContain('"Latest stable version of Hermes"');
    expect(review).toContain('"Latest version of OpenShell"');
    expect(review).toContain('"Latest stable version of OpenClaw"');
    expect(review).toContain("merged PR #5594");
    expect(review).toContain("merged PR #5596");
    expect(review).toContain("references rather than closes #5591");
    expect(review).toContain(CODEX_ACP_TARBALL);
    expect(review).toContain("bind reviewed npm installs to verified local archives");
    expect(review).toContain("downloaded tarball integrity");
    expect(review).toContain("npm pack --json");
    expect(review).toContain("install the verified archive path");
    expect(review).toContain(
      "reported filename must be contained inside the freshly created pack directory",
    );
    expect(review).toContain("unsafe reported archive filenames");
    expect(review).toContain("no installer code consumes raw `npm pack --json` filenames");
    expect(review).toContain("The #4434 compatibility-shim disposition is explicitly accepted");
    expect(review).toContain(
      "The assembled-image and rebuilt-sandbox proof residual is explicitly accepted",
    );
    expect(review).toContain(
      "No single lane combines the final production image, a live `host.openshell.internal` SSRF-negative matrix",
    );
    expect(review).toContain(
      "The literal issue #2478 Local Ollama plus Telegram inbound recovery residual is explicitly accepted",
    );
    expect(review).toContain(
      "This does not reproduce `nemotron-3-super:120b` on Local Ollama or originate a Telegram inbound update after the crash",
    );
    expect(review).not.toContain("PRA-5");
    expect(review).toContain("3/3 fields are present in the NemoClaw-patched runtime output");
    expect(review).toContain(
      "3/3 fields are missing in the upstream-shaped `openclaw@2026.6.10` output",
    );
    expect(review).toContain("OpenClaw Patch Source-of-Truth Table");
    expect(review).toContain(
      "| Patch | Invalid state | Source boundary | Why upstream/source cannot be fixed here | Regression test | Removal condition |",
    );

    for (const [patch, requiredTerms] of [
      ["Patch 2:", ["assertExplicitProxyAllowed", "OPENSHELL_SANDBOX=1", "upstream"]],
      ["Patch 2b:", ["host.openshell.internal", "useEnvProxy", "allowedHostnames"]],
      ["Patch 4:", ["managed-proxy activation", "dispatcherPolicy", "strict fetches"]],
      [
        "Patch 6:",
        ["cron model-provider preflight", "trusted_env_proxy", "cron-model-provider-preflight"],
      ],
      [
        "Patch 7:",
        [
          "#4434 TUI unreachable-inference diagnostic enrichment",
          "OPENSHELL_SANDBOX=1",
          "formatRawAssistantErrorForUi",
        ],
      ],
      [
        "Patch 8:",
        ["bounded same-device device scope approval", "operator.pairing", "approveDevicePairing"],
      ],
    ] as const) {
      const row = review.split("\n").find((line) => line.includes(`| ${patch}`));
      expect(row, patch).toBeDefined();
      expect(
        row
          ?.split("|")
          .slice(1, -1)
          .every((cell) => cell.trim().length > 0),
        patch,
      ).toBe(true);
      for (const term of requiredTerms) {
        expect(row, `${patch} ${term}`).toContain(term);
      }
    }

    expect(review).toContain("OpenClaw Diagnostics OTEL Host Gateway Boundary");
    expect(review).toContain("openclaw-diagnostics-otel-local");
    expect(review).toContain("separate from the `web_fetch` host-gateway exception");
    expect(review).toContain("contains no `web_fetch`, `fetchWithSsrFGuard`");

    expect(review).toContain("Microsoft Teams Live E2E Disposition");
    expect(review).toContain("No real Microsoft Teams tenant proof is included in this PR");
    expect(review).toContain("tracked as a follow-up outside this dependency bump");
    expect(review).toContain("must not be described as a Teams round trip");
    expect(review).not.toContain("teams-message-round-trip");

    expect(review).toContain("Advisor Disposition");
    expect(review).toContain("Release Checklist for Accepted Residual Risk");
    expect(review).toContain("test/openclaw-real-patched-dist-harness.test.ts");
    expect(review).toContain("NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS=1");
    expect(review).toContain("PR CI intentionally does not treat PR-authored harness code");
    expect(review).toContain("applies the Dockerfile patch block");
    expect(review).toContain("test/openclaw-issue-4434-diagnostics-patch.test.ts");
    expect(review).toContain("scripts/patch-openclaw-issue-4434-diagnostics.ts");
    expect(review).toContain("scripts/patch-openclaw-device-self-approval.ts");
    expect(review).toContain("NemoClaw no longer reads or writes device state during approval");
    expect(review).toContain("Merge disposition for this OpenClaw 2026.6.10 bump");
    expect(review).toContain("Issue #4434 full live acceptance");
    expect(review).toContain("code-backed for the reviewed `openclaw@2026.6.10` artifact");
    expect(review).toContain("src/lib/messaging/channels/manifests.test.ts");
    expect(review).toContain("npm audit result in this note is a manual snapshot");
    expect(review).toContain("Advisory audit revalidated: 2026-07-03");
    expect(review).toContain("0` critical vulnerabilities across `763` total dependencies");
    expect(review).toContain("Node `v22.22.2`");
    expect(review).toContain("engine requirement of `>=22.19.0`");
    expect(review).toContain(
      "CI job for `npm install --package-lock-only --ignore-scripts && npm audit --omit=dev --json`",
    );
    expect(review).toContain("Transitive Dependency Graph Rationale");
    expect(review).toContain(
      "The OpenClaw 2026.6.10 bump does not newly introduce an unfrozen OpenClaw transitive graph",
    );
    expect(review).toContain(
      "The reviewed `openclaw@2026.6.10` artifact ships `npm-shrinkwrap.json`",
    );
    expect(review).toContain(
      "the previous reviewed `openclaw@2026.6.9` artifact also shipped `npm-shrinkwrap.json`",
    );
    expect(review).toContain("lockfile version `3`, `306` package entries");
    expect(review).toContain("no resolved package entries missing integrity metadata");
    expect(review).toContain("`@openclaw/diagnostics-otel@2026.6.10`");
    expect(review).toContain("`@openclaw/brave-plugin@2026.6.10`");
    expect(review).toContain("`@openclaw/discord@2026.6.10`");
    expect(review).toContain("`@openclaw/slack@2026.6.10`");
    expect(review).toContain("`@openclaw/whatsapp@2026.6.10`");
    expect(review).toContain("`@openclaw/msteams@2026.6.10`");
    expect(review).toContain("`@zed-industries/codex-acp@0.11.1` has no declared npm dependencies");
    expect(review).toContain(
      "the existing non-OpenClaw Tencent WeChat plugin, `@tencent-weixin/openclaw-weixin@2.4.3`",
    );
    expect(review).toContain("not introduced by the OpenClaw version change");
    expect(review).toContain("third-party messaging plugins without package-internal shrinkwraps");
    expect(review).toContain(
      "The transitive npm graph warning is dispositioned by package evidence",
    );
    expect(review).toContain("stale nonterminal rebuild-resume repair");
    expect(review).toContain("tracked against #4533");
    expect(review).toContain("src/lib/actions/sandbox/rebuild-resume-session.test.ts");
    expect(review).toContain("test/onboard-resume-provider-recovery.test.ts");
    expect(review).toContain("machine.state='openclaw'");
    expect(review).toContain("scripts/check-production-build-args.sh");
    expect(review).toContain("every declared integrity/tarball ARG override");
    expect(review).toContain("future-shaped positional pin names");
    expect(review).toContain("Recovered Gateway Credential Boundary");
    expect(review).toContain("OpenClaw Device Approval Convergence Boundary");
    expect(review).toContain("device-token authentication");
    expect(review).toContain("repeats current pending identity, role, repair-marker");
    expect(review).toContain("NemoClaw no longer reads or writes device state during approval");
    expect(review).toContain(
      "delete Patch 8 when a reviewed OpenClaw release completes this bounded same-device flow",
    );
    expect(review).toContain("src/lib/onboard/recovered-provider-reuse.ts");
    expect(review).toContain("passes that route only in memory to the same sandbox's recreate");
    expect(review).toContain("test/onboard-remote-recreate-credential-reuse.test.ts");
    expect(review).toContain("Image-Managed OpenClaw Extension Restore Boundary");
    expect(review).toContain("src/lib/state/openclaw-managed-extensions.ts");
    expect(review).toContain("issue #5896");
    expect(review).toContain("route-provenance additions remain with their");
    expect(review).toContain("`src/lib/state/sandbox.ts` is 100 lines smaller");
    expect(review).toContain("shared archive-installer redesign remains explicitly deferred");
    expect(review).toContain("Deferred #5896 Archive Consolidation Contract");
    expect(review).toContain("protected exact provenance marker");
    expect(review).toContain("mcporter package, SRI, lockfile SHA-256");
    expect(review).toContain("removes the marker before applying NemoClaw patches");
    expect(review).toContain("fifteen fallback states");
    expect(review).toContain("issue #5896 section 2");
    expect(review).toContain("issue #5896 section 9");
    expect(review).toContain("direct source- and target-traversal vectors");
    expect(review).toContain("Live gateway display output is treated as untrusted text");
    expect(review).toContain("gateway-provider-metadata.ts");
    expect(review).toContain("Partial, oversized, duplicated, malformed, or ambiguous output");
    expect(review).toContain("Retained older OpenClaw pins are inactive compatibility/rollback");
    expect(review).toContain("fails closed on unknown or ambiguous formatter shapes");
    expect(review).toContain('OPENCLAW_VERSION="${OPENCLAW_VERSION}"');
    expect(review).toContain("test/messaging-build-applier-integrity.test.ts");
    expect(review).toContain("test/messaging-build-applier-render-safety.test.ts");
    expect(review).toContain("test/onboard-resume-provider-recovery.test.ts");
  });

  it("keeps every reviewed archive boundary on the deferred invariant matrix (#5896)", () => {
    const result = spawnSync(
      "bash",
      [
        "-lc",
        `
set -euo pipefail

messaging_build_applier=${JSON.stringify(MESSAGING_BUILD_APPLIER)}

boundary_marker_count="$(grep -hF 'Reviewed-archive invariants (#5896):' Dockerfile Dockerfile.base "$messaging_build_applier" | wc -l | tr -d ' ')"
test "$boundary_marker_count" -eq 5

check_contains() {
  haystack="$1"
  needle="$2"
  label="$3"
  case "$haystack" in
    *"$needle"*) ;;
    *) echo "missing $label: $needle" >&2; exit 1 ;;
  esac
}

codex_acp_block="$(sed -n '/# Pre-install the codex-acp package/,/# Upgrade OpenClaw if the base image is stale./p' Dockerfile)"
check_contains "$codex_acp_block" "CODEX_ACP_TARBALL='${CODEX_ACP_TARBALL}'" "codex-acp tarball"
check_contains "$codex_acp_block" 'npm view "\${CODEX_ACP_SPEC}" dist.integrity' "codex-acp registry integrity"
check_contains "$codex_acp_block" 'npm view "\${CODEX_ACP_SPEC}" dist.tarball' "codex-acp registry tarball"
check_contains "$codex_acp_block" 'npm pack "$pack_spec" --pack-destination "$pack_dir" --json' "codex-acp pack"
check_contains "$codex_acp_block" 'CODEX_ACP_PACK_PATH="$(pack_reviewed_npm_tarball "$CODEX_ACP_TARBALL" "$CODEX_ACP_0_11_1_INTEGRITY" "$CODEX_ACP_PACK_DIR" "$CODEX_ACP_SPEC")"' "codex-acp pack path"
check_contains "$codex_acp_block" '"$CODEX_ACP_PACK_PATH"' "codex-acp local install path"
check_contains "$codex_acp_block" 'reported unsafe archive filename' "codex-acp unsafe filename guard"
check_contains "$codex_acp_block" 'CODEX_ACP_PACK_DIR="$(mktemp -d)"' "codex-acp fresh pack directory"
check_contains "$codex_acp_block" 'rm -rf "$CODEX_ACP_PACK_DIR"' "codex-acp cleanup"

for dockerfile in Dockerfile Dockerfile.base; do
  case "$dockerfile" in
    Dockerfile) end_marker='# Patch OpenClaw media fetch' ;;
    Dockerfile.base) end_marker='# Baseline health check.' ;;
  esac
  openclaw_block="$(sed -n "/ARG OPENCLAW_VERSION=2026.6.10/,/$end_marker/p" "$dockerfile")"
  check_contains "$openclaw_block" "ARG OPENCLAW_2026_6_10_TARBALL=${OPENCLAW_TARBALL}" "$dockerfile tarball arg"
  check_contains "$openclaw_block" 'npm view "openclaw@\${OPENCLAW_VERSION}" dist.integrity' "$dockerfile registry integrity"
  check_contains "$openclaw_block" 'npm view "openclaw@\${OPENCLAW_VERSION}" dist.tarball' "$dockerfile registry tarball"
  check_contains "$openclaw_block" 'OPENCLAW_PACK_PATH="$(pack_reviewed_npm_tarball "$EXPECTED_TARBALL" "$EXPECTED_INTEGRITY" "$OPENCLAW_PACK_DIR"' "$dockerfile pack path"
  check_contains "$openclaw_block" '"$OPENCLAW_PACK_PATH"' "$dockerfile local install path"
  check_contains "$openclaw_block" 'reported unsafe archive filename' "$dockerfile unsafe filename guard"
  check_contains "$openclaw_block" 'OPENCLAW_PACK_DIR="$(mktemp -d)"' "$dockerfile fresh pack directory"
  check_contains "$openclaw_block" 'rm -rf "$OPENCLAW_PACK_DIR"' "$dockerfile cleanup"
  check_contains "$openclaw_block" 'openclaw-base-provenance-v1' "$dockerfile base provenance path"
  check_contains "$openclaw_block" 'recipe=ignore-scripts+reviewed-lifecycle-v1' "$dockerfile base provenance recipe"
  check_contains "$openclaw_block" 'mcporter-package=mcporter@' "$dockerfile mcporter provenance package"
  check_contains "$openclaw_block" 'mcporter-integrity=' "$dockerfile mcporter provenance integrity"
  check_contains "$openclaw_block" 'mcporter-lock-sha256=' "$dockerfile mcporter provenance lock hash"
  check_contains "$openclaw_block" 'mcporter-recipe=locked-ci+audit-signatures-v1' "$dockerfile mcporter provenance recipe"
done

check_contains "$(cat Dockerfile.base)" 'chmod 0444 "$OPENCLAW_PROVENANCE_TMP"' "base provenance protected mode"
check_contains "$(cat Dockerfile)" "stat -c '%u:%g:%a'" "runtime provenance metadata format"
check_contains "$(cat Dockerfile)" '0:0:444' "runtime provenance exact metadata"
check_contains "$(cat Dockerfile)" 'rm -rf "$OPENCLAW_PROVENANCE_PATH"' "runtime provenance consumption"

optional_plugin_block="$(sed -n '/# Install non-messaging OpenClaw plugins that need to match the runtime./,/^RUN OPENCLAW_VERSION=/p' Dockerfile)"
check_contains "$optional_plugin_block" 'npm view "$plugin_spec" dist.integrity' "optional plugin registry integrity"
check_contains "$optional_plugin_block" 'npm view "$plugin_spec" dist.tarball' "optional plugin registry tarball"
check_contains "$optional_plugin_block" 'npm pack "$expected_tarball" --pack-destination "$NEMOCLAW_OPENCLAW_PLUGIN_PACK_DIR" --json' "optional plugin pack"
check_contains "$optional_plugin_block" 'openclaw plugins install "$plugin_archive" --pin' "optional plugin archive install"
check_contains "$optional_plugin_block" 'reported unsafe archive filename' "optional plugin unsafe filename guard"
check_contains "$optional_plugin_block" 'NEMOCLAW_OPENCLAW_PLUGIN_PACK_DIR="$(mktemp -d)"' "optional plugin fresh pack directory"
check_contains "$optional_plugin_block" 'rm -rf "$NEMOCLAW_OPENCLAW_PLUGIN_PACK_DIR"' "optional plugin cleanup"

	grep -Fq 'spawnSync("npm", ["pack", packageSpec, "--pack-destination", rootDir, "--json"]' "$messaging_build_applier"
	grep -Fq '["openclaw", "plugins", "install", packed.archivePath, ...(install.pin ? ["--pin"] : [])]' "$messaging_build_applier"
	grep -Fq 'OPENCLAW_MESSAGING_PLUGIN_ARCHIVE_PROVENANCE_POLICY.registryIntegrityField' "$messaging_build_applier"
	grep -Fq 'downloaded tarball integrity mismatch' "$messaging_build_applier"
	grep -Fq 'mkdtempSync(join(tmpdir(), "nemoclaw-openclaw-plugin-pack-"))' "$messaging_build_applier"
	grep -Fq 'rmSync(rootDir, { recursive: true, force: true })' "$messaging_build_applier"
	grep -Fq 'resolveNpmPackArchivePath(packageSpec, rootDir, filename)' "$messaging_build_applier"
	grep -Fq 'reported unsafe archive filename' "$messaging_build_applier"
	issue_4434_patch=${JSON.stringify(ISSUE_4434_PATCH)}
	grep -Fq 'formatRawAssistantErrorForUi' "$issue_4434_patch"
	grep -Fq 'OPENSHELL_SANDBOX !== "1"' "$issue_4434_patch"
		grep -Fq 'nemoclaw: #4434 structured unreachable-inference diagnostic' "$issue_4434_patch"
		grep -Fq 'COPY scripts/patch-openclaw-issue-4434-diagnostics.ts /usr/local/lib/nemoclaw/patch-openclaw-issue-4434-diagnostics.ts' Dockerfile
		grep -Fq 'node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-issue-4434-diagnostics.ts \\' Dockerfile
		device_self_approval_patch=${JSON.stringify(DEVICE_SELF_APPROVAL_PATCH)}
		grep -Fq 'nemoclaw: reach gateway for bounded same-device scope approval' "$device_self_approval_patch"
		grep -Fq 'nemoclaw: bounded same-device scope approval' "$device_self_approval_patch"
		grep -Fq 'nemoclaw: validate bounded self-approval inside pairing lock' "$device_self_approval_patch"
		grep -Fq 'COPY scripts/patch-openclaw-device-self-approval.ts /usr/local/lib/nemoclaw/patch-openclaw-device-self-approval.ts' Dockerfile
		grep -Fq 'node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-device-self-approval.ts \\' Dockerfile

	phase_count="$(grep -Ec '^RUN OPENCLAW_VERSION="[$][{]OPENCLAW_VERSION[}]" node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier\\.mts --agent openclaw --phase (runtime-setup|agent-install|post-agent-install)$' Dockerfile)"
test "$phase_count" -eq 3
grep -Fq -- '--phase runtime-setup' Dockerfile
grep -Fq -- '--phase agent-install' Dockerfile
grep -Fq -- '--phase post-agent-install' Dockerfile
`,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it("records the fail-closed messaging plugin provenance boundary", () => {
    const review = readFileSync(DEPENDENCY_REVIEW, "utf-8");
    const source = readFileSync(MESSAGING_BUILD_APPLIER, "utf-8");

    expect(review).toContain("Messaging Plugin Registry Provenance Boundary");
    expect(review).toContain("`registryTarballUrl` policy is `must-match-committed-url`");
    expect(review).toContain("committed exact URL matching registry `dist.tarball`");
    expect(review).toContain("carry exact tarball URLs for every messaging plugin");
    expect(source).toContain('registryTarballField: "dist.tarball"');
    expect(source).toContain('registryTarballUrl: "must-match-committed-url"');
  });

  it("keeps the rebuild-resume compatibility shim tied to its removal tracker", () => {
    const source = readFileSync(REBUILD_RESUME_SESSION, "utf-8");

    expect(source).toContain("Invalid legacy shape");
    expect(source).toContain("Removal condition");
    expect(source).toContain("#4533");
  });

  it("keeps production Docker build workflows behind the build-arg guard", () => {
    const prSelfHosted = readYaml<Workflow>(".github/workflows/pr-self-hosted.yaml");
    const sandboxImages = readYaml<Workflow>(".github/workflows/sandbox-images-and-e2e.yaml");
    const baseImages = readYaml<Workflow>(".github/workflows/base-image.yaml");

    expectProductionDockerBuildGuard(
      prSelfHosted.jobs["build-sandbox-images"] as WorkflowJob,
      "Build production image",
    );
    expectProductionDockerBuildGuard(
      prSelfHosted.jobs["build-sandbox-images-arm64"] as WorkflowJob,
      "Build production image on arm64",
    );
    expectProductionDockerBuildGuard(
      sandboxImages.jobs["build-sandbox-images"] as WorkflowJob,
      "Build production image",
    );
    expectProductionDockerBuildGuard(
      sandboxImages.jobs["build-hermes-sandbox-image"] as WorkflowJob,
      "Build Hermes production image",
    );
    expectProductionDockerBuildGuard(
      sandboxImages.jobs["build-sandbox-images-arm64"] as WorkflowJob,
      "Build production image on arm64",
    );
    expectBuildPushGuard(
      baseImages.jobs["build-and-push"] as WorkflowJob,
      "Validate production Docker build args",
    );
    expectBuildPushGuard(
      baseImages.jobs["build-and-push-hermes"] as WorkflowJob,
      "Validate Hermes production Docker build args",
    );
    expectBuildPushGuard(
      baseImages.jobs["build-and-push-langchain-deepagents-code"] as WorkflowJob,
      "Validate Deep Agents Code production Docker build args",
    );

    const discoveredBuilds = [
      ...findProductionBuildGuardCoverage("pr-self-hosted", prSelfHosted),
      ...findProductionBuildGuardCoverage("sandbox-images-and-e2e", sandboxImages),
      ...findProductionBuildGuardCoverage("base-image", baseImages),
    ];
    expect(discoveredBuilds.map(({ label }) => label)).toHaveLength(8);
    expect(discoveredBuilds.filter(({ guarded }) => !guarded)).toEqual([]);

    const productionWorkflowContract = JSON.stringify({ prSelfHosted, sandboxImages, baseImages });
    for (const fixtureSelector of [
      "NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1",
      "OPENCLAW_VERSION=2026.3.11",
      "OPENCLAW_VERSION=2026.4.24",
      "OPENCLAW_2026_3_11_INTEGRITY",
      "OPENCLAW_2026_3_11_TARBALL",
      "OPENCLAW_2026_4_24_INTEGRITY",
      "OPENCLAW_2026_4_24_TARBALL",
    ]) {
      expect(productionWorkflowContract).not.toContain(fixtureSelector);
    }
  });

  it("guards and exports the base-image dispatch version as one scalar", () => {
    const baseImages = readYaml<Workflow>(".github/workflows/base-image.yaml");
    const buildAndPush = baseImages.jobs["build-and-push"] as WorkflowJob;
    const guard = requiredStep(buildAndPush, "Validate production Docker build args");
    const build = requiredStep(buildAndPush, "Build and push");

    expect(guard.id).toBe("production-build-args");
    expect(guard.env).toEqual({
      OPENCLAW_VERSION_INPUT: "${{ inputs.openclaw_version }}",
    });
    expect(guard.run).toContain(`"$OPENCLAW_VERSION_INPUT" == *$'\\r'*`);
    expect(guard.run).toContain(`"$OPENCLAW_VERSION_INPUT" == *$'\\n'*`);
    expect(guard.run).toContain(`"$OPENCLAW_VERSION_INPUT" =~ ^[0-9]+([.][0-9]+)*$`);
    expect(guard.run).toContain('scripts/check-production-build-args.sh "${build_args[@]}"');
    expect(guard.run).toContain(
      `printf 'openclaw_build_arg=%s\\n' "$openclaw_build_arg" >> "$GITHUB_OUTPUT"`,
    );
    expect(build.with?.["build-args"]).toBe(
      "${{ steps.production-build-args.outputs.openclaw_build_arg }}",
    );
    expect(requiredStepIndex(buildAndPush, "Validate production Docker build args")).toBeLessThan(
      requiredStepIndex(buildAndPush, "Build and push"),
    );

    for (const [jobName, job] of Object.entries(baseImages.jobs)) {
      for (const step of job.steps ?? []) {
        expect(step.run ?? "", `${jobName}:${step.name ?? "unnamed step"}`).not.toContain(
          "${{ inputs.openclaw_version }}",
        );
      }
    }

    for (const [input, expectedOutput] of [
      ["", "openclaw_build_arg=\n"],
      ["2026", "openclaw_build_arg=OPENCLAW_VERSION=2026\n"],
      ["2026.6.10", "openclaw_build_arg=OPENCLAW_VERSION=2026.6.10\n"],
      ["1.2.3.4", "openclaw_build_arg=OPENCLAW_VERSION=1.2.3.4\n"],
    ]) {
      const { output, result } = runBaseImageBuildArgGuard(guard, input);
      expect(result.status, `${JSON.stringify(input)}: ${result.stderr}`).toBe(0);
      expect(output).toBe(expectedOutput);
    }

    for (const input of ["v2026.6.10", "2026.6.10-beta.1", "2026.6.10 trailing", "2026.4.24"]) {
      const { output, result } = runBaseImageBuildArgGuard(guard, input);
      expect(result.status, JSON.stringify(input)).toBe(1);
      expect(output).toBe("");
    }

    for (const input of [
      "2026.6.10\r",
      "2026.6.9\nNEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1\nOPENCLAW_VERSION=2026.4.24",
    ]) {
      const { output, result } = runBaseImageBuildArgGuard(guard, input);
      expect(result.status, JSON.stringify(input)).toBe(1);
      expect(output).toBe("");
      expect(result.stderr).toContain(
        "production Docker build arguments must not contain CR or LF characters",
      );
    }
  });

  it("runs and gates the real patched-distribution harness only from trusted main code", () => {
    const pr = readYaml<Workflow>(".github/workflows/pr.yaml");
    const main = readYaml<Workflow>(".github/workflows/main.yaml");
    const prJob = pr.jobs["real-openclaw-dist-harness"];
    const mainJob = main.jobs["real-openclaw-dist-harness"];
    const prChecks = pr.jobs.checks;
    const mainChecks = main.jobs.checks;

    expect(pr.permissions).toEqual({ contents: "read" });
    expect(prJob).toBeUndefined();
    expect(mainJob?.["timeout-minutes"]).toBe(12);
    expect(requiredStep(mainJob, "Audit the real patched OpenClaw distribution").env).toMatchObject(
      {
        NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS: "1",
      },
    );
    expect(requiredStep(mainJob, "Audit the real patched OpenClaw distribution").run).toContain(
      "test/openclaw-real-patched-dist-harness.test.ts",
    );
    expect(requiredStep(mainJob, "Install test dependencies").run).toBe("npm ci --ignore-scripts");
    expect(mainJob.env).toMatchObject({
      npm_config_fetch_retries: "3",
      npm_config_fetch_retry_mintimeout: "10000",
      npm_config_fetch_retry_maxtimeout: "60000",
    });

    expect(prChecks.needs).not.toContain("real-openclaw-dist-harness");
    expect(mainChecks.needs).toContain("real-openclaw-dist-harness");
    const prGate = requiredStep(prChecks, "Verify required PR checks");
    const mainGate = requiredStep(mainChecks, "Verify required main checks");
    expect(prGate.env).not.toHaveProperty("REAL_OPENCLAW_DIST_HARNESS_RESULT");
    expect(mainGate.env).toMatchObject({
      REAL_OPENCLAW_DIST_HARNESS_RESULT: "${{ needs['real-openclaw-dist-harness'].result }}",
    });

    expect(prGate.run).not.toContain("real-openclaw-dist-harness");
    expect(mainGate.run).toContain(
      'require_success "real-openclaw-dist-harness" "$REAL_OPENCLAW_DIST_HARNESS_RESULT"',
    );
    expect(mainGate.run).not.toContain('allow_success_or_skipped "real-openclaw-dist-harness"');
  });
});
