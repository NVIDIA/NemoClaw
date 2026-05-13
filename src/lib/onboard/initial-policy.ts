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

const PROC_COMM_READ_WRITE_PATH = "/proc/self/task/*/comm";

export function buildDirectGpuPolicyYaml(basePolicy: string): string {
  const parsed = YAML.parse(basePolicy);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Cannot prepare direct GPU sandbox policy; base policy is not a YAML mapping.");
  }
  parsed.filesystem_policy = parsed.filesystem_policy || {};
  const fsPolicy = parsed.filesystem_policy;
  fsPolicy.read_only = Array.isArray(fsPolicy.read_only)
    ? fsPolicy.read_only.map((entry: unknown) => String(entry))
    : [];
  if (!fsPolicy.read_only.includes("/proc")) {
    fsPolicy.read_only.push("/proc");
  }
  const readWrite = Array.isArray(fsPolicy.read_write)
    ? fsPolicy.read_write.map((entry: unknown) => String(entry))
    : [];
  fsPolicy.read_write = readWrite.filter((entry: string) => entry !== "/proc");
  if (!fsPolicy.read_write.includes(PROC_COMM_READ_WRITE_PATH)) {
    fsPolicy.read_write.push(PROC_COMM_READ_WRITE_PATH);
  }
  return YAML.stringify(parsed);
}

const PROC_COMM_WRITE_PROBE = `
set -eu
tid="$(ls /proc/self/task | head -n 1)"
old="$(cat "/proc/self/task/\${tid}/comm" 2>/dev/null || true)"
printf nemoclaw-gpu >"/proc/self/task/\${tid}/comm"
if [ -n "$old" ]; then printf "%s" "$old" >"/proc/self/task/\${tid}/comm" || true; fi
`;

const CUDA_INIT_PROBE = `
python3 - <<'PY'
import ctypes
lib = ctypes.CDLL("libcuda.so.1")
rc = lib.cuInit(0)
print(f"cuInit(0)={rc}")
raise SystemExit(0 if rc == 0 else 1)
PY
`;

export function buildDirectSandboxGpuProofCommands(
  sandboxName: string,
): { label: string; args: string[] }[] {
  return [
    {
      label: "nvidia-smi",
      args: ["sandbox", "exec", "-n", sandboxName, "--", "nvidia-smi"],
    },
    {
      label: "/proc/self/task/<tid>/comm write",
      args: ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", PROC_COMM_WRITE_PROBE],
    },
    {
      label: "cuInit(0) via libcuda.so.1",
      args: ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", CUDA_INIT_PROBE],
    },
  ];
}

function prepareDirectGpuSandboxPolicy(basePolicyPath: string): InitialSandboxPolicy {
  const basePolicy = fs.readFileSync(basePolicyPath, "utf-8");
  const policyPath = secureTempFile("nemoclaw-gpu-policy", ".yaml");
  fs.writeFileSync(policyPath, buildDirectGpuPolicyYaml(basePolicy), {
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
  options: { directGpu?: boolean } = {},
): InitialSandboxPolicy {
  const directGpuPolicy = options.directGpu ? prepareDirectGpuSandboxPolicy(basePolicyPath) : null;
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
