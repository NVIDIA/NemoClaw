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

const OPENRM_CAPABILITY_DEVICE = "/dev/nvidia-caps/nvidia-cap2";
const CUDA_RESULT_PATTERN = /cuInit\(0\)=(-?\d+)/u;
const PROOF_TIMEOUT_MS = 30_000;
const CUDA_PROBE = [
  "import ctypes",
  'lib = ctypes.CDLL("libcuda.so.1")',
  "lib.cuInit.argtypes = [ctypes.c_uint]",
  "lib.cuInit.restype = ctypes.c_int",
  "rc = lib.cuInit(0)",
  'print(f"cuInit(0)={rc}")',
  "raise SystemExit(0 if rc == 0 else 1)",
].join("; ");

type OpenRmProofDeps = Pick<
  DockerGpuPatchDeps,
  "dockerRun" | "runCaptureOpenshell" | "runOpenshell"
> & {
  isCharacterDevice?: (devicePath: string) => boolean;
};

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
  };
};

function cudaResult(value: string): string {
  return value.match(CUDA_RESULT_PATTERN)?.[1] ?? "missing";
}

function proofCudaResult(proof: SandboxGpuProofResult): string {
  if (proof.status === "verified" && proof.cudaVerified) return "0";
  return cudaResult(proof.detail ?? "");
}

function hasCharacterDevice(devicePath: string): boolean {
  try {
    return fs.statSync(devicePath).isCharacterDevice();
  } catch {
    return false;
  }
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

function candidatePolicy(policyYaml: string): string {
  const policy = YAML.parse(policyYaml) as PolicyDocument | null;
  const filesystemPolicy = policy?.filesystem_policy;
  if (!filesystemPolicy || typeof filesystemPolicy !== "object") {
    throw new Error("OpenShell base policy has no filesystem_policy mapping.");
  }
  if (!Array.isArray(filesystemPolicy.read_only)) {
    throw new Error("OpenShell base policy filesystem_policy.read_only is not a list.");
  }
  if (filesystemPolicy.read_only.includes(OPENRM_CAPABILITY_DEVICE)) {
    throw new Error(`${OPENRM_CAPABILITY_DEVICE} is already present in the baseline policy.`);
  }
  filesystemPolicy.read_only.push(OPENRM_CAPABILITY_DEVICE);
  return YAML.stringify(policy);
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
  const isCharacterDevice = options.deps.isCharacterDevice ?? hasCharacterDevice;
  if (!isCharacterDevice(OPENRM_CAPABILITY_DEVICE)) {
    console.error(
      `  OpenRM A/B inconclusive: ${OPENRM_CAPABILITY_DEVICE} is not a host character device.`,
    );
    return;
  }

  const direct = dockerRun(
    ["exec", "--user", "sandbox", options.result.newContainerId, "python3", "-c", CUDA_PROBE],
    { ignoreError: true, suppressOutput: true, timeout: PROOF_TIMEOUT_MS },
  );
  const directOutput = `${direct.stderr ?? ""}\n${direct.stdout ?? ""}`;
  const directResult = cudaResult(directOutput);
  const rawPolicy = captureOpenshell(["policy", "get", "--base", options.sandboxName], {
    ignoreError: false,
    timeout: PROOF_TIMEOUT_MS,
  });
  const baselinePolicy = parseOpenShellPolicy(rawPolicy).yamlBody;
  if (!baselinePolicy) throw new Error("OpenShell returned no round-trippable base policy.");
  const candidate = candidatePolicy(baselinePolicy);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openrm-proof-"));
  const baselinePath = path.join(temporaryDirectory, "baseline.yaml");
  const candidatePath = path.join(temporaryDirectory, "candidate.yaml");
  fs.writeFileSync(baselinePath, baselinePolicy, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(candidatePath, candidate, { encoding: "utf8", mode: 0o600 });

  let candidateResult = "missing";
  let candidateApplied = false;
  try {
    candidateApplied = true;
    setPolicy(options.sandboxName, candidatePath, runOpenshell);
    candidateResult = proofCudaResult(options.verifyDirectSandboxGpu(options.sandboxName));
  } finally {
    if (candidateApplied) setPolicy(options.sandboxName, baselinePath, runOpenshell);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  console.log("");
  console.log("  === Jetson OpenRM policy A/B ===");
  console.log(
    `  direct_docker_cuInit=${directResult} baseline_openshell_cuInit=801 candidate_openshell_cuInit=${candidateResult}`,
  );
  if (directResult === "0" && candidateResult === "0") {
    console.log(
      `  PROVEN: granting only ${OPENRM_CAPABILITY_DEVICE} read-only changes OpenShell cuInit from 801 to 0.`,
    );
  } else {
    console.error(
      `  INCONCLUSIVE: the A/B did not isolate ${OPENRM_CAPABILITY_DEVICE}; no production policy change is justified.`,
    );
  }
}
