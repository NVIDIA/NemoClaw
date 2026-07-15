// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

function workflowContracts(): Array<{ name: string; workflow: Workflow }> {
  return readdirSync(path.join(REPO_ROOT, ".github", "workflows"))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({
      name: name.replace(/\.ya?ml$/, ""),
      workflow: readYaml<Workflow>(`.github/workflows/${name}`),
    }));
}

function runBaseImageBuildArgGuard(
  step: WorkflowStep,
  openclawVersion: string,
  agent = "openclaw",
): { output: string; result: ReturnType<typeof spawnSync> } {
  const tmp = mkdtempSync(path.join(tmpdir(), "nemoclaw-base-image-build-args-"));
  const githubOutput = path.join(tmp, "github-output");
  try {
    const result = spawnSync("bash", ["-c", step.run ?? ""], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        AGENT: agent,
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
    expect(review).toContain("contained regular-file basename in a fresh directory");
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
    expect(review).toContain("npm audit result in this note remains a point-in-time snapshot");
    expect(review).toContain("Advisory audit revalidated: 2026-07-03");
    expect(review).toContain("0` critical vulnerabilities across `763` total dependencies");
    expect(review).toContain("Node `v22.22.2`");
    expect(review).toContain("engine requirement of `>=22.19.0`");
    expect(review).toContain(
      "separate `wechat-runtime-audit` gate uses Node `22.19.0` and npm `10.9.4`",
    );
    expect(review).toContain("Node `22.19.0` and npm `10.9.4`");
    expect(review).toContain("fails on any low-or-higher production advisory");
    expect(review).toContain("Default PR and main CI now rematerialize");
    expect(review).toContain("`npm audit --omit=dev --json`");
    expect(review).toContain("configured threshold in `ci/reviewed-npm-audit.json` is `high`");
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
      "only reviewed messaging plugin without a package-internal shrinkwrap was the existing non-OpenClaw Tencent WeChat plugin",
    );
    expect(review).toContain("Current NemoClaw builds close that residual");
    expect(review).toContain("copies it into a disposable writable cache");
    expect(review).toContain("Current NemoClaw closes the WeChat residual");
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
    expect(review).toContain("Shared #5896 Archive and Audit Contract");
    expect(review).toContain("`scripts/lib/reviewed-npm-archive.mts`");
    expect(review).toContain("protected exact provenance marker");
    expect(review).toContain("mcporter package, SRI, tarball URL, lockfile SHA-256");
    expect(review).toContain("removes the marker before applying NemoClaw patches");
    expect(review).toContain("fifteen fallback states");
    expect(review).toContain("Issue #5896 section 2");
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

  it("keeps every reviewed archive boundary on the shared invariant matrix (#5896)", () => {
    const result = spawnSync(
      "bash",
      [
        "-lc",
        `
set -euo pipefail

messaging_build_applier=${JSON.stringify(MESSAGING_BUILD_APPLIER)}
reviewed_archive_helper=scripts/lib/reviewed-npm-archive.mts

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

check_not_contains() {
  haystack="$1"
  needle="$2"
  label="$3"
  case "$haystack" in
    *"$needle"*) echo "superseded $label remains: $needle" >&2; exit 1 ;;
    *) ;;
  esac
}

codex_acp_block="$(sed -n '/# Pre-install the codex-acp package/,/# Upgrade OpenClaw if the base image is stale./p' Dockerfile)"
check_contains "$codex_acp_block" "CODEX_ACP_TARBALL='${CODEX_ACP_TARBALL}'" "codex-acp tarball"
check_contains "$codex_acp_block" '/scripts/lib/reviewed-npm-archive.mts' "codex-acp shared helper"
check_contains "$codex_acp_block" '--package-spec "$CODEX_ACP_SPEC" --integrity "$CODEX_ACP_0_11_1_INTEGRITY"' "codex-acp reviewed identity"
check_contains "$codex_acp_block" '--tarball-url "$CODEX_ACP_TARBALL"' "codex-acp reviewed tarball"
check_contains "$codex_acp_block" '"$CODEX_ACP_PACK_PATH"' "codex-acp local install path"
check_contains "$codex_acp_block" 'CODEX_ACP_PACK_DIR="$(dirname "$CODEX_ACP_PACK_PATH")"' "codex-acp pack directory"
check_contains "$codex_acp_block" 'rm -rf "$CODEX_ACP_PACK_DIR"' "codex-acp cleanup"
check_not_contains "$codex_acp_block" 'pack_reviewed_npm_tarball' "codex-acp inline pack helper"

for dockerfile in Dockerfile Dockerfile.base; do
  case "$dockerfile" in
    Dockerfile) end_marker='# Patch OpenClaw media fetch' ;;
    Dockerfile.base) end_marker='# Baseline health check.' ;;
  esac
  openclaw_block="$(sed -n "/ARG OPENCLAW_VERSION=2026.6.10/,/$end_marker/p" "$dockerfile")"
  check_contains "$openclaw_block" "ARG OPENCLAW_2026_6_10_TARBALL=${OPENCLAW_TARBALL}" "$dockerfile tarball arg"
  check_contains "$openclaw_block" '/scripts/lib/reviewed-npm-archive.mts' "$dockerfile shared helper"
  check_contains "$openclaw_block" '--package-spec "openclaw@\${OPENCLAW_VERSION}" --integrity "$EXPECTED_INTEGRITY"' "$dockerfile reviewed identity"
  check_contains "$openclaw_block" '--tarball-url "$EXPECTED_TARBALL"' "$dockerfile reviewed tarball"
  check_contains "$openclaw_block" '"$OPENCLAW_PACK_PATH"' "$dockerfile local install path"
  check_contains "$openclaw_block" 'OPENCLAW_PACK_DIR="$(dirname "$OPENCLAW_PACK_PATH")"' "$dockerfile pack directory"
  if [ "$dockerfile" = Dockerfile.base ]; then
    check_contains "$openclaw_block" '[ ! -f "$OPENCLAW_PACK_PATH" ]' "$dockerfile archive path guard"
  fi
  check_contains "$openclaw_block" 'rm -rf "$OPENCLAW_PACK_DIR"' "$dockerfile cleanup"
  check_not_contains "$openclaw_block" 'REGISTRY_INTEGRITY=$(npm view' "$dockerfile inline integrity lookup"
  check_not_contains "$openclaw_block" 'pack_reviewed_npm_tarball' "$dockerfile inline pack helper"
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

wechat_cache_block="$(sed -n '/# Reviewed-archive invariants (#5896): after npm materializes the exact lock/,/# Pre-install the codex-acp package/p' Dockerfile)"
check_contains "$wechat_cache_block" '/scripts/lib/reviewed-npm-archive.mts' "WeChat cache shared helper"
check_contains "$wechat_cache_block" '--lockfile /usr/local/lib/nemoclaw/wechat-runtime/package-lock.json' "WeChat cache reviewed lock"
check_contains "$wechat_cache_block" '--cache /usr/local/share/nemoclaw/wechat-npm-cache' "WeChat cache boundary"
check_contains "$wechat_cache_block" '--registry-origin https://registry.npmjs.org/' "WeChat reviewed registry"
check_contains "$wechat_cache_block" 'NPM_CONFIG_OFFLINE=true' "WeChat cache offline verification"

optional_plugin_block="$(sed -n '/# Install non-messaging OpenClaw plugins that need to match the runtime./,/^RUN OPENCLAW_VERSION=/p' Dockerfile)"
check_contains "$optional_plugin_block" '/scripts/lib/reviewed-npm-archive.mts' "optional plugin shared helper"
check_contains "$optional_plugin_block" '--package-spec "$plugin_spec" --integrity "$expected_integrity"' "optional plugin reviewed identity"
check_contains "$optional_plugin_block" '--tarball-url "$expected_tarball"' "optional plugin reviewed tarball"
check_contains "$optional_plugin_block" 'openclaw plugins install "npm-pack:\${plugin_archive}"' "optional plugin npm-pack install"
check_contains "$optional_plugin_block" 'rm -rf "$(dirname "$plugin_archive")"' "optional plugin cleanup"
check_not_contains "$optional_plugin_block" 'pack_reviewed_npm_tarball' "optional plugin inline pack helper"

	grep -Fq 'packReviewedNpmArchive({' "$messaging_build_applier"
	grep -Fq '["openclaw", "plugins", "install", \`npm-pack:\${packed.archivePath}\`]' "$messaging_build_applier"
	grep -Fq 'rmSync(packed.rootDir, { recursive: true, force: true })' "$messaging_build_applier"
	grep -Fq 'from "../../../../../scripts/lib/reviewed-npm-archive.mts"' "$messaging_build_applier"
	grep -Fq 'spawnSync(request.npmExecutable ?? "npm", args' "$reviewed_archive_helper"
	grep -Fq '["view", request.packageSpec, "dist.integrity"]' "$reviewed_archive_helper"
	grep -Fq '["view", request.packageSpec, "dist.tarball"]' "$reviewed_archive_helper"
	grep -Fq '["pack", request.tarballUrl, "--pack-destination", rootDirectory, "--json"]' "$reviewed_archive_helper"
	grep -Fq 'reported unsafe archive filename' "$reviewed_archive_helper"
	! grep -Fq 'npmViewString(' "$messaging_build_applier"
	! grep -Fq 'resolveNpmPackArchivePath(' "$messaging_build_applier"
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

	phase_count="$(grep -Ec -- '--phase (runtime-setup|agent-install|post-agent-install)' Dockerfile)"
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
    const workflows = workflowContracts();
    const discoveredBuilds = workflows.flatMap(({ name, workflow }) =>
      findProductionBuildGuardCoverage(name, workflow),
    );

    expect(discoveredBuilds.length).toBeGreaterThan(0);
    expect(discoveredBuilds.filter(({ guarded }) => !guarded)).toEqual([]);

    const productionWorkflowContract = JSON.stringify(workflows);
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

  it("accepts reviewed base-image versions and rejects injected build arguments", () => {
    const baseImages = readYaml<Workflow>(".github/workflows/base-image.yaml");
    const buildAndPush = baseImages.jobs["build-and-push"] as WorkflowJob;
    const guard = requiredStep(buildAndPush, "Validate production Docker build args");

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

    for (const agent of ["hermes", "langchain-deepagents-code"]) {
      const { output, result } = runBaseImageBuildArgGuard(guard, "2026.6.10", agent);
      expect(result.status, `${agent}: ${result.stderr}`).toBe(0);
      expect(output).toBe("openclaw_build_arg=\n");
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

  // source-shape-contract: security -- Network-fetched distribution audits must execute only from trusted main workflow code
  it("runs and gates the real patched-distribution harness only from trusted main code", () => {
    const pr = readYaml<Workflow>(".github/workflows/pr.yaml");
    const main = readYaml<Workflow>(".github/workflows/main.yaml");
    const prJob = pr.jobs["real-openclaw-dist-harness"];
    const mainJob = main.jobs["real-openclaw-dist-harness"];
    const prChecks = pr.jobs.checks;
    const mainChecks = main.jobs.checks;

    expect(pr.permissions).toEqual({ contents: "read" });
    expect(prJob).toBeUndefined();
    expect(requiredStep(mainJob, "Audit the real patched OpenClaw distribution").env).toMatchObject(
      {
        NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS: "1",
      },
    );
    expect(requiredStep(mainJob, "Audit the real patched OpenClaw distribution").run).toContain(
      "test/openclaw-real-patched-dist-harness.test.ts",
    );
    expect(
      requiredStep(mainJob, "Audit managed OpenClaw security finding suppressions").env,
    ).toEqual({ NEMOCLAW_REAL_OPENCLAW_AUDIT_HARNESS: "1" });
    expect(
      requiredStep(mainJob, "Audit managed OpenClaw security finding suppressions").run,
    ).toContain("test/openclaw-security-audit-suppressions-real.test.ts");
    expect(requiredStep(mainJob, "Install test dependencies").run).toBe("npm ci --ignore-scripts");
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
