// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import * as policies from "../policy";
import { requiredMessagingChannelPolicyPresets } from "./messaging-policy-presets";
import { cleanupTempDir, secureTempFile } from "./temp-files";

export type InitialSandboxPolicy = {
  policyPath: string;
  appliedPresets: string[];
  cleanup?: () => boolean;
};

const HERMES_MESSAGING_POLICY_KEYS: Record<string, string[]> = {
  discord: ["discord"],
  slack: ["slack"],
  telegram: ["telegram"],
  wechat: ["wechat_bridge"],
};

const PROC_PATH = "/proc";
const PROC_COMM_READ_WRITE_PATHS = ["/proc/self/comm", "/proc/self/task/*/comm"];

function isProcEntryOwnedByOpenShell(entry: string): boolean {
  return entry === PROC_PATH || PROC_COMM_READ_WRITE_PATHS.includes(entry);
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
  'comm="/proc/self/comm";',
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

export type DirectSandboxGpuProofCommand = {
  id: string;
  label: string;
  args: string[];
  optional?: boolean;
};

export function buildDirectSandboxGpuProofCommands(
  sandboxName: string,
): DirectSandboxGpuProofCommand[] {
  return [
    {
      id: "nvidia-smi",
      label: "nvidia-smi when available",
      args: ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", NVIDIA_SMI_OPTIONAL_PROBE],
    },
    {
      id: "proc-comm-write",
      label: "/proc/<pid>/task/<tid>/comm write",
      optional: true,
      args: ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", PROC_COMM_WRITE_PROBE],
    },
    {
      id: "cuda-init",
      label: "cuInit(0) via libcuda.so.1",
      optional: true,
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

function isYamlObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filterHermesInactiveMessagingPolicies(
  policyContent: string,
  activeMessagingChannels: string[],
): { content: string; changed: boolean } {
  const parsed = YAML.parse(policyContent);
  if (!isYamlObject(parsed) || !isYamlObject(parsed.network_policies)) {
    return { content: policyContent, changed: false };
  }

  const active = new Set(activeMessagingChannels);
  let changed = false;
  for (const [channel, policyKeys] of Object.entries(HERMES_MESSAGING_POLICY_KEYS)) {
    if (active.has(channel)) continue;
    for (const key of policyKeys) {
      if (Object.prototype.hasOwnProperty.call(parsed.network_policies, key)) {
        delete parsed.network_policies[key];
        changed = true;
      }
    }
  }

  return {
    content: changed ? YAML.stringify(parsed) : policyContent,
    changed,
  };
}

function isHermesPolicyPath(policyPath: string): boolean {
  const normalized = policyPath.split(path.sep).join("/");
  return /(^|\/)agents\/hermes\/policy-additions\.yaml$/.test(normalized);
}

export function prepareInitialSandboxCreatePolicy(
  basePolicyPath: string,
  activeMessagingChannels: string[],
  options: {
    directGpu?: boolean;
    dockerGpuPatch?: boolean;
    additionalPresets?: string[];
    agentName?: string | null;
  } = {},
): InitialSandboxPolicy {
  const directGpuPolicy = options.directGpu
    ? prepareDirectGpuSandboxPolicy(basePolicyPath, {
        procReadWrite: options.dockerGpuPatch === true,
      })
    : null;
  let effectiveBasePolicyPath = directGpuPolicy?.policyPath || basePolicyPath;
  const cleanupFns = directGpuPolicy?.cleanup ? [directGpuPolicy.cleanup] : [];
  const buildCleanup = () =>
    cleanupFns.length > 0
      ? () => cleanupFns.map((cleanup) => cleanup()).every(Boolean)
      : undefined;
  const requestedCreateTimePresets = [
    ...new Set(
      [
        ...requiredMessagingChannelPolicyPresets(activeMessagingChannels),
        ...(options.additionalPresets || []),
      ],
    ),
  ];
  const dedupe = (values: string[]) => [...new Set(values.filter(Boolean))];

  let basePolicy = fs.readFileSync(effectiveBasePolicyPath, "utf-8");
  if (options.agentName === "hermes" || isHermesPolicyPath(basePolicyPath)) {
    const filtered = filterHermesInactiveMessagingPolicies(basePolicy, activeMessagingChannels);
    if (filtered.changed) {
      const policyPath = secureTempFile("nemoclaw-agent-policy", ".yaml");
      fs.writeFileSync(policyPath, filtered.content, { encoding: "utf-8", mode: 0o600 });
      cleanupFns.push(() => {
        try {
          cleanupTempDir(policyPath, "nemoclaw-agent-policy");
          return true;
        } catch {
          return false;
        }
      });
      effectiveBasePolicyPath = policyPath;
      basePolicy = filtered.content;
    }
  }

  const basePolicyNames = getNetworkPolicyNames(basePolicy);
  if (basePolicyNames === null) {
    return {
      policyPath: effectiveBasePolicyPath,
      appliedPresets: [],
      cleanup: buildCleanup(),
    };
  }
  const existingChannelPresets = activeMessagingChannels.filter((channel) =>
    basePolicyNames.has(channel),
  );

  if (requestedCreateTimePresets.length === 0) {
    return {
      policyPath: effectiveBasePolicyPath,
      appliedPresets: dedupe(existingChannelPresets),
      cleanup: buildCleanup(),
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
      appliedPresets: dedupe([...existingChannelPresets, ...existingCreateTimePresets]),
      cleanup: buildCleanup(),
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
    appliedPresets: dedupe([
      ...existingChannelPresets,
      ...existingCreateTimePresets,
      ...mergedPolicy.appliedPresets,
    ]),
    cleanup: buildCleanup(),
  };
}
