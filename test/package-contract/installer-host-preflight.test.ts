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
    additionalFindingIds?: string[];
    unknownCapabilityIds?: string[];
  },
  forcedRejection?: { findingIds: string[]; capabilityIds: string[] },
  options: {
    experimentalProfile?: string;
    gatewayRuntime?: string;
    gatewayManagementMode?: string;
    portableProfileArtifact?: "present" | "missing";
    providerResolutionFailure?: string;
  } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-host-admission-"));
  const fakeBin = path.join(tmp, "bin");
  const sourceRoot = path.join(tmp, "source");
  const onboardDir = path.join(sourceRoot, "dist", "lib", "onboard");
  const experimentalDir = path.join(onboardDir, "experimental");
  const readinessDir = path.join(sourceRoot, "dist", "lib", "readiness");
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(onboardDir, { recursive: true });
  fs.mkdirSync(experimentalDir, { recursive: true });
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
exports.planHostAdvisories = (_host, options = {}) =>
  !options.providerOwnsHostReadiness &&
  host.additionalFindingIds?.includes("host.docker.unavailable")
    ? [{
        id: "install_docker",
        title: "Install Docker",
        reason: "Docker is required before onboarding can create a gateway or sandbox.",
        commands: ["Install Docker Engine, then rerun \`nemoclaw onboard\`."],
      }]
    : [];
`,
  );
  fs.writeFileSync(
    path.join(onboardDir, "gateway-management.js"),
    `const mode = process.env.TEST_GATEWAY_MANAGEMENT_MODE;
exports.loadGatewayManagementDeclaration = () => ({
  ok: true,
  declaration: mode ? { mode } : null,
});
`,
  );
  const portableProfileArtifacts =
    options.portableProfileArtifact === "missing"
      ? []
      : [
          [
            path.join(experimentalDir, "portable-profile.js"),
            `exports.isPortableExperimentalProfile = (env = process.env) => env.NEMOCLAW_EXPERIMENTAL_PROFILE === "portable";\n`,
          ] as const,
        ];
  for (const [artifactPath, contents] of portableProfileArtifacts) {
    fs.writeFileSync(artifactPath, contents);
  }
  fs.writeFileSync(
    path.join(onboardDir, "docker-driver-gateway-env.js"),
    `const resolutionFailure = ${JSON.stringify(options.providerResolutionFailure ?? null)};
exports.configuredRuntimeProviderOwnsHostReadiness = ({ environment = process.env } = {}) => {
  if (resolutionFailure) throw new Error(resolutionFailure);
  return environment.NEMOCLAW_EXPERIMENTAL_PROFILE !== "portable" &&
    environment.NEMOCLAW_GATEWAY_RUNTIME === "podman";
};\n`,
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
  for (const id of host.additionalFindingIds || []) {
    findings.push({ id, severity: "blocking", summary: "Blocking finding: " + id });
  }
  return { findings, capabilityIds: host.unknownCapabilityIds || [], host };
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
  const providerOwnedDockerFindings = new Set([
    "host.docker.unavailable",
    "host.docker.host_invalid",
    "host.docker.daemon_unreachable",
    "host.docker.runtime_unsupported",
    "host.docker.storage_incompatible",
  ]);
  const providerOwnedDockerCapabilities = new Set([
    "host.docker.available",
    "host.docker.daemon_reachable",
    "host.docker.runtime_supported",
    "host.docker.storage_compatible",
    "host.docker.storage_remediation_available",
  ]);
  const findingIds = report.findings
    .filter((finding) => {
      if (
        options.providerOwnsHostReadiness &&
        providerOwnedDockerFindings.has(finding.id)
      ) return false;
      if (
        finding.id === "host.docker.runtime_unsupported" &&
        options.allowUnsupportedRuntime
      ) return false;
      if (
        finding.id === "host.docker.storage_incompatible" &&
        options.allowStorageRemediation
      ) return false;
      if (
        options.allowPortableHostPreparation &&
        (finding.id === "host.docker.daemon_unreachable" ||
          finding.id === "host.docker.storage_incompatible")
      ) return false;
      return true;
    })
    .map((finding) => finding.id);
  const capabilityIds = report.capabilityIds.filter(
    (id) =>
      !(options.providerOwnsHostReadiness && providerOwnedDockerCapabilities.has(id)) &&
      (!options.allowPortableHostPreparation ||
        (id !== "host.docker.daemon_reachable" &&
          id !== "host.docker.runtime_supported" &&
          id !== "host.docker.storage_compatible"))
  );
  return findingIds.length === 0 && capabilityIds.length === 0
    ? { admitted: true, waivedFindingIds: [] }
    : { admitted: false, reasonIds: [], findingIds, capabilityIds, waivedFindingIds: [] };
};
`,
  );
  writeNodeStub(fakeBin);

  const {
    NEMOCLAW_EXPERIMENTAL_PROFILE: _experimentalProfile,
    NEMOCLAW_GATEWAY_RUNTIME: _gatewayRuntime,
    TEST_GATEWAY_MANAGEMENT_MODE: _gatewayManagementMode,
    ...inheritedEnv
  } = process.env;
  const childEnv: NodeJS.ProcessEnv = {
    ...inheritedEnv,
    HOME: tmp,
    INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
    PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
    SOURCE_ROOT: sourceRoot,
    ...(options.experimentalProfile
      ? { NEMOCLAW_EXPERIMENTAL_PROFILE: options.experimentalProfile }
      : {}),
    ...(options.gatewayRuntime ? { NEMOCLAW_GATEWAY_RUNTIME: options.gatewayRuntime } : {}),
    TEST_GATEWAY_MANAGEMENT_MODE: options.gatewayManagementMode ?? "",
  };

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
      env: childEnv,
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

  it("admits an unsupported runtime for the explicit portable profile (#9007)", () => {
    const { output, result } = runInstallerHostAdmissionTest(
      {
        runtime: "podman",
        isUnsupportedRuntime: true,
      },
      undefined,
      { experimentalProfile: "portable" },
    );

    expect(result.status, output).toBe(0);
    expect(output).not.toMatch(/Host preflight found issues/);
  });

  it("rejects the same unsupported runtime without the portable profile (#9007)", () => {
    const { output, result } = runInstallerHostAdmissionTest({
      runtime: "podman",
      isUnsupportedRuntime: true,
    });

    expect(result.status).toBe(1);
    expect(output).toMatch(/Host preflight found issues/);
    expect(output).toMatch(/The detected container runtime is unsupported\./);
  });

  it("admits the unsupported host classifier through the selected managed runtime provider", () => {
    const { output, result } = runInstallerHostAdmissionTest(
      {
        runtime: "podman",
        isUnsupportedRuntime: true,
      },
      undefined,
      { gatewayRuntime: "podman" },
    );

    expect(result.status, output).toBe(0);
    expect(output).not.toMatch(/Host preflight found issues/);
  });

  it("admits a Docker-less host through the selected managed runtime provider (#10891)", () => {
    const dockerCapabilityIds = [
      "host.docker.available",
      "host.docker.daemon_reachable",
      "host.docker.runtime_supported",
      "host.docker.storage_compatible",
      "host.docker.storage_remediation_available",
    ];
    const host = {
      runtime: "unknown",
      additionalFindingIds: ["host.docker.unavailable"],
      unknownCapabilityIds: dockerCapabilityIds,
    };

    const admitted = runInstallerHostAdmissionTest(host, undefined, {
      gatewayRuntime: "podman",
    });
    expect(admitted.result.status, admitted.output).toBe(0);
    expect(admitted.output).not.toMatch(/Host preflight found issues/);
    expect(admitted.output).not.toContain("Install Docker");

    const rejected = runInstallerHostAdmissionTest(host);
    expect(rejected.result.status).toBe(1);
    expect(rejected.output).toContain("host.docker.unavailable");
    expect(rejected.output).toContain("Install Docker");
  });

  it("fails closed when selected provider resolution throws", () => {
    const { output, result } = runInstallerHostAdmissionTest(
      { runtime: "podman", isUnsupportedRuntime: true },
      undefined,
      {
        gatewayRuntime: "podman",
        providerResolutionFailure: "native Podman provider resolution failed",
      },
    );

    expect(result.status).toBe(1);
    expect(output).toContain("native Podman provider resolution failed");
  });

  it("keeps an unsupported runtime blocked without the portable classifier artifact (#9007)", () => {
    const { output, result } = runInstallerHostAdmissionTest(
      {
        runtime: "podman",
        isUnsupportedRuntime: true,
      },
      undefined,
      { experimentalProfile: "portable", portableProfileArtifact: "missing" },
    );

    expect(result.status).toBe(1);
    expect(output).toMatch(/Host preflight found issues/);
    expect(output).toMatch(/The detected container runtime is unsupported\./);
  });

  it.each([
    ["daemon reachability", "host.docker.daemon_unreachable", undefined],
    ["storage compatibility", "host.docker.storage_incompatible", "externally-supervised"],
    ["GPU prerequisites", "host.gpu.container_toolkit_missing", undefined],
    ["platform qualification", "host.platform.unsupported", undefined],
    ["an injected finding", "host.test.blocked", undefined],
  ])("rejects %s blockers for the explicit portable profile (#9007)", (_, findingId, mode) => {
    const { output, result } = runInstallerHostAdmissionTest(
      {
        runtime: "podman",
        isUnsupportedRuntime: true,
        additionalFindingIds: [findingId],
      },
      undefined,
      { experimentalProfile: "portable", gatewayManagementMode: mode },
    );

    expect(result.status, output).toBe(1);
    expect(output).toContain(findingId);
  });

  it("rejects an unknown required capability for the explicit portable profile (#9007)", () => {
    const { output, result } = runInstallerHostAdmissionTest(
      {
        runtime: "podman",
        isUnsupportedRuntime: true,
        unknownCapabilityIds: ["host.docker.runtime_supported"],
      },
      undefined,
      { experimentalProfile: "portable" },
    );

    expect(result.status, output).toBe(1);
    expect(output).toContain("host.docker.runtime_supported");
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
