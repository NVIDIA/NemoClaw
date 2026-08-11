// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INSTALLER_PAYLOAD,
  TEST_SYSTEM_PATH,
  writeExecutable,
} from "../helpers/installer-sourced-env";

function writeNodeStub(fakeBin: string) {
  writeExecutable(
    path.join(fakeBin, "node"),
    `#!/usr/bin/env bash
if [ "$1" = "--version" ] || [ "$1" = "-v" ]; then echo "v22.19.0"; exit 0; fi
if [ -n "\${1:-}" ] && [ -f "$1" ]; then
  exec ${JSON.stringify(process.execPath)} "$@"
fi
if [ "$1" = "-e" ]; then
  exec ${JSON.stringify(process.execPath)} "$@"
fi
exit 99`,
  );
}

function runInstallerHostAdmissionTest(
  host: {
    runtime: string;
    hasNestedOverlayConflict?: boolean;
    isUnsupportedRuntime?: boolean;
  },
  forcedRejection?: { findingIds: string[]; capabilityIds: string[] },
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-host-admission-"));
  const fakeBin = path.join(tmp, "bin");
  const sourceRoot = path.join(tmp, "source");
  const onboardDir = path.join(sourceRoot, "dist", "lib", "onboard");
  const readinessDir = path.join(sourceRoot, "dist", "lib", "readiness");
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(onboardDir, { recursive: true });
  fs.mkdirSync(readinessDir, { recursive: true });

  fs.writeFileSync(
    path.join(onboardDir, "preflight.js"),
    `const host = ${JSON.stringify({
      isWsl: false,
      cdiNvidiaGpuSpecMissing: false,
      cdiNvidiaGpuSpecStale: false,
      cdiNvidiaGpuSpecNeedsRepair: false,
      ...host,
    })};
exports.assessHost = () => host;
exports.planHostAdvisories = () => [];
`,
  );
  fs.writeFileSync(
    path.join(readinessDir, "host.js"),
    `exports.createHostReadinessReport = (_options, collection) => {
  const host = collection.assess();
  const findings = [];
  if (host.hasNestedOverlayConflict) {
    findings.push({
      id: "host.docker.storage_incompatible",
      severity: "blocking",
      summary: "The Docker storage configuration cannot support nested overlay mounts.",
    });
  }
  if (host.isUnsupportedRuntime) {
    findings.push({
      id: "host.docker.runtime_unsupported",
      severity: "blocking",
      summary: "The detected container runtime is unsupported.",
    });
  }
  return { findings, host };
};
`,
  );
  fs.writeFileSync(
    path.join(readinessDir, "onboard-admission.js"),
    `const forcedRejection = ${JSON.stringify(forcedRejection ?? null)};
exports.evaluateOnboardReadinessAdmission = (report, options) => {
  if (forcedRejection) {
    return { admitted: false, reasonIds: [], ...forcedRejection, waivedFindingIds: [] };
  }
  const findingIds = report.findings
    .filter((finding) =>
      finding.id !== "host.docker.storage_incompatible" || !options.allowStorageRemediation
    )
    .map((finding) => finding.id);
  return findingIds.length === 0
    ? { admitted: true, waivedFindingIds: ["host.docker.storage_incompatible"] }
    : { admitted: false, reasonIds: [], findingIds, capabilityIds: [], waivedFindingIds: [] };
};
`,
  );
  fs.writeFileSync(
    path.join(onboardDir, "gateway-management.js"),
    `exports.loadGatewayManagementDeclaration = () => ({ ok: true, declaration: null });\n`,
  );
  writeNodeStub(fakeBin);

  const result = spawnSync(
    "bash",
    [
      "-c",
      `
source "$INSTALLER_UNDER_TEST" >/dev/null
NEMOCLAW_SOURCE_ROOT="$SOURCE_ROOT"
run_installer_host_preflight
`,
    ],
    {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        SOURCE_ROOT: sourceRoot,
      },
    },
  );

  return { output: `${result.stdout}${result.stderr}`, result };
}

describe("installer host preflight package contract", () => {
  it("continues to onboarding when managed storage remediation is available", () => {
    const { output, result } = runInstallerHostAdmissionTest({
      runtime: "docker",
      hasNestedOverlayConflict: true,
    });

    expect(result.status, output).toBe(0);
    expect(output).not.toMatch(/Host preflight found issues/);
  });

  it("prints the blocking readiness finding when no advisory action exists", () => {
    const { output, result } = runInstallerHostAdmissionTest({
      runtime: "podman",
      isUnsupportedRuntime: true,
    });

    expect(result.status).toBe(1);
    expect(output).toMatch(/Host preflight found issues/);
    expect(output).toMatch(/The detected container runtime is unsupported\./);
  });

  it("prints only stable unknown finding and required-capability diagnostics", () => {
    const oversizedFindingId = `host.${"f".repeat(124)}`;
    const oversizedCapabilityId = `host.${"c".repeat(124)}`;
    const { output, result } = runInstallerHostAdmissionTest(
      { runtime: "docker" },
      {
        findingIds: [
          "host.test.unknown",
          "host.test.unknown",
          "unsafe\ninjected-finding",
          oversizedFindingId,
          "invalidfinding",
        ],
        capabilityIds: [
          "host.test.required-capability",
          "host.test.required-capability",
          "unsafe\ninjected-capability",
          oversizedCapabilityId,
          "INVALID.CAPABILITY",
        ],
      },
    );

    expect(result.status).toBe(1);
    expect(output).toMatch(/Admission finding IDs: host\.test\.unknown/);
    expect(output).toMatch(/Readiness finding: host\.test\.unknown/);
    expect(output).toMatch(/Admission capability IDs: host\.test\.required-capability/);
    expect(output).toMatch(
      /NemoClaw could not confirm the required readiness capability host\.test\.required-capability\./,
    );
    expect(output.match(/host\.test\.unknown/g)).toHaveLength(2);
    expect(output.match(/host\.test\.required-capability/g)).toHaveLength(2);
    expect(output).not.toContain("injected-finding");
    expect(output).not.toContain("injected-capability");
    expect(output).not.toContain(oversizedFindingId);
    expect(output).not.toContain(oversizedCapabilityId);
    expect(output).not.toContain("invalidfinding");
    expect(output).not.toContain("INVALID.CAPABILITY");
  });
});
