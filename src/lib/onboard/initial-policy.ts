// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { isObjectRecord } from "../core/json-types";
import { getMessagingPolicyKeysByChannel } from "../messaging/channels";
import * as policies from "../policy";
import {
  allMessagingChannelPolicyPresets,
  requiredMessagingChannelPolicyPresets,
} from "./messaging-policy-presets";
import { requiredOpenclawOtelPolicyPresets } from "./openclaw-otel-policy-presets";
import { filterSuppressedAgentRequiredPresets } from "./policy-tier-suppression";
import { cleanupTempDir, secureTempFile } from "./temp-files";

export type InitialSandboxPolicy = {
  policyPath: string;
  appliedPresets: string[];
  cleanup?: () => boolean;
};

export function discloseInitialSandboxPolicy(policy: InitialSandboxPolicy): void {
  if (policy.appliedPresets.length === 0) return;
  console.log("  Including policy preset(s) at sandbox boot:", policy.appliedPresets.join(", "));
  policies.logPresetScope(fs.readFileSync(policy.policyPath, "utf8"));
}

const HERMES_MESSAGING_POLICY_KEYS = getMessagingPolicyKeysByChannel({ agent: "hermes" });

const PROC_PATH = "/proc";
const PROC_COMM_READ_WRITE_PATHS = ["/proc/self/comm", "/proc/self/task/*/comm"];
const SYSFS_PATH = "/sys";
const DMI_PRODUCT_NAME_PATH = "/sys/class/dmi/id/product_name";
const PCI_BDF_PATTERN = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/iu;
const NVIDIA_PCI_VENDOR = "0x10de";
const DISPLAY_PCI_CLASS_PATTERN = /^0x03[0-9a-f]{4}$/iu;
const STATION_GB300_SHARED_SYSFS_RELATIVE_PATHS = [
  "devices/system/cpu",
  "devices/system/memory",
  "devices/system/node",
  "module/nvidia/initstate",
  "module/nvidia_uvm/initstate",
] as const;

function isProcEntryOwnedByOpenShell(entry: string): boolean {
  return entry === PROC_PATH || PROC_COMM_READ_WRITE_PATHS.includes(entry);
}

function deduplicateDirectGpuSysfsEntries(
  entries: string[],
  candidates: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (!candidates.has(entry)) return true;
    if (seen.has(entry)) return false;
    seen.add(entry);
    return true;
  });
}

type DirectGpuPolicyOptions = {
  procReadWrite?: boolean;
  sysfsReadOnlyPaths?: readonly string[];
};

export function isStationGb300ProductName(productName: string): boolean {
  return /(?:^|[^A-Za-z0-9])Station[\s_-]+GB300(?:$|[^A-Za-z0-9])/iu.test(productName.trim());
}

function readTrimmedFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return null;
  }
}

export function discoverStationGb300SysfsReadOnlyPaths(
  productName: string,
  sysfsRoot = SYSFS_PATH,
): string[] {
  if (!isStationGb300ProductName(productName)) return [];

  const readOnlyPaths: string[] = [];
  const pciDevicesRoot = path.join(sysfsRoot, "bus", "pci", "devices");
  let pciDeviceNames: string[] = [];
  try {
    pciDeviceNames = fs.readdirSync(pciDevicesRoot).sort();
  } catch {
    // A Station image without PCI sysfs cannot use the scoped GPU exception.
  }
  for (const pciDeviceName of pciDeviceNames) {
    if (!PCI_BDF_PATTERN.test(pciDeviceName)) continue;
    const pciDeviceRoot = path.join(pciDevicesRoot, pciDeviceName);
    const vendor = readTrimmedFile(path.join(pciDeviceRoot, "vendor"))?.toLowerCase();
    const pciClass = readTrimmedFile(path.join(pciDeviceRoot, "class"));
    if (vendor === NVIDIA_PCI_VENDOR && pciClass && DISPLAY_PCI_CLASS_PATTERN.test(pciClass)) {
      readOnlyPaths.push(`${SYSFS_PATH}/bus/pci/devices/${pciDeviceName}`);
    }
  }
  if (readOnlyPaths.length === 0) {
    throw new Error(
      `Cannot prepare Station GB300 direct GPU sandbox policy; no NVIDIA display-class PCI device was found under ${pciDevicesRoot}.`,
    );
  }

  for (const relativePath of STATION_GB300_SHARED_SYSFS_RELATIVE_PATHS) {
    if (fs.existsSync(path.join(sysfsRoot, relativePath))) {
      readOnlyPaths.push(`${SYSFS_PATH}/${relativePath}`);
    }
  }
  return readOnlyPaths;
}

function discoverHostStationGb300SysfsReadOnlyPaths(): string[] {
  if (process.platform !== "linux") return [];
  const productName = readTrimmedFile(DMI_PRODUCT_NAME_PATH);
  return productName ? discoverStationGb300SysfsReadOnlyPaths(productName) : [];
}

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
  const sysfsReadOnlyPaths = [...(options.sysfsReadOnlyPaths ?? [])];
  const sysfsReadOnlyPathSet = new Set(sysfsReadOnlyPaths);
  // OpenShell adds /proc as read-write only after GPU devices are present.
  // Remove entries that would block that enrichment or be treated as literal paths.
  const readOnly = Array.isArray(fsPolicy.read_only)
    ? fsPolicy.read_only.map((entry: unknown) => String(entry))
    : [];
  const readWrite = deduplicateDirectGpuSysfsEntries(
    Array.isArray(fsPolicy.read_write)
      ? fsPolicy.read_write
          .map((entry: unknown) => String(entry))
          .filter((entry: string) => !isProcEntryOwnedByOpenShell(entry))
      : [],
    sysfsReadOnlyPathSet,
  );
  const readWriteSet = new Set(readWrite);
  fsPolicy.read_only = deduplicateDirectGpuSysfsEntries(
    readOnly.filter((entry: string) => !isProcEntryOwnedByOpenShell(entry)),
    sysfsReadOnlyPathSet,
  ).filter((entry: string) => !sysfsReadOnlyPathSet.has(entry) || !readWriteSet.has(entry));
  fsPolicy.read_write = readWrite;
  if (
    sysfsReadOnlyPaths.length > 0 &&
    !fsPolicy.read_only.includes(SYSFS_PATH) &&
    !fsPolicy.read_write.includes(SYSFS_PATH)
  ) {
    // CUDA reads PCI and host topology plus NVIDIA module initialization state
    // during cuInit(). Grant only those measured sysfs paths through Landlock;
    // no GPU path needs sysfs write access.
    const readOnlySet = new Set(fsPolicy.read_only);
    for (const candidate of sysfsReadOnlyPaths) {
      if (!readOnlySet.has(candidate) && !readWriteSet.has(candidate)) {
        fsPolicy.read_only.push(candidate);
        readOnlySet.add(candidate);
      }
    }
  }
  if (options.procReadWrite && !fsPolicy.read_write.includes(PROC_PATH)) {
    // This exists only for the legacy post-create Docker GPU compatibility
    // path, which recreates the container after `openshell sandbox create` and
    // prevents OpenShell from seeing `--gpu`. Mirror native /proc enrichment
    // until NemoClaw #4316 removes the recreation in
    // src/lib/onboard/docker-gpu-patch-finalize.ts; remove this grant when
    // native OpenShell GPU creation replaces that compatibility path.
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

function createPolicyTempCleanup(policyPath: string, expectedPrefix: string): () => boolean {
  return () => {
    try {
      cleanupTempDir(policyPath, expectedPrefix);
      return true;
    } catch {
      return false;
    }
  };
}

function prepareDirectGpuSandboxPolicy(
  basePolicyPath: string,
  options: DirectGpuPolicyOptions = {},
): InitialSandboxPolicy {
  const basePolicy = fs.readFileSync(basePolicyPath, "utf-8");
  const policyPath = secureTempFile("nemoclaw-gpu-policy", ".yaml");
  const cleanup = createPolicyTempCleanup(policyPath, "nemoclaw-gpu-policy");
  try {
    fs.writeFileSync(policyPath, buildDirectGpuPolicyYaml(basePolicy, options), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  return {
    policyPath,
    appliedPresets: [],
    cleanup,
  };
}

export function getNetworkPolicyNames(policyContent: string): Set<string> | null {
  try {
    const parsed = YAML.parse(policyContent);
    const networkPolicies = parsed?.network_policies;
    if (!networkPolicies || typeof networkPolicies !== "object" || Array.isArray(networkPolicies)) {
      return new Set();
    }
    return new Set(Object.keys(networkPolicies));
  } catch {
    return null;
  }
}

function filterHermesInactiveMessagingPolicies(
  policyContent: string,
  activeMessagingChannels: string[],
): { content: string; changed: boolean } {
  const parsed = YAML.parse(policyContent);
  if (!isObjectRecord(parsed) || !isObjectRecord(parsed.network_policies)) {
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
    stationGb300SysfsReadOnlyPaths?: readonly string[];
    additionalPresets?: string[];
    agentName?: string | null;
    policyTier?: string | null;
  } = {},
): InitialSandboxPolicy {
  const directGpuPolicy = options.directGpu
    ? prepareDirectGpuSandboxPolicy(basePolicyPath, {
        procReadWrite: options.dockerGpuPatch === true,
        sysfsReadOnlyPaths:
          options.stationGb300SysfsReadOnlyPaths ?? discoverHostStationGb300SysfsReadOnlyPaths(),
      })
    : null;
  let effectiveBasePolicyPath = directGpuPolicy?.policyPath || basePolicyPath;
  const cleanupFns = directGpuPolicy?.cleanup ? [directGpuPolicy.cleanup] : [];
  const buildCleanup = () =>
    cleanupFns.length > 0 ? () => cleanupFns.map((cleanup) => cleanup()).every(Boolean) : undefined;
  const cleanupOnError = () => {
    for (const cleanup of [...cleanupFns].reverse()) {
      try {
        cleanup();
      } catch {
        // Preserve the policy preparation error; cleanup is best effort and fail-closed upstream.
      }
    }
  };
  try {
    // Fail closed: the OpenClaw OTEL preset is added at create time only when the
    // selected policy tier is known and is not Restricted. When the tier is null
    // (interactive flow that selects later) the preset is deferred to the
    // post-boot policy step, so a later Restricted selection cannot leave a
    // transient host-local OTLP egress allowance during sandbox boot. The same
    // suppression filter still runs so an explicit `policyTier: "restricted"`
    // (non-interactive flow) drops openclaw-pricing from `additionalPresets`.
    const tierKnown = typeof options.policyTier === "string" && options.policyTier.length > 0;
    const otelCreateTimePresets =
      tierKnown && options.policyTier !== "restricted"
        ? requiredOpenclawOtelPolicyPresets(options.agentName ?? "openclaw")
        : [];
    const isHermesPolicyFromPath = isHermesPolicyPath(basePolicyPath);
    const isHermesPolicy = options.agentName === "hermes" || isHermesPolicyFromPath;
    const policyAgent = options.agentName ?? (isHermesPolicyFromPath ? "hermes" : null);
    const messagingCreateTimePresets = isHermesPolicy
      ? allMessagingChannelPolicyPresets(activeMessagingChannels)
      : requiredMessagingChannelPolicyPresets(activeMessagingChannels);
    const requestedCreateTimePresets = filterSuppressedAgentRequiredPresets(
      [
        ...new Set([
          ...messagingCreateTimePresets,
          ...otelCreateTimePresets,
          ...(options.additionalPresets || []),
        ]),
      ],
      options.policyTier ?? null,
      options.agentName ?? null,
    );
    const dedupe = (values: string[]) => [...new Set(values.filter(Boolean))];

    let basePolicy = fs.readFileSync(effectiveBasePolicyPath, "utf-8");
    if (isHermesPolicy) {
      const filtered = filterHermesInactiveMessagingPolicies(basePolicy, activeMessagingChannels);
      if (filtered.changed) {
        const policyPath = secureTempFile("nemoclaw-agent-policy", ".yaml");
        cleanupFns.push(createPolicyTempCleanup(policyPath, "nemoclaw-agent-policy"));
        fs.writeFileSync(policyPath, filtered.content, { encoding: "utf-8", mode: 0o600 });
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

    const mergedPolicy = policies.mergePresetNamesIntoPolicy(basePolicy, createTimePresets, {
      agent: policyAgent,
    });
    if (mergedPolicy.missingPresets.length > 0) {
      throw new Error(
        `Cannot prepare sandbox create policy; missing policy preset(s): ${mergedPolicy.missingPresets.join(", ")}`,
      );
    }

    const policyPath = secureTempFile("nemoclaw-initial-policy", ".yaml");
    cleanupFns.push(createPolicyTempCleanup(policyPath, "nemoclaw-initial-policy"));
    fs.writeFileSync(policyPath, mergedPolicy.policy, { encoding: "utf-8", mode: 0o600 });

    return {
      policyPath,
      appliedPresets: dedupe([
        ...existingChannelPresets,
        ...existingCreateTimePresets,
        ...mergedPolicy.appliedPresets,
      ]),
      cleanup: buildCleanup(),
    };
  } catch (error) {
    cleanupOnError();
    throw error;
  }
}
