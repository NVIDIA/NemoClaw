// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob, type WorkflowStep } from "../../helpers/e2e-workflow-contract";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const CODEX_ACP_TARBALL =
  "https://registry.npmjs.org/@zed-industries/codex-acp/-/codex-acp-0.11.1.tgz";
const OPENCLAW_TARBALL = "https://registry.npmjs.org/openclaw/-/openclaw-2026.7.1.tgz";
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
  "patch-openclaw-issue-4434-diagnostics.mts",
);
const DEVICE_SELF_APPROVAL_PATCH = path.join(
  REPO_ROOT,
  "scripts",
  "patch-openclaw-device-self-approval.mts",
);
const SHARED_STATE_PERMISSIONS_PATCH = path.join(
  REPO_ROOT,
  "scripts",
  "patch-openclaw-shared-state-permissions.mts",
);
const MCP_RELIABILITY_PATCH = path.join(REPO_ROOT, "scripts", "patch-openclaw-mcp-reliability.mts");
const MCP_TOOLS_LIST_TIMEOUT_PATCH = path.join(
  REPO_ROOT,
  "scripts",
  "patch-openclaw-mcp-tools-list-timeout.mts",
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
  it("keeps every reviewed archive boundary on the shared invariant matrix (#5896)", () => {
    const result = spawnSync(
      "bash",
      [
        "-lc",
        `
set -euo pipefail

messaging_build_applier=${JSON.stringify(MESSAGING_BUILD_APPLIER)}
reviewed_archive_helper=scripts/lib/reviewed-npm-archive.mts
remediation_helper=scripts/lib/openclaw-npm-remediation.mts

boundary_marker_count="$(grep -hF 'Reviewed-archive invariants (#5896):' Dockerfile Dockerfile.base | wc -l | tr -d ' ')"
test "$boundary_marker_count" -eq 4

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

codex_acp_block="$(sed -n '/AS codex-acp-runtime/,/AS wechat-npm-cache/p' Dockerfile)"
check_contains "$(cat Dockerfile)" '${CODEX_ACP_TARBALL}' "codex-acp tarball"
check_contains "$(cat Dockerfile)" 'sha256:b287fe7bce0dc0b3d0c69400ab7d47567680439628ad22a89f0557cc736d64b8' "codex-acp immutable archive"
check_contains "$codex_acp_block" 'ARG CODEX_ACP_0_11_1_INTEGRITY' "codex-acp reviewed identity"
check_contains "$codex_acp_block" 'ARG CODEX_ACP_LINUX_AMD64_0_11_1_INTEGRITY' "codex-acp amd64 identity"
check_contains "$codex_acp_block" 'ARG CODEX_ACP_LINUX_ARM64_0_11_1_INTEGRITY' "codex-acp arm64 identity"
check_contains "$codex_acp_block" 'RUN --network=none' "codex-acp offline install"
check_contains "$codex_acp_block" 'npm install -g --offline --no-audit --no-fund --no-progress --ignore-scripts' "codex-acp local install path"
check_contains "$codex_acp_block" 'rm -rf /tmp/codex-acp' "codex-acp cleanup"
check_not_contains "$codex_acp_block" 'pack_reviewed_npm_tarball' "codex-acp inline pack helper"

for dockerfile in Dockerfile Dockerfile.base; do
  case "$dockerfile" in
    Dockerfile) end_marker='# Patch OpenClaw media fetch' ;;
    Dockerfile.base) end_marker='# Baseline health check.' ;;
  esac
  openclaw_block="$(sed -n "/ARG OPENCLAW_VERSION=2026.7.1/,/$end_marker/p" "$dockerfile")"
  check_contains "$openclaw_block" "ARG OPENCLAW_2026_7_1_TARBALL=${OPENCLAW_TARBALL}" "$dockerfile tarball arg"
  check_contains "$openclaw_block" '/scripts/lib/reviewed-npm-archive.mts' "$dockerfile shared helper"
  check_contains "$openclaw_block" '--package-spec "openclaw@\${OPENCLAW_VERSION}" --integrity "$EXPECTED_INTEGRITY"' "$dockerfile reviewed identity"
  check_contains "$openclaw_block" '--tarball-url "$EXPECTED_TARBALL"' "$dockerfile reviewed tarball"
  check_contains "$openclaw_block" '"$OPENCLAW_PACK_PATH"' "$dockerfile local install path"
  check_contains "$openclaw_block" 'OPENCLAW_PACK_DIR="$(dirname "$OPENCLAW_PACK_PATH")"' "$dockerfile pack directory"
  if [ "$dockerfile" = Dockerfile.base ]; then
    check_contains "$openclaw_block" '[ ! -f "$OPENCLAW_SOURCE_PACK_PATH" ]' "$dockerfile source archive path guard"
  fi
  check_contains "$openclaw_block" '--archive "$OPENCLAW_SOURCE_PACK_PATH" --package-spec "openclaw@\${OPENCLAW_VERSION}"' "$dockerfile legacy remediated identity"
  check_contains "$openclaw_block" 'if (!value.remediated || typeof value.archivePath !== "string")' "$dockerfile remediation result guard"
  check_contains "$openclaw_block" 'rm -rf "$OPENCLAW_PACK_DIR"' "$dockerfile cleanup"
  check_not_contains "$openclaw_block" 'REGISTRY_INTEGRITY=$(npm view' "$dockerfile inline integrity lookup"
  check_not_contains "$openclaw_block" 'pack_reviewed_npm_tarball' "$dockerfile inline pack helper"
  check_contains "$openclaw_block" 'openclaw-base-provenance-v1' "$dockerfile base provenance path"
  check_contains "$openclaw_block" "OPENCLAW_RECIPE='ignore-scripts+reviewed-lifecycle-v1'" "$dockerfile direct provenance recipe"
  check_contains "$openclaw_block" "OPENCLAW_RECIPE='ignore-scripts+reviewed-lifecycle+transitive-remediation-v1'" "$dockerfile remediated provenance recipe"
  check_contains "$openclaw_block" '"recipe=\${OPENCLAW_RECIPE}"' "$dockerfile selected provenance recipe"
  check_contains "$openclaw_block" 'mcporter-package=mcporter@' "$dockerfile mcporter provenance package"
  check_contains "$openclaw_block" 'mcporter-integrity=' "$dockerfile mcporter provenance integrity"
  check_contains "$openclaw_block" 'mcporter-lock-sha256=' "$dockerfile mcporter provenance lock hash"
  check_contains "$openclaw_block" 'mcporter-audit-policy-sha256=' "$dockerfile mcporter audit policy hash"
  check_contains "$openclaw_block" 'mcporter-audit-status=' "$dockerfile mcporter audit status"
  check_contains "$openclaw_block" 'mcporter-audit-exceptions=' "$dockerfile mcporter audit exceptions"
  check_contains "$openclaw_block" 'mcporter-recipe=locked-ci+reviewed-audit-v3' "$dockerfile mcporter provenance recipe"
done

check_contains "$(cat Dockerfile.base)" 'chmod 0444 "$OPENCLAW_PROVENANCE_TMP"' "base provenance protected mode"
check_contains "$(cat Dockerfile)" "stat -c '%u:%g:%a'" "runtime provenance metadata format"
check_contains "$(cat Dockerfile)" '0:0:444' "runtime provenance exact metadata"
check_contains "$(cat Dockerfile)" 'rm -rf "$OPENCLAW_PROVENANCE_PATH"' "runtime provenance consumption"

wechat_cache_block="$(sed -n '/AS wechat-npm-cache/,/# Group repository-owned files/p' Dockerfile)"
check_contains "$wechat_cache_block" 'reviewed-npm-archive.mts' "WeChat cache shared helper"
check_contains "$wechat_cache_block" 'seed-reviewed-npm-cache.mts' "WeChat cache offline seed"
check_contains "$wechat_cache_block" '--lockfile /opt/wechat-runtime/package-lock.json' "WeChat cache reviewed lock"
check_contains "$wechat_cache_block" '--cache /out/wechat-npm-cache' "WeChat cache boundary"
check_contains "$wechat_cache_block" '--registry-origin https://registry.npmjs.org/' "WeChat reviewed registry"
check_contains "$wechat_cache_block" 'NPM_CONFIG_OFFLINE=true' "WeChat cache offline verification"
check_contains "$wechat_cache_block" 'RUN --network=none' "WeChat cache offline materialization"

optional_plugin_block="$(sed -n '/# Install non-messaging OpenClaw plugins that need to match the runtime./,/^RUN OPENCLAW_VERSION=/p' Dockerfile)"
check_contains "$optional_plugin_block" '/scripts/lib/reviewed-npm-archive.mts' "optional plugin shared helper"
check_contains "$optional_plugin_block" '--package-spec "$plugin_spec" --integrity "$expected_integrity"' "optional plugin reviewed identity"
check_contains "$optional_plugin_block" '--tarball-url "$expected_tarball"' "optional plugin reviewed tarball"
check_contains "$optional_plugin_block" '/scripts/lib/openclaw-npm-remediation.mts' "optional plugin remediation helper"
check_contains "$optional_plugin_block" '"@openclaw/diagnostics-otel@2026.7.1")' "diagnostics remediation identity"
check_contains "$optional_plugin_block" '--working-directory "$plugin_work_root"' "diagnostics remediation workspace"
check_contains "$optional_plugin_block" 'if (!value.remediated || typeof value.archivePath !== "string")' "diagnostics remediation result guard"
check_contains "$optional_plugin_block" 'plugin_source_root="$(dirname "$plugin_archive")"' "optional plugin source root"
check_contains "$optional_plugin_block" 'plugin_work_root="$(mktemp -d /tmp/nemoclaw-openclaw-plugin.XXXXXX)"' "optional plugin writable workspace"
check_contains "$optional_plugin_block" 'plugin_install_archive="$plugin_archive"' "optional plugin default archive"
check_contains "$optional_plugin_block" 'openclaw plugins install "npm-pack:\${plugin_install_archive}"' "optional plugin npm-pack install"
check_contains "$optional_plugin_block" 'rm -rf "$plugin_work_root"' "optional plugin workspace cleanup"
check_contains "$optional_plugin_block" 'if [ -z "\${NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR:-}" ]; then rm -rf "$plugin_source_root"; fi' "optional plugin fallback source cleanup"
check_not_contains "$optional_plugin_block" 'pack_reviewed_npm_tarball' "optional plugin inline pack helper"

	grep -Fq 'packReviewedNpmArchive({' "$messaging_build_applier"
	grep -Fq '["openclaw", "plugins", "install", \`npm-pack:\${packed.archivePath}\`]' "$messaging_build_applier"
	grep -Fq 'rmSync(packed.rootDir, { recursive: true, force: true })' "$messaging_build_applier"
	grep -Fq 'from "../../../../../scripts/lib/reviewed-npm-archive.mts"' "$messaging_build_applier"
	grep -Fq 'from "../../../../../scripts/lib/openclaw-npm-remediation.mts"' "$messaging_build_applier"
	grep -Fq 'remediateReviewedOpenClawPluginArchive({' "$messaging_build_applier"
	grep -Fq 'spawnSync(request.npmExecutable ?? "npm", args' "$reviewed_archive_helper"
	grep -Fq '["view", request.packageSpec, "dist.integrity"]' "$reviewed_archive_helper"
	grep -Fq '["view", request.packageSpec, "dist.tarball"]' "$reviewed_archive_helper"
	grep -Fq '["pack", request.tarballUrl, "--pack-destination", rootDirectory, "--json"]' "$reviewed_archive_helper"
	grep -Fq 'reported unsafe archive filename' "$reviewed_archive_helper"
	grep -Fq 'expectedPatchedTreeIntegrity' "$remediation_helper"
	grep -Fq 'expectedPatchedMetadataIntegrity' "$remediation_helper"
	grep -Fq 'hashPackageTree' "$remediation_helper"
	grep -Fq 'patchOpenClawCorePackageGraph' "$remediation_helper"
	grep -Fq 'patchOpenClawDiagnosticsPackageGraph' "$remediation_helper"
	for package_spec in \
		'openclaw@2026.3.11' \
		'openclaw@2026.6.10' \
		'@openclaw/diagnostics-otel@2026.6.10' \
		'@openclaw/slack@2026.6.10' \
		'@openclaw/msteams@2026.6.10' \
		'@openclaw/diagnostics-otel@2026.7.1' \
		'@openclaw/slack@2026.7.1' \
		'@openclaw/msteams@2026.7.1'; do
		grep -Fq "$package_spec" "$remediation_helper"
	done
	grep -Fq 'validateArchiveMembers(archivePath' "$remediation_helper"
	remediation_cli_block="$(sed -n '/if (isMainModule())/,$p' "$remediation_helper")"
	check_contains "$remediation_cli_block" 'remediateReviewedOpenClawPluginArchive({' "remediation CLI tree-integrity enforcement"
	check_not_contains "$remediation_cli_block" 'buildRemediatedOpenClawPluginArchive({' "unenforced remediation CLI path"
	! grep -Fq 'npmViewString(' "$messaging_build_applier"
	! grep -Fq 'resolveNpmPackArchivePath(' "$messaging_build_applier"
	issue_4434_patch=${JSON.stringify(ISSUE_4434_PATCH)}
	grep -Fq 'formatRawAssistantErrorForUi' "$issue_4434_patch"
	grep -Fq 'OPENSHELL_SANDBOX !== "1"' "$issue_4434_patch"
		grep -Fq 'nemoclaw: #4434 structured unreachable-inference diagnostic' "$issue_4434_patch"
		grep -Fq 'COPY scripts/patch-openclaw-issue-4434-diagnostics.mts /usr/local/lib/nemoclaw/patch-openclaw-issue-4434-diagnostics.mts' Dockerfile
		grep -Fq 'node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-issue-4434-diagnostics.mts \\' Dockerfile
		grep -Fq 'COPY scripts/patch-openclaw-tool-catalog.mts /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts' Dockerfile
		grep -Fq 'node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts \\' Dockerfile
		! grep -Fq 'patch-openclaw-tool-catalog.js' Dockerfile
		device_self_approval_patch=${JSON.stringify(DEVICE_SELF_APPROVAL_PATCH)}
		grep -Fq 'nemoclaw: reach gateway for bounded same-device scope approval' "$device_self_approval_patch"
		grep -Fq 'nemoclaw: bounded same-device scope approval' "$device_self_approval_patch"
		grep -Fq 'nemoclaw: validate bounded self-approval inside pairing lock' "$device_self_approval_patch"
		grep -Fq 'COPY scripts/patch-openclaw-device-self-approval.mts /usr/local/lib/nemoclaw/patch-openclaw-device-self-approval.mts' Dockerfile
		grep -Fq 'node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-device-self-approval.mts \\' Dockerfile
	shared_state_permissions_patch=${JSON.stringify(SHARED_STATE_PERMISSIONS_PATCH)}
	grep -Fq 'nemoclaw: group-shared OpenClaw state' "$shared_state_permissions_patch"
	grep -Fq 'nemoclaw: group-shared OpenClaw agent state' "$shared_state_permissions_patch"
	grep -Fq 'keep generic credential and identity stores owner-only' "$shared_state_permissions_patch"
	! grep -Fq 'nemoclaw: group-shared OpenClaw private store' "$shared_state_permissions_patch"
	! grep -Fq 'nemoclaw: group-shared OpenClaw file-store defaults' "$shared_state_permissions_patch"
	grep -Fq 'nemoclaw: group-shared OpenClaw models file' "$shared_state_permissions_patch"
	grep -Fq 'nemoclaw: ignore legacy OpenClaw update-check state' "$shared_state_permissions_patch"
	grep -Fq 'COPY scripts/patch-openclaw-shared-state-permissions.mts /usr/local/lib/nemoclaw/patch-openclaw-shared-state-permissions.mts' Dockerfile
	grep -Fq 'node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-shared-state-permissions.mts \\' Dockerfile
	mcp_reliability_patch=${JSON.stringify(MCP_RELIABILITY_PATCH)}
	grep -Fq 'nemoclaw mcp transient startup recovery (#7958)' "$mcp_reliability_patch"
	grep -Fq 'nemoClawIsTransientMcpStartFailure' "$mcp_reliability_patch"
	grep -Fq 'nemoClawCatalogHasStartDiagnostics' "$mcp_reliability_patch"
	grep -Fq 'COPY scripts/patch-openclaw-mcp-reliability.mts /usr/local/lib/nemoclaw/patch-openclaw-mcp-reliability.mts' Dockerfile
	grep -Fq 'node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-mcp-reliability.mts \\' Dockerfile
	! grep -Fq 'patch-openclaw-mcp-reliability.js' Dockerfile
	mcp_tools_list_timeout_patch=${JSON.stringify(MCP_TOOLS_LIST_TIMEOUT_PATCH)}
	grep -Fq 'NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS' "$mcp_tools_list_timeout_patch"
	grep -Fq 'TOOLS_LIST_TIMEOUT_MIN_MS = 1500' "$mcp_tools_list_timeout_patch"
	grep -Fq 'TOOLS_LIST_TIMEOUT_MAX_MS = 10_000' "$mcp_tools_list_timeout_patch"
	grep -Fq 'COPY scripts/patch-openclaw-mcp-tools-list-timeout.mts /usr/local/lib/nemoclaw/patch-openclaw-mcp-tools-list-timeout.mts' Dockerfile
	grep -Fq 'node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-mcp-tools-list-timeout.mts \\' Dockerfile
	! grep -Fq 'patch-openclaw-mcp-tools-list-timeout.js' Dockerfile

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

    expect(result.stderr).toBe("");
    expect(result.status, result.stdout).toBe(0);
  });

  it("keeps the rebuild-resume compatibility shim tied to its removal tracker", () => {
    const source = readFileSync(REBUILD_RESUME_SESSION, "utf-8");

    expect(source).toContain("Invalid legacy shape");
    expect(source).toContain("Removal condition");
    expect(source).toContain("#4533");
  });

  it.each([
    "NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1",
    "OPENCLAW_VERSION=2026.3.11",
    "OPENCLAW_VERSION=2026.4.24",
    "OPENCLAW_2026_3_11_INTEGRITY",
    "OPENCLAW_2026_3_11_TARBALL",
    "OPENCLAW_2026_4_24_INTEGRITY",
    "OPENCLAW_2026_4_24_TARBALL",
  ])(
    "keeps production Docker build workflows behind the build-arg guard [%s]",
    (fixtureSelector) => {
      const workflows = workflowContracts();
      const discoveredBuilds = workflows.flatMap(({ name, workflow }) =>
        findProductionBuildGuardCoverage(name, workflow),
      );

      expect(discoveredBuilds.length).toBeGreaterThan(0);
      expect(discoveredBuilds.filter(({ guarded }) => !guarded)).toEqual([]);

      const productionWorkflowContract = JSON.stringify(workflows);

      expect(productionWorkflowContract).not.toContain(fixtureSelector);
    },
  );

  it("accepts reviewed base-image versions and rejects injected build arguments", () => {
    const action = readYaml<{ runs: { steps: WorkflowStep[] } }>(
      ".github/actions/build-base-image-platform/action.yaml",
    );
    const guard = requiredStep(
      { steps: action.runs.steps },
      "Validate production Docker build args",
    );

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
});
