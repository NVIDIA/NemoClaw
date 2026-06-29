// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";

// Migrated from test/e2e/test-openclaw-plugin-runtime-exdev.sh. This keeps the
// legacy contract as a simple live Vitest test: onboard a fresh OpenClaw sandbox
// from the repo Dockerfile, capture the sandbox filesystem layout, then run a
// focused in-sandbox Node replacement probe that guards #3513/#3127's EXDEV
// cross-device runtime-deps failure mode. No registry, no ledger, no shared helper.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-openclaw-plugin-exdev";
const ONBOARD_TIMEOUT_MS = 25 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;
validateSandboxName(SANDBOX_NAME);

const EXDEV_PATTERNS = [
  /EXDEV: cross-device link not permitted/i,
  /cross-device link not permitted/i,
];
const liveTest = shouldRunLiveE2EScenarios() ? test : test.skip;

function resultText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function liveEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
  };
}

async function ignoreCleanupError(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Best-effort: local machines may not have a completed install or an
    // OpenShell gateway yet, and cleanup should not mask the real assertion.
  }
}

function patchPoliciesForDevShm(): () => void {
  // Test-only source-boundary patch: the default OpenClaw policies intentionally
  // do not grant general /dev access, but this regression needs to create a
  // source tree on tmpfs (/dev/shm) to reproduce #3127's cross-device rename
  // layout. Keep the mutation local, restore it after the test, and remove it
  // when OpenShell can mount a dedicated test tmpfs or update live policy before
  // first sandbox command without broadening the checked-in production policy.
  const originals = new Map<string, string>();
  for (const policyPath of [
    path.join(REPO_ROOT, "agents", "openclaw", "policy-permissive.yaml"),
    path.join(REPO_ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
    path.join(REPO_ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox-permissive.yaml"),
  ]) {
    const text = fs.readFileSync(policyPath, "utf8");
    const anchor = "  read_write:\n    - /tmp\n";
    expect(text, `could not find read_write /tmp anchor in ${policyPath}`).toContain(anchor);
    let additions = "";
    for (const entry of ["/dev", "/dev/shm"]) {
      if (!text.includes(`    - ${entry}\n`)) additions += `    - ${entry}\n`;
    }
    if (additions) {
      originals.set(policyPath, text);
      fs.writeFileSync(policyPath, text.replace(anchor, anchor + additions), "utf8");
    }
  }
  return () => {
    for (const [policyPath, text] of originals) {
      fs.writeFileSync(policyPath, text, "utf8");
    }
  };
}

const runtimeDepsReplacementProbeSource = `set -eu
rm -rf /sandbox/.openclaw/plugin-runtime-deps/exdev-guard 2>/dev/null || true
rm -rf /dev/shm/nemoclaw-exdev-source 2>/dev/null || true
mkdir -p /dev/shm/nemoclaw-exdev-source /sandbox/.openclaw/plugin-runtime-deps/exdev-guard
printf 'ok\n' >/dev/shm/nemoclaw-exdev-source/package.txt
source_device=$(stat -c '%d' /dev/shm/nemoclaw-exdev-source)
target_device=$(stat -c '%d' /sandbox/.openclaw/plugin-runtime-deps/exdev-guard)
printf 'source_device=%s target_device=%s\n' "$source_device" "$target_device"
if [ "$source_device" = "$target_device" ]; then
  printf 'EXDEV guard did not get distinct filesystems for /dev/shm and /sandbox plugin-runtime-deps\n' >&2
  exit 2
fi
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
function assertLegacySourceSideStagingFailsWithExdev(targetDir, sourceDir) {
  const sourceParentDir = path.dirname(sourceDir);
  const tempDir = fs.mkdtempSync(path.join(sourceParentDir, '.openclaw-runtime-deps-source-side-'));
  const stagedDir = path.join(tempDir, 'node_modules');
  try {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(sourceDir, stagedDir, { recursive: true });
    const sourceDevice = fs.statSync(sourceDir).dev;
    const stagedDevice = fs.statSync(stagedDir).dev;
    const targetParentDevice = fs.statSync(path.dirname(targetDir)).dev;
    if (stagedDevice !== sourceDevice || stagedDevice === targetParentDevice) {
      throw new Error(
        'legacy self-check lost cross-device layout: source=' +
          sourceDevice +
          ' staged=' +
          stagedDevice +
          ' target_parent=' +
          targetParentDevice,
      );
    }
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(stagedDir, targetDir);
      throw new Error('legacy source-side staging unexpectedly renamed across devices');
    } catch (error) {
      if (error && error.code === 'EXDEV') {
        console.log('legacy source-side staging failure self-check completed');
        return;
      }
      throw error;
    }
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.dirname(targetDir), { recursive: true, force: true }); } catch {}
  }
}
function replaceNodeModulesDir(targetDir, sourceDir) {
  const targetParentDir = path.dirname(targetDir);
  fs.mkdirSync(targetParentDir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(targetParentDir, '.openclaw-runtime-deps-copy-'));
  const stagedDir = path.join(tempDir, 'node_modules');
  try {
    fs.cpSync(sourceDir, stagedDir, { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagedDir, targetDir);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}
assertLegacySourceSideStagingFailsWithExdev(
  '/sandbox/.openclaw/plugin-runtime-deps/exdev-guard/source-side-regression/node_modules',
  '/dev/shm/nemoclaw-exdev-source',
);
replaceNodeModulesDir('/sandbox/.openclaw/plugin-runtime-deps/exdev-guard/node_modules', '/dev/shm/nemoclaw-exdev-source');
console.log('runtime deps replacement completed');
NODE`;

const runtimeDepsReplacementProbe = trustedSandboxShellScript(
  `printf '%s' '${Buffer.from(runtimeDepsReplacementProbeSource).toString("base64")}' | base64 -d > /tmp/nemoclaw-exdev-guard.sh && sh /tmp/nemoclaw-exdev-guard.sh`,
);

liveTest(
  "OpenClaw plugin runtime deps replacement survives cross-filesystem EXDEV layout",
  { timeout: ONBOARD_TIMEOUT_MS + PROBE_TIMEOUT_MS + 5 * 60_000 },
  async ({ artifacts, cleanup, host, sandbox, skip }) => {
    await artifacts.writeJson("scenario.json", {
      id: "openclaw-plugin-runtime-exdev",
      runner: "vitest",
      boundary: "fresh-openclaw-sandbox-exec",
      legacySource: "test/e2e/test-openclaw-plugin-runtime-exdev.sh",
      regressionTargets: ["#3513", "#3127"],
      contract: [
        "fresh OpenClaw sandbox onboards from the checkout Dockerfile",
        "sandbox proves /dev/shm and plugin-runtime-deps are distinct devices",
        "legacy source-side staging fails with EXDEV across the same /dev/shm to plugin-runtime-deps boundary",
        "OpenClaw-style target-side plugin runtime-deps replacement completes without EXDEV",
      ],
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info-openclaw-plugin-exdev",
      env: liveEnv(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for the OpenClaw plugin EXDEV live guard: ${resultText(docker)}`,
        );
      }
      skip("Docker is required for the OpenClaw plugin EXDEV live guard");
    }

    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      "bin/nemoclaw.js missing — run npm run build:cli before this live scenario",
    ).toBe(true);

    cleanup.add(`destroy sandbox ${SANDBOX_NAME}`, async () => {
      const cleanupEnv = liveEnv();
      await ignoreCleanupError(() =>
        host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: "cleanup-nemoclaw-destroy-openclaw-plugin-exdev",
          env: cleanupEnv,
          timeoutMs: 120_000,
        }),
      );
      await ignoreCleanupError(() =>
        sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-openshell-delete-openclaw-plugin-exdev",
          env: cleanupEnv,
          timeoutMs: 60_000,
        }),
      );
    });

    await ignoreCleanupError(() =>
      host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "pre-cleanup-nemoclaw-destroy-openclaw-plugin-exdev",
        env: liveEnv(),
        timeoutMs: 120_000,
      }),
    );
    await ignoreCleanupError(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-openshell-delete-openclaw-plugin-exdev",
        env: liveEnv(),
        timeoutMs: 60_000,
      }),
    );

    const restorePolicies = patchPoliciesForDevShm();
    cleanup.add("restore EXDEV policy fixture edits", restorePolicies);

    const onboard = await host.command(
      "node",
      [
        CLI_ENTRYPOINT,
        "onboard",
        "--fresh",
        "--non-interactive",
        "--yes-i-accept-third-party-software",
        "--agent",
        "openclaw",
        "--from",
        path.join(REPO_ROOT, "Dockerfile"),
      ],
      {
        artifactName: "openclaw-plugin-exdev-onboard",
        env: liveEnv({
          COMPATIBLE_API_KEY: "nemoclaw-exdev-dummy-key",
          NEMOCLAW_ENDPOINT_URL: "http://host.openshell.internal:65535/v1",
          NEMOCLAW_MODEL: "nemoclaw-exdev-probe",
          NEMOCLAW_PROVIDER_KEY: "nemoclaw-exdev-dummy-key",
          NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
          NEMOCLAW_POLICY_MODE: "skip",
          NEMOCLAW_PREFERRED_API: "openai-completions",
          NEMOCLAW_PROVIDER: "custom",
        }),
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    const onboardText = resultText(onboard);
    expect(onboard.exitCode, onboardText).toBe(0);
    expect(onboardText).toMatch(/Creating sandbox|Sandbox '.+' created/);

    const df = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        "df -PT / /tmp /dev/shm /sandbox /sandbox/.openclaw/plugin-runtime-deps",
      ),
      {
        artifactName: "openclaw-plugin-exdev-filesystem-layout",
        env: liveEnv(),
        timeoutMs: 30_000,
      },
    );
    await artifacts.writeText("filesystem-layout.txt", resultText(df));
    expect(df.exitCode, resultText(df)).toBe(0);
    expect(resultText(df)).toContain("/dev/shm");

    const probe = await sandbox.execShell(SANDBOX_NAME, runtimeDepsReplacementProbe, {
      artifactName: "openclaw-plugin-exdev-runtime-deps-replacement",
      env: liveEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const probeText = resultText(probe);
    expect(
      EXDEV_PATTERNS.some((pattern) => pattern.test(probeText)),
      probeText,
    ).toBe(false);
    expect(probe.exitCode, probeText).toBe(0);
    expect(probeText).toMatch(/source_device=\d+ target_device=\d+/);
    expect(probeText).toContain("legacy source-side staging failure self-check completed");
    expect(probeText).toContain("runtime deps replacement completed");

    await artifacts.writeJson("scenario-result.json", {
      id: "openclaw-plugin-runtime-exdev",
      onboardExitCode: onboard.exitCode,
      filesystemProbeExitCode: df.exitCode,
      runtimeDepsProbeExitCode: probe.exitCode,
      assertions: {
        distinctDevices: /source_device=\d+ target_device=\d+/.test(probeText),
        legacySourceSideExdevSelfCheck: probeText.includes(
          "legacy source-side staging failure self-check completed",
        ),
        noExdevSignature: !EXDEV_PATTERNS.some((pattern) => pattern.test(probeText)),
        successMarker: probeText.includes("runtime deps replacement completed"),
      },
    });
  },
);
