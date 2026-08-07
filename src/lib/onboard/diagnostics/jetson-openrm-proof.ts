// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { parseOpenShellPolicy } from "../../policy/merge";
import type { SandboxGpuProofResult } from "../../state/registry";
import { dockerRun as defaultDockerRun } from "../docker-gpu-patch";
import type {
  DockerGpuPatchBackend,
  DockerGpuPatchDeps,
  DockerGpuPatchResult,
} from "../docker-gpu-patch-types";
import { runJetsonOpenRmNamespaceProof } from "./jetson-openrm-namespace-proof";
import { runJetsonOpenRmProcessProof } from "./jetson-openrm-process-proof";

const CUDA_RESULT_PATTERN = /cuInit\(0\)=(-?\d+)/u;
const PROOF_TIMEOUT_MS = 30_000;
const SYSFS_ROOT = "/sys";
const MAX_CHARACTER_DEVICE_PATHS = 256;
const CUDA_PROBE = [
  "import ctypes",
  'lib = ctypes.CDLL("libcuda.so.1")',
  "lib.cuInit.argtypes = [ctypes.c_uint]",
  "lib.cuInit.restype = ctypes.c_int",
  "rc = lib.cuInit(0)",
  'print(f"cuInit(0)={rc}")',
  "raise SystemExit(0 if rc == 0 else 1)",
].join("; ");
const CHARACTER_DEVICE_DISCOVERY_PROBE = [
  "import os, stat",
  "for root, dirs, files in os.walk('/dev'):",
  "    for name in files:",
  "        device = os.path.join(root, name)",
  "        try:",
  "            if stat.S_ISCHR(os.lstat(device).st_mode): print(device)",
  "        except OSError:",
  "            pass",
].join("\n");
const PROCESS_STATUS_PROBE =
  "grep -E '^(Uid|Gid|Groups|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp|Seccomp_filters):' /proc/self/status";
const CHARACTER_DEVICE_PATH_PATTERN = /^\/dev(?:\/[A-Za-z0-9._-]+)+$/u;
const GPU_DEVICE_PATH_PATTERN =
  /^\/dev\/(?:nvidia[A-Za-z0-9._/-]*|nvhost[A-Za-z0-9._/-]*|nvgpu(?:\/[A-Za-z0-9._-]+)*|nvsci[A-Za-z0-9._/-]*|tegra[A-Za-z0-9._/-]*|nvmap|dri\/(?:renderD|card)\d+)$/u;
const FILESYSTEM_PATH_CANDIDATES: readonly PolicyCandidate[] = [
  { name: "dev-shm-read", readOnly: ["/dev/shm"], readWrite: [] },
  { name: "dev-shm-read-write", readOnly: [], readWrite: ["/dev/shm"] },
  { name: "run-read", readOnly: ["/run"], readWrite: [] },
  { name: "run-read-write", readOnly: [], readWrite: ["/run"] },
  { name: "var-read", readOnly: ["/var"], readWrite: [] },
  { name: "var-read-write", readOnly: [], readWrite: ["/var"] },
  { name: "home-read", readOnly: ["/home"], readWrite: [] },
  { name: "opt-read", readOnly: ["/opt"], readWrite: [] },
  { name: "mnt-read", readOnly: ["/mnt"], readWrite: [] },
  { name: "media-read", readOnly: ["/media"], readWrite: [] },
  { name: "srv-read", readOnly: ["/srv"], readWrite: [] },
];

type OpenRmProofDeps = Pick<
  DockerGpuPatchDeps,
  "dockerRun" | "runCaptureOpenshell" | "runOpenshell"
>;

type OpenRmProofOptions = {
  backend?: DockerGpuPatchBackend;
  enabled?: boolean;
  failure: Error;
  preserveJetsonDeviceGroupMembership?: boolean;
  result: DockerGpuPatchResult | null;
  sandboxName: string;
  verifyDirectSandboxGpu: (sandboxName: string) => SandboxGpuProofResult;
  deps: OpenRmProofDeps;
};

type PolicyDocument = {
  filesystem_policy?: {
    read_only?: unknown;
    read_write?: unknown;
  };
};

type PolicyCandidate = {
  name: string;
  readOnly: string[];
  readWrite: string[];
};

export class JetsonOpenRmPolicyRestorationError extends Error {
  readonly candidateError: unknown | null;
  readonly restorationError: unknown;
  readonly cleanupError: unknown | null;

  constructor(options: {
    candidateError: unknown | null;
    restorationError: unknown;
    cleanupError: unknown | null;
  }) {
    const detail =
      options.restorationError instanceof Error
        ? options.restorationError.message
        : String(options.restorationError);
    super(`NemoClaw could not confirm that OpenShell restored the baseline policy: ${detail}`);
    this.name = "JetsonOpenRmPolicyRestorationError";
    this.candidateError = options.candidateError;
    this.restorationError = options.restorationError;
    this.cleanupError = options.cleanupError;
  }
}

function cudaResult(value: string): string {
  return value.match(CUDA_RESULT_PATTERN)?.[1] ?? "missing";
}

function proofCudaResult(proof: SandboxGpuProofResult): string {
  if (proof.status === "verified" && proof.cudaVerified) return "0";
  return cudaResult(proof.detail ?? "");
}

function setPolicy(
  sandboxName: string,
  policyPath: string,
  runOpenshell: NonNullable<DockerGpuPatchDeps["runOpenshell"]>,
): void {
  const result = runOpenshell(["policy", "set", "--policy", policyPath, "--wait", sandboxName], {
    ignoreError: true,
    suppressOutput: true,
    timeout: PROOF_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(`OpenShell rejected diagnostic policy file ${policyPath}.`);
  }
}

function parseFilesystemPolicy(policyYaml: string): {
  policy: PolicyDocument;
  readOnly: string[];
  readWrite: string[];
} {
  const policy = YAML.parse(policyYaml) as PolicyDocument | null;
  const filesystemPolicy = policy?.filesystem_policy;
  if (!filesystemPolicy || typeof filesystemPolicy !== "object") {
    throw new Error("OpenShell base policy has no filesystem_policy mapping.");
  }
  if (!Array.isArray(filesystemPolicy.read_only) || !Array.isArray(filesystemPolicy.read_write)) {
    throw new Error("OpenShell base policy filesystem policy paths are not lists.");
  }
  return {
    policy,
    readOnly: filesystemPolicy.read_only.map(String),
    readWrite: filesystemPolicy.read_write.map(String),
  };
}

function candidatePolicy(policyYaml: string, candidate: PolicyCandidate): string {
  const { policy, readOnly, readWrite } = parseFilesystemPolicy(policyYaml);
  const filesystemPolicy = policy.filesystem_policy;
  if (!filesystemPolicy) throw new Error("OpenShell base policy has no filesystem_policy mapping.");
  const readWriteSet = new Set(readWrite);
  for (const devicePath of candidate.readWrite) readWriteSet.add(devicePath);
  const readOnlySet = new Set(readOnly.filter((policyPath) => !readWriteSet.has(policyPath)));
  for (const policyPath of candidate.readOnly) {
    if (!readWriteSet.has(policyPath)) readOnlySet.add(policyPath);
  }
  filesystemPolicy.read_only = [...readOnlySet];
  filesystemPolicy.read_write = [...readWriteSet];
  return YAML.stringify(policy);
}

function discoverCharacterDevicePaths(
  containerId: string,
  dockerRun: NonNullable<DockerGpuPatchDeps["dockerRun"]>,
): string[] {
  const result = dockerRun(
    ["exec", "--user", "0", containerId, "python3", "-c", CHARACTER_DEVICE_DISCOVERY_PROBE],
    { ignoreError: true, suppressOutput: true, timeout: PROOF_TIMEOUT_MS },
  );
  if (result.status !== 0) throw new Error("Could not enumerate container character devices.");
  const devicePaths = [
    ...new Set(
      String(result.stdout ?? "")
        .split(/\r?\n/u)
        .map((devicePath) => devicePath.trim())
        .filter((devicePath) => CHARACTER_DEVICE_PATH_PATTERN.test(devicePath)),
    ),
  ].sort();
  if (devicePaths.length === 0 || devicePaths.length > MAX_CHARACTER_DEVICE_PATHS) {
    throw new Error("Container character-device enumeration is empty or excessive.");
  }
  return devicePaths;
}

function policyPathCovers(policyPath: string, targetPath: string): boolean {
  return policyPath === "/" || targetPath === policyPath || targetPath.startsWith(`${policyPath}/`);
}

function compactProcessStatus(value: string | Buffer | null | undefined): string {
  return String(value ?? "")
    .trim()
    .split(/\r?\n/u)
    .join("; ");
}

/**
 * Maintainer-only hardware A/B for issue #7610. The caller invokes this after
 * the live OpenShell CUDA proof returns 801 and before it rolls the exact
 * replacement container back. The baseline policy is restored in `finally`.
 */
export function maybeRunJetsonOpenRmPolicyProof(options: OpenRmProofOptions): void {
  const enabled = options.enabled ?? process.env.NEMOCLAW_DIAGNOSE_JETSON_OPENRM_POLICY === "1";
  if (
    !enabled ||
    options.backend !== "jetson" ||
    options.preserveJetsonDeviceGroupMembership !== true ||
    options.result?.mode.kind !== "nvidia-runtime" ||
    !/cuInit\(0\)=801/u.test(options.failure.message)
  ) {
    return;
  }

  const dockerRun = options.deps.dockerRun ?? defaultDockerRun;
  const { runCaptureOpenshell: captureOpenshell, runOpenshell } = options.deps;
  if (!captureOpenshell || !runOpenshell) {
    console.error("  OpenRM A/B inconclusive: required OpenShell adapters are unavailable.");
    return;
  }
  const direct = dockerRun(
    ["exec", "--user", "sandbox", options.result.newContainerId, "python3", "-c", CUDA_PROBE],
    { ignoreError: true, suppressOutput: true, timeout: PROOF_TIMEOUT_MS },
  );
  const directOutput = `${direct.stderr ?? ""}\n${direct.stdout ?? ""}`;
  const directResult = cudaResult(directOutput);
  const characterDevicePaths = discoverCharacterDevicePaths(
    options.result.newContainerId,
    dockerRun,
  );
  const injectedDevicePaths = characterDevicePaths.filter((devicePath) =>
    GPU_DEVICE_PATH_PATTERN.test(devicePath),
  );
  const rawPolicy = captureOpenshell(["policy", "get", "--base", options.sandboxName], {
    ignoreError: false,
    timeout: PROOF_TIMEOUT_MS,
  });
  const baselinePolicy = parseOpenShellPolicy(rawPolicy).yamlBody;
  if (!baselinePolicy) throw new Error("OpenShell returned no round-trippable base policy.");
  const baselineFilesystemPolicy = parseFilesystemPolicy(baselinePolicy);
  const missingDevicePaths = injectedDevicePaths.filter(
    (devicePath) =>
      !baselineFilesystemPolicy.readWrite.some((policyPath) =>
        policyPathCovers(policyPath, devicePath),
      ),
  );
  const missingCharacterDevicePaths = characterDevicePaths.filter(
    (devicePath) =>
      !baselineFilesystemPolicy.readWrite.some((policyPath) =>
        policyPathCovers(policyPath, devicePath),
      ),
  );
  const sysfsMissing =
    !baselineFilesystemPolicy.readOnly.includes(SYSFS_ROOT) &&
    !baselineFilesystemPolicy.readWrite.includes(SYSFS_ROOT);
  const candidates: PolicyCandidate[] = [];
  if (missingDevicePaths.length > 0) {
    candidates.push({ name: "devices", readOnly: [], readWrite: missingDevicePaths });
  }
  if (sysfsMissing) {
    candidates.push({ name: "sysfs", readOnly: [SYSFS_ROOT], readWrite: [] });
  }
  if (missingDevicePaths.length > 0 && sysfsMissing) {
    candidates.push({
      name: "devices-plus-sysfs",
      readOnly: [SYSFS_ROOT],
      readWrite: missingDevicePaths,
    });
  }
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openrm-proof-"));
  const baselinePath = path.join(temporaryDirectory, "baseline.yaml");
  fs.writeFileSync(baselinePath, baselinePolicy, { encoding: "utf8", mode: 0o600 });

  const candidateResults = new Map<string, string>();
  const individualCharacterDeviceResults = new Map<string, string>();
  let candidateFailure: { readonly error: unknown } | null = null;
  try {
    const applyCandidate = (candidate: PolicyCandidate): string => {
      const candidatePath = path.join(temporaryDirectory, `${candidate.name}.yaml`);
      fs.writeFileSync(candidatePath, candidatePolicy(baselinePolicy, candidate), {
        encoding: "utf8",
        mode: 0o600,
      });
      setPolicy(options.sandboxName, candidatePath, runOpenshell);
      const result = proofCudaResult(options.verifyDirectSandboxGpu(options.sandboxName));
      candidateResults.set(candidate.name, result);
      return result;
    };
    for (const candidate of candidates) applyCandidate(candidate);

    if (candidateResults.get("devices") === "0") {
      const onlyPath = missingDevicePaths.length === 1 ? missingDevicePaths[0] : null;
      if (onlyPath) {
        individualCharacterDeviceResults.set(onlyPath, "0");
      } else {
        for (const [index, devicePath] of missingDevicePaths.entries()) {
          const result = applyCandidate({
            name: `gpu-device-${String(index)}`,
            readOnly: [],
            readWrite: [devicePath],
          });
          individualCharacterDeviceResults.set(devicePath, result);
        }
      }
    }

    if (![...candidateResults.values()].includes("0") && missingCharacterDevicePaths.length > 0) {
      const allCharacterDevicesResult = applyCandidate({
        name: "all-character-devices",
        readOnly: [],
        readWrite: missingCharacterDevicePaths,
      });
      if (allCharacterDevicesResult === "0") {
        for (const [index, devicePath] of missingCharacterDevicePaths.entries()) {
          const result = applyCandidate({
            name: `character-device-${String(index)}`,
            readOnly: [],
            readWrite: [devicePath],
          });
          individualCharacterDeviceResults.set(devicePath, result);
        }
      }
    }

    if (![...candidateResults.values()].includes("0")) {
      for (const candidate of FILESYSTEM_PATH_CANDIDATES) applyCandidate(candidate);
    }

    if (![...candidateResults.values()].includes("0")) {
      applyCandidate({ name: "read-root", readOnly: ["/"], readWrite: [] });
      if (candidateResults.get("read-root") !== "0") {
        applyCandidate({ name: "read-write-root", readOnly: [], readWrite: ["/"] });
      }
    }
  } catch (error) {
    candidateFailure = { error };
  }
  let restorationFailure: { readonly error: unknown } | null = null;
  try {
    setPolicy(options.sandboxName, baselinePath, runOpenshell);
  } catch (error) {
    restorationFailure = { error };
  }
  let cleanupFailure: { readonly error: unknown } | null = null;
  try {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  } catch (error) {
    cleanupFailure = { error };
  }
  if (restorationFailure !== null) {
    throw new JetsonOpenRmPolicyRestorationError({
      candidateError: candidateFailure?.error ?? null,
      restorationError: restorationFailure.error,
      cleanupError: cleanupFailure?.error ?? null,
    });
  }
  if (candidateFailure !== null) throw candidateFailure.error;
  if (cleanupFailure !== null) throw cleanupFailure.error;

  const deviceResult = candidateResults.get("devices") ?? "not-tested";
  const sysfsResult = candidateResults.get("sysfs") ?? "not-tested";
  const combinedResult = candidateResults.get("devices-plus-sysfs") ?? "not-tested";
  const allCharacterDevicesResult = candidateResults.get("all-character-devices") ?? "not-tested";
  const readRootResult = candidateResults.get("read-root") ?? "not-tested";
  const readWriteRootResult = candidateResults.get("read-write-root") ?? "not-tested";
  const isolatedCharacterDevices = [...individualCharacterDeviceResults]
    .filter(([, result]) => result === "0")
    .map(([devicePath]) => devicePath);
  const passingFilesystemCandidates = FILESYSTEM_PATH_CANDIDATES.filter(
    (candidate) => candidateResults.get(candidate.name) === "0",
  );
  const isolatedFilesystemCandidates = passingFilesystemCandidates.filter((candidate) => {
    const writePath = candidate.readWrite[0];
    return (
      !writePath || !passingFilesystemCandidates.some((other) => other.readOnly.includes(writePath))
    );
  });

  console.log("");
  console.log("  === Jetson OpenRM policy boundary matrix ===");
  console.log(`  injected_gpu_devices=${injectedDevicePaths.join(",")}`);
  console.log(`  policy_missing_gpu_devices=${missingDevicePaths.join(",") || "none"}`);
  console.log(
    `  policy_missing_character_devices=${missingCharacterDevicePaths.join(",") || "none"}`,
  );
  console.log(
    `  direct_docker_cuInit=${directResult} baseline_openshell_cuInit=801 devices_cuInit=${deviceResult} sysfs_cuInit=${sysfsResult} devices_plus_sysfs_cuInit=${combinedResult} all_character_devices_cuInit=${allCharacterDevicesResult} read_root_cuInit=${readRootResult} read_write_root_cuInit=${readWriteRootResult}`,
  );
  if (FILESYSTEM_PATH_CANDIDATES.some((candidate) => candidateResults.has(candidate.name))) {
    console.log(
      `  filesystem_candidate_cuInit=${FILESYSTEM_PATH_CANDIDATES.map((candidate) => `${candidate.name}:${candidateResults.get(candidate.name) ?? "not-tested"}`).join(",")}`,
    );
  }
  if (directResult === "0" && isolatedCharacterDevices.length > 0) {
    console.log(
      `  ISOLATED: OpenShell policy is missing CUDA-required character device(s): ${isolatedCharacterDevices.join(",")}.`,
    );
  } else if (directResult === "0" && allCharacterDevicesResult === "0") {
    console.log(
      "  ISOLATED: CUDA requires a combination of character devices currently missing from OpenShell policy.",
    );
  } else if (directResult === "0" && deviceResult === "0" && sysfsResult !== "0") {
    console.log(
      "  ISOLATED: OpenShell policy is missing one or more NVIDIA/Tegra character devices; no sysfs grant is required.",
    );
  } else if (directResult === "0" && sysfsResult === "0" && deviceResult !== "0") {
    console.log(
      "  ISOLATED: OpenShell policy is missing CUDA-required sysfs visibility; exact sysfs paths still need narrowing.",
    );
  } else if (directResult === "0" && combinedResult === "0") {
    console.log(
      "  ISOLATED: CUDA requires both the missing GPU devices and sysfs visibility through OpenShell.",
    );
  } else if (directResult === "0" && isolatedFilesystemCandidates.length > 0) {
    console.log(
      `  ISOLATED: CUDA requires additional Landlock path access: ${isolatedFilesystemCandidates.map((candidate) => `${candidate.readWrite.length > 0 ? "read-write" : "read-only"}:${candidate.readWrite[0] ?? candidate.readOnly[0]}`).join(",")}.`,
    );
  } else if (directResult === "0" && readRootResult === "0") {
    console.log(
      "  ISOLATED: Landlock is missing CUDA-required read access outside the tested GPU devices and /sys.",
    );
  } else if (directResult === "0" && readWriteRootResult === "0") {
    console.log(
      "  ISOLATED: Landlock is missing CUDA-required write access outside the tested character devices.",
    );
  } else {
    console.error(
      "  INCONCLUSIVE: the filesystem-policy matrix did not restore CUDA; no production policy change is justified.",
    );
    const directStatus = dockerRun(
      [
        "exec",
        "--user",
        "sandbox",
        options.result.newContainerId,
        "sh",
        "-lc",
        PROCESS_STATUS_PROBE,
      ],
      { ignoreError: true, suppressOutput: true, timeout: PROOF_TIMEOUT_MS },
    );
    const openshellStatus = runOpenshell(
      ["sandbox", "exec", "-n", options.sandboxName, "--", "sh", "-lc", PROCESS_STATUS_PROBE],
      { ignoreError: true, suppressOutput: true, timeout: PROOF_TIMEOUT_MS },
    );
    console.log(`  direct_process_status=${compactProcessStatus(directStatus.stdout)}`);
    console.log(`  openshell_process_status=${compactProcessStatus(openshellStatus.stdout)}`);
    const processModelPasses = runJetsonOpenRmProcessProof(
      options.result.newContainerId,
      dockerRun,
    );
    if (processModelPasses && readWriteRootResult !== "0") {
      runJetsonOpenRmNamespaceProof(options.result.newContainerId, dockerRun);
    }
  }
}
