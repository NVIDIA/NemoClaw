// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH, writeExecutable } from "./installer-sourced-env";

/** Fake node that reports v22.19.0. */
export function writeNodeStub(fakeBin: string): void {
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

export function writeFailedOnboardSession(home: string): void {
  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".nemoclaw", "onboard-session.json"),
    JSON.stringify(
      {
        resumable: true,
        status: "failed",
        failure: { step: "inference", message: "Ollama proxy unreachable" },
      },
      null,
      2,
    ),
  );
}

export function writeInstallerReadinessModuleStubs(readinessDir: string): void {
  const onboardDir = path.join(path.dirname(readinessDir), "onboard");
  const experimentalDir = path.join(onboardDir, "experimental");
  fs.mkdirSync(readinessDir, { recursive: true });
  fs.mkdirSync(onboardDir, { recursive: true });
  fs.mkdirSync(experimentalDir, { recursive: true });
  fs.writeFileSync(
    `${readinessDir}/host.js`,
    `exports.createHostReadinessReport = (_options, collection) => ({ host: collection.assess() });\n`,
  );
  fs.writeFileSync(
    `${readinessDir}/onboard-admission.js`,
    `exports.evaluateOnboardReadinessAdmission = (report, options) => {
  const host = report.host;
  const unsupportedRuntime =
    (host.runtime === "podman" || host.isUnsupportedRuntime === true) &&
    !options.allowUnsupportedRuntime;
  const cdiBlocks = host.cdiNvidiaGpuSpecNeedsRepair && !(host.isWsl && host.runtime === "docker-desktop");
  const storageRemediationAvailable =
    host.platform === "linux" &&
    !host.isWsl &&
    host.runtime === "docker" &&
    host.hasNestedOverlayConflict === true &&
    host.dockerStorageDriver === "overlayfs" &&
    host.dockerUsesContainerdSnapshotter === true;
  const storageBlocks =
    host.hasNestedOverlayConflict === true &&
    !(options.allowStorageRemediation && storageRemediationAvailable);
  if (!unsupportedRuntime && !cdiBlocks && !storageBlocks) {
    return { admitted: true, waivedFindingIds: storageRemediationAvailable ? ["host.docker.storage_incompatible"] : [] };
  }
  return {
    admitted: false,
    findingIds: [
      ...(unsupportedRuntime ? ["host.docker.runtime_unsupported"] : []),
      ...(cdiBlocks ? ["host.gpu.cdi_missing"] : []),
      ...(storageBlocks ? ["host.docker.storage_incompatible"] : []),
      ...(process.env.INSTALLER_TEST_EXTRA_ADMISSION_FINDING_ID
        ? [process.env.INSTALLER_TEST_EXTRA_ADMISSION_FINDING_ID]
        : []),
    ],
    capabilityIds: [],
    waivedFindingIds: [],
  };
};
`,
  );
  fs.writeFileSync(
    `${onboardDir}/gateway-management.js`,
    `exports.loadGatewayManagementDeclaration = () => {
  const mode = process.env.INSTALLER_TEST_GATEWAY_MANAGEMENT_MODE;
  if (mode === "invalid") return { ok: false, reason: "invalid test declaration" };
  return { ok: true, declaration: mode ? { mode } : null };
};
`,
  );
  fs.writeFileSync(
    `${experimentalDir}/portable-profile.js`,
    `exports.isPortableExperimentalProfile = (env = process.env) => env.NEMOCLAW_EXPERIMENTAL_PROFILE === "portable";\n`,
  );
  fs.writeFileSync(
    `${onboardDir}/docker-driver-gateway-env.js`,
    `exports.configuredRuntimeProviderOwnsHostReadiness = () => false;\n`,
  );
}

export function runStorageRemediationInstallerPreflight({
  gatewayMode,
  onboardModuleDir,
  readinessModuleDir,
  storageRemediationAvailable,
}: {
  gatewayMode?: "nemoclaw-managed" | "externally-supervised" | "invalid";
  onboardModuleDir: string;
  readinessModuleDir: string;
  storageRemediationAvailable: boolean;
}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-storage-readiness-"));
  const fakeBin = path.join(tmp, "bin");
  const sourceRoot = path.join(tmp, "source");
  const onboardLog = path.join(tmp, "onboard.log");
  const onboardDir = path.join(sourceRoot, onboardModuleDir);
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(onboardDir, { recursive: true });

  fs.writeFileSync(
    path.join(onboardDir, "preflight.js"),
    `exports.assessHost = () => ({
  platform: "linux",
  architecture: "x64",
  runtime: "docker",
  isWsl: false,
  dockerInstalled: true,
  dockerReachable: true,
  dockerHostInvalid: false,
  isUnsupportedRuntime: false,
  hasNestedOverlayConflict: true,
  dockerStorageDriver: "overlayfs",
  dockerUsesContainerdSnapshotter: ${storageRemediationAvailable ? "true" : "false"},
  cdiNvidiaGpuSpecMissing: false,
  cdiNvidiaGpuSpecStale: false,
  cdiNvidiaGpuSpecNeedsRepair: false,
  nvidiaContainerToolkitInstalled: false,
  hostGpuPlatform: "generic",
  nvidiaDriverVersion: null,
  notes: [],
});
exports.planHostAdvisories = () => [];
exports.getNvidiaCdiSpecPath = () => "/etc/cdi/nvidia.yaml";
exports.isWslDockerDesktopRuntime = () => false;
`,
  );
  writeInstallerReadinessModuleStubs(path.join(sourceRoot, readinessModuleDir));
  writeNodeStub(fakeBin);

  const result = spawnSync(
    "bash",
    [
      "-c",
      `
source "$INSTALLER_UNDER_TEST" >/dev/null
NEMOCLAW_SOURCE_ROOT="$SOURCE_ROOT"
run_onboard() { printf 'onboard\\n' > "$ONBOARD_LOG"; }
if run_installer_host_preflight; then
  run_onboard
else
  exit 1
fi
`,
    ],
    {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        SOURCE_ROOT: sourceRoot,
        ONBOARD_LOG: onboardLog,
        INSTALLER_TEST_EXTRA_ADMISSION_FINDING_ID: "unsafe\ninjected",
        ...(gatewayMode ? { INSTALLER_TEST_GATEWAY_MANAGEMENT_MODE: gatewayMode } : {}),
      },
    },
  );

  return {
    onboardRan: fs.existsSync(onboardLog),
    output: `${result.stdout}${result.stderr}`,
    result,
  };
}
