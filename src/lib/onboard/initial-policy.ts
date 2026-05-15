// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import YAML from "yaml";

import * as policies from "../policy";
import { cleanupTempDir, secureTempFile } from "./temp-files";

export type InitialSandboxPolicy = {
  policyPath: string;
  appliedPresets: string[];
  cleanup?: () => boolean;
};

const CREATE_TIME_POLICY_PRESETS_BY_CHANNEL: Record<string, string[]> = {
  slack: ["slack"],
};

const PROC_PATH = "/proc";
const STALE_PROC_COMM_READ_WRITE_PATH = "/proc/self/task/*/comm";

function isProcEntryOwnedByOpenShell(entry: string): boolean {
  return entry === PROC_PATH || entry === STALE_PROC_COMM_READ_WRITE_PATH;
}

type DirectGpuPolicyOptions = {
  procReadWrite?: boolean;
};

export function buildDirectGpuPolicyYaml(
  basePolicy: string,
  options: DirectGpuPolicyOptions = {},
): string {
  const parsed = YAML.parse(basePolicy);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Cannot prepare direct GPU sandbox policy; base policy is not a YAML mapping.");
  }
  parsed.filesystem_policy = parsed.filesystem_policy || {};
  const fsPolicy = parsed.filesystem_policy;
  // OpenShell adds /proc as read-write only after GPU devices are present.
  // Remove entries that would block that enrichment or be treated as literal paths.
  const readOnly = Array.isArray(fsPolicy.read_only)
    ? fsPolicy.read_only.map((entry: unknown) => String(entry))
    : [];
  fsPolicy.read_only = readOnly.filter((entry: string) => !isProcEntryOwnedByOpenShell(entry));
  const readWrite = Array.isArray(fsPolicy.read_write)
    ? fsPolicy.read_write.map((entry: unknown) => String(entry))
    : [];
  fsPolicy.read_write = readWrite.filter((entry: string) => !isProcEntryOwnedByOpenShell(entry));
  if (options.procReadWrite && !fsPolicy.read_write.includes(PROC_PATH)) {
    // Linux Docker-driver GPU patching recreates the container with GPU flags
    // after `openshell sandbox create`, so OpenShell never sees `--gpu` and
    // cannot add its native /proc GPU enrichment. Mirror that enrichment here
    // for the patched path; without it Landlock denies the NVIDIA runtime's
    // /proc/<pid>/task/<tid>/comm write even though Docker GPU access works.
    fsPolicy.read_write.push(PROC_PATH);
  }
  return YAML.stringify(parsed);
}

const PROC_COMM_WRITE_PROBE = [
  "set -eu;",
  'comm="/proc/$$/task/$$/comm";',
  'old="$(cat "$comm" 2>/dev/null || true)";',
  'printf nemoclaw-gpu >"$comm";',
  'if [ -n "$old" ]; then',
  'printf "%s" "$old" >"$comm" || true;',
  "fi",
].join(" ");

const CUDA_INIT_PROBE = [
  "python3",
  "-c",
  [
    "'import ctypes;",
    'lib = ctypes.CDLL("libcuda.so.1");',
    "rc = lib.cuInit(0);",
    'print(f"cuInit(0)={rc}");',
    "raise SystemExit(0 if rc == 0 else 1)'",
  ].join(" "),
].join(" ");

const NVIDIA_SMI_OPTIONAL_PROBE = [
  "set -eu;",
  "if command -v nvidia-smi >/dev/null 2>&1; then",
  "exec nvidia-smi;",
  "fi;",
  'echo "nvidia-smi not installed; skipping optional visibility check"',
].join(" ");

export function buildDirectSandboxGpuProofCommands(
  sandboxName: string,
): { label: string; args: string[] }[] {
  return [
    {
      label: "nvidia-smi when available",
      args: ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", NVIDIA_SMI_OPTIONAL_PROBE],
    },
    {
      label: "/proc/<pid>/task/<tid>/comm write",
      args: ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", PROC_COMM_WRITE_PROBE],
    },
    {
      label: "cuInit(0) via libcuda.so.1",
      args: ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", CUDA_INIT_PROBE],
    },
  ];
}

function prepareDirectGpuSandboxPolicy(
  basePolicyPath: string,
  options: DirectGpuPolicyOptions = {},
): InitialSandboxPolicy {
  const basePolicy = fs.readFileSync(basePolicyPath, "utf-8");
  const policyPath = secureTempFile("nemoclaw-gpu-policy", ".yaml");
  fs.writeFileSync(policyPath, buildDirectGpuPolicyYaml(basePolicy, options), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return {
    policyPath,
    appliedPresets: [],
    cleanup: () => {
      try {
        cleanupTempDir(policyPath, "nemoclaw-gpu-policy");
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function getNetworkPolicyNames(policyContent: string): Set<string> | null {
  try {
    const parsed = YAML.parse(policyContent);
    const networkPolicies = parsed?.network_policies;
    if (
      !networkPolicies ||
      typeof networkPolicies !== "object" ||
      Array.isArray(networkPolicies)
    ) {
      return new Set();
    }
    return new Set(Object.keys(networkPolicies));
  } catch {
    return null;
  }
}

export function prepareInitialSandboxCreatePolicy(
  basePolicyPath: string,
  activeMessagingChannels: string[],
  options: { directGpu?: boolean; dockerGpuPatch?: boolean } = {},
): InitialSandboxPolicy {
  const directGpuPolicy = options.directGpu
    ? prepareDirectGpuSandboxPolicy(basePolicyPath, {
        procReadWrite: options.dockerGpuPatch === true,
      })
    : null;
  const effectiveBasePolicyPath = directGpuPolicy?.policyPath || basePolicyPath;
  const cleanupFns = directGpuPolicy?.cleanup ? [directGpuPolicy.cleanup] : [];
  const requestedCreateTimePresets = [
    ...new Set(
      activeMessagingChannels.flatMap(
        (channel) => CREATE_TIME_POLICY_PRESETS_BY_CHANNEL[channel] || [],
      ),
    ),
  ];
  const combinedCleanup =
    cleanupFns.length > 0 ? () => cleanupFns.map((cleanup) => cleanup()).every(Boolean) : undefined;

  if (requestedCreateTimePresets.length === 0) {
    return {
      policyPath: effectiveBasePolicyPath,
      appliedPresets: [],
      cleanup: combinedCleanup,
    };
  }

  const basePolicy = fs.readFileSync(effectiveBasePolicyPath, "utf-8");
  const basePolicyNames = getNetworkPolicyNames(basePolicy);
  if (basePolicyNames === null) {
    return {
      policyPath: effectiveBasePolicyPath,
      appliedPresets: [],
      cleanup: combinedCleanup,
    };
  }
  const existingCreateTimePresets = requestedCreateTimePresets.filter((preset) =>
    basePolicyNames.has(preset),
  );
  const createTimePresets = requestedCreateTimePresets.filter(
    (preset) => !basePolicyNames.has(preset),
  );
  if (createTimePresets.length === 0) {
    return {
      policyPath: effectiveBasePolicyPath,
      appliedPresets: existingCreateTimePresets,
      cleanup: combinedCleanup,
    };
  }

  const mergedPolicy = policies.mergePresetNamesIntoPolicy(basePolicy, createTimePresets);
  if (mergedPolicy.missingPresets.length > 0) {
    throw new Error(
      `Cannot prepare sandbox create policy; missing policy preset(s): ${mergedPolicy.missingPresets.join(", ")}`,
    );
  }

  const policyPath = secureTempFile("nemoclaw-initial-policy", ".yaml");
  fs.writeFileSync(policyPath, mergedPolicy.policy, { encoding: "utf-8", mode: 0o600 });
  cleanupFns.push(() => {
    try {
      cleanupTempDir(policyPath, "nemoclaw-initial-policy");
      return true;
    } catch {
      return false;
    }
  });

  return {
    policyPath,
    appliedPresets: [...existingCreateTimePresets, ...mergedPolicy.appliedPresets],
    cleanup: () => cleanupFns.map((cleanup) => cleanup()).every(Boolean),
  };
}
