// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import YAML from "yaml";

import { isObjectRecord } from "../core/json-types";
import { getMessagingPolicyKeysByChannel } from "../messaging/channels";
import * as policies from "../policy";
import {
  applyBaselineExclusions,
  type BaselineExclusionRequest,
} from "../policy/baseline-exclusion";
import {
  collectPlatformIdentity,
  type PlatformIdentity,
} from "../readiness/platform-qualification";
import {
  isQualifiedStationProfile,
  isQualifiedStationRuntime,
  isStationGb300PciDevice,
  isStationGb300ProductName,
  type StationProfile,
} from "../readiness/station-qualification";
import {
  allMessagingChannelPolicyPresets,
  requiredMessagingChannelPolicyPresets,
} from "./messaging-policy-presets";
import { requiredOpenclawOtelPolicyPresets } from "./openclaw-otel-policy-presets";
import { filterSuppressedAgentRequiredPresets } from "./policy-tier-suppression";
import { cleanupTempDir, createExactTempFileCleanup, secureTempFile } from "./temp-files";
import { isPortableExperimentalProfile } from "./experimental/portable-profile";

export type InitialSandboxPolicy = {
  policyPath: string;
  appliedPresets: string[];
  /** Exact provider names referenced by credential-bound endpoints in this policy. */
  credentialBindingProviders?: string[];
  sourceBytes?: Buffer;
  cleanup?: () => boolean;
  cleanupExact?: () => boolean;
};

export function discloseInitialSandboxPolicy(policy: InitialSandboxPolicy): void {
  if (policy.appliedPresets.length === 0) return;
  console.log("  Including policy preset(s) at sandbox boot:", policy.appliedPresets.join(", "));
  policies.logPresetScope(
    policy.sourceBytes?.toString("utf8") ?? fs.readFileSync(policy.policyPath, "utf8"),
  );
}

const HERMES_MESSAGING_POLICY_KEYS = getMessagingPolicyKeysByChannel({ agent: "hermes" });

const PROC_PATH = "/proc";
const PROC_COMM_READ_WRITE_PATHS = ["/proc/self/comm", "/proc/self/task/*/comm"];
const SYSFS_PATH = "/sys";
const PCI_BDF_PATTERN = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/iu;
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

export { isStationGb300ProductName };

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
  stationProfile?: StationProfile | null,
): string[] {
  if (!isStationGb300ProductName(productName)) return [];
  if (stationProfile !== undefined && !isQualifiedStationProfile(stationProfile)) {
    throw new Error(
      "Cannot prepare Station GB300 direct GPU sandbox policy; the Station software profile is unsupported or unknown.",
    );
  }

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
    const device = readTrimmedFile(path.join(pciDeviceRoot, "device"))?.toLowerCase();
    const pciClass = readTrimmedFile(path.join(pciDeviceRoot, "class"));
    if (isStationGb300PciDevice(vendor, device, pciClass)) {
      readOnlyPaths.push(`${SYSFS_PATH}/bus/pci/devices/${pciDeviceName}`);
    }
  }
  if (readOnlyPaths.length === 0) {
    throw new Error(
      `Cannot prepare Station GB300 direct GPU sandbox policy; no exact NVIDIA GB300 PCI device was found under ${pciDevicesRoot}.`,
    );
  }

  for (const relativePath of STATION_GB300_SHARED_SYSFS_RELATIVE_PATHS) {
    if (fs.existsSync(path.join(sysfsRoot, relativePath))) {
      readOnlyPaths.push(`${SYSFS_PATH}/${relativePath}`);
    }
  }
  return readOnlyPaths;
}

export function discoverHostStationGb300SysfsReadOnlyPaths(
  options: {
    platform?: string;
    architecture?: string;
    hasNvidiaGpu?: boolean;
    identity?: PlatformIdentity;
    sysfsRoot?: string;
  } = {},
): string[] {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return [];
  const identity = options.identity ?? collectPlatformIdentity();
  if (identity.nvidiaPlatform !== "station") return [];
  if (!identity.productName || !isStationGb300ProductName(identity.productName)) {
    throw new Error(
      "Cannot prepare Station GB300 direct GPU sandbox policy; the detected Station product is not a qualified GB300 system.",
    );
  }
  if (!isQualifiedStationProfile(identity.stationProfile)) {
    throw new Error(
      "Cannot prepare Station GB300 direct GPU sandbox policy; the Station software profile is unsupported or unknown.",
    );
  }
  if (
    !isQualifiedStationRuntime({
      platform,
      architecture: options.architecture ?? process.arch,
      osId: identity.osId,
      osVersionId: identity.osVersionId,
      hasNvidiaGpu: options.hasNvidiaGpu ?? identity.stationGb300PciGpu === true,
    })
  ) {
    throw new Error(
      "Cannot prepare Station GB300 direct GPU sandbox policy; Linux ARM64, Ubuntu 24.04, and an available GB300 GPU are required.",
    );
  }
  return discoverStationGb300SysfsReadOnlyPaths(
    identity.productName,
    options.sysfsRoot ?? SYSFS_PATH,
    identity.stationProfile,
  );
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
  gatewayName?: string,
): DirectSandboxGpuProofCommand[] {
  const exec = ["sandbox", "exec", ...(gatewayName ? ["-g", gatewayName] : []), "-n", sandboxName];
  return [
    {
      id: "nvidia-smi",
      label: "nvidia-smi when available",
      args: [...exec, "--", "sh", "-lc", NVIDIA_SMI_OPTIONAL_PROBE],
    },
    {
      id: "proc-comm-write",
      label: "/proc/<pid>/task/<tid>/comm write",
      optional: true,
      args: [...exec, "--", "sh", "-lc", PROC_COMM_WRITE_PROBE],
    },
    {
      id: "cuda-init",
      label: "cuInit(0) via libcuda.so.1",
      optional: true,
      args: [...exec, "--", "sh", "-lc", CUDA_INIT_PROBE],
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

type InitialPolicyOptions = {
  directGpu?: boolean;
  dockerGpuPatch?: boolean;
  hostGpuAvailable?: boolean;
  stationGb300SysfsReadOnlyPaths?: readonly string[];
  additionalPresets?: string[];
  agentName?: string | null;
  sandboxName?: string;
  policyTier?: string | null;
  baselineExclusions?: readonly BaselineExclusionRequest[];
};

type PolicyMaterializer = (content: string, prefix: string) => InitialSandboxPolicy;

function createTempPolicyMaterializer(exactCleanup: boolean): PolicyMaterializer {
  return (content, prefix) => {
    const policyPath = secureTempFile(prefix, ".yaml");
    const cleanup = createPolicyTempCleanup(policyPath, prefix);
    try {
      fs.writeFileSync(policyPath, content, { encoding: "utf-8", mode: 0o600 });
    } catch (error) {
      cleanup();
      throw error;
    }
    return {
      policyPath,
      appliedPresets: [],
      cleanup,
      ...(exactCleanup ? { cleanupExact: createExactTempFileCleanup(policyPath, prefix) } : {}),
    };
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

function getCredentialBindingProviders(policyContent: string): string[] {
  const parsed = YAML.parse(policyContent);
  if (!isObjectRecord(parsed) || !isObjectRecord(parsed.network_policies)) return [];

  const providers = new Set<string>();
  for (const policy of Object.values(parsed.network_policies)) {
    if (!isObjectRecord(policy) || !Array.isArray(policy.endpoints)) continue;
    for (const endpoint of policy.endpoints) {
      if (!isObjectRecord(endpoint) || endpoint.credential_binding === undefined) continue;
      const binding = endpoint.credential_binding;
      if (
        !isObjectRecord(binding) ||
        typeof binding.provider !== "string" ||
        binding.provider.length === 0 ||
        binding.provider.trim() !== binding.provider
      ) {
        throw new Error(
          "Cannot prepare sandbox create policy; a credential binding has no exact provider name.",
        );
      }
      providers.add(binding.provider);
    }
  }
  return [...providers];
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

function resolveInitialSandboxCreatePolicy(
  basePolicyPath: string,
  activeMessagingChannels: string[],
  options: InitialPolicyOptions,
  resolution: {
    readonly materialize: PolicyMaterializer;
    readonly exactCleanup: boolean;
    readonly includeSourceBytes: boolean;
    readonly initialContent?: string;
  },
): InitialSandboxPolicy {
  const { materialize, exactCleanup, includeSourceBytes, initialContent } = resolution;
  let basePolicy = initialContent ?? fs.readFileSync(basePolicyPath, "utf-8");
  let effectivePolicy: InitialSandboxPolicy = {
    policyPath: basePolicyPath,
    appliedPresets: [],
    ...(includeSourceBytes ? { sourceBytes: Buffer.from(basePolicy) } : {}),
  };
  const cleanupFns: Array<() => boolean> = [];
  const exactCleanupFns: Array<() => boolean> = [];
  const adoptPolicy = (content: string, prefix: string): void => {
    const next = materialize(content, prefix);
    if (next.cleanup) cleanupFns.push(next.cleanup);
    if (next.cleanupExact) exactCleanupFns.push(next.cleanupExact);
    effectivePolicy = next;
    basePolicy = content;
  };
  if (options.directGpu) {
    adoptPolicy(
      buildDirectGpuPolicyYaml(basePolicy, {
        procReadWrite: options.dockerGpuPatch === true,
        sysfsReadOnlyPaths:
          options.stationGb300SysfsReadOnlyPaths ??
          discoverHostStationGb300SysfsReadOnlyPaths({
            hasNvidiaGpu: options.hostGpuAvailable,
          }),
      }),
      "nemoclaw-gpu-policy",
    );
  }
  const buildCleanup = () =>
    cleanupFns.length > 0 ? () => cleanupFns.map((cleanup) => cleanup()).every(Boolean) : undefined;
  const buildExactCleanup = () =>
    exactCleanupFns.length > 0
      ? () =>
          [...exactCleanupFns]
            .reverse()
            .map((cleanup) => cleanup())
            .every(Boolean)
      : undefined;
  const exactCleanupResult = () => (exactCleanup ? { cleanupExact: buildExactCleanup() } : {});
  const result = (appliedPresets: string[]): InitialSandboxPolicy => {
    const credentialBindingProviders = getCredentialBindingProviders(basePolicy);
    return {
      ...effectivePolicy,
      appliedPresets,
      ...(credentialBindingProviders.length > 0 ? { credentialBindingProviders } : {}),
      cleanup: buildCleanup(),
      ...exactCleanupResult(),
    };
  };
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

    if (isHermesPolicy) {
      const filtered = filterHermesInactiveMessagingPolicies(basePolicy, activeMessagingChannels);
      if (filtered.changed) {
        adoptPolicy(filtered.content, "nemoclaw-agent-policy");
      }
    }

    // Replay operator baseline exclusions before presets merge on top. Fails
    // closed via applyBaselineExclusions when a recorded approval no longer
    // matches the current baseline, so a changed release forces re-review.
    const baselineExclusions = options.baselineExclusions ?? [];
    if (baselineExclusions.length > 0) {
      const excluded = applyBaselineExclusions(
        basePolicy,
        baselineExclusions,
        policyAgent ?? "openclaw",
      );
      if (excluded.excludedKeys.length > 0) {
        adoptPolicy(excluded.content, "nemoclaw-agent-policy");
      }
    }

    const basePolicyNames = getNetworkPolicyNames(basePolicy);
    if (basePolicyNames === null) {
      return result([]);
    }
    const existingChannelPresets = activeMessagingChannels.filter((channel) =>
      basePolicyNames.has(channel),
    );

    if (requestedCreateTimePresets.length === 0) {
      return result(dedupe(existingChannelPresets));
    }

    const existingCreateTimePresets = requestedCreateTimePresets.filter((preset) =>
      basePolicyNames.has(preset),
    );
    const createTimePresets = requestedCreateTimePresets.filter(
      (preset) => !basePolicyNames.has(preset),
    );
    if (createTimePresets.length === 0) {
      return result(dedupe([...existingChannelPresets, ...existingCreateTimePresets]));
    }

    const mergedPolicy = policies.mergePresetNamesIntoPolicy(basePolicy, createTimePresets, {
      agent: policyAgent,
      sandboxName: options.sandboxName,
      excludedBaselineKeys: baselineExclusions.map((exclusion) => exclusion.key),
    });
    if (mergedPolicy.missingPresets.length > 0) {
      throw new Error(
        `Cannot prepare sandbox create policy; missing policy preset(s): ${mergedPolicy.missingPresets.join(", ")}`,
      );
    }

    adoptPolicy(mergedPolicy.policy, "nemoclaw-initial-policy");
    return result(
      dedupe([
        ...existingChannelPresets,
        ...existingCreateTimePresets,
        ...mergedPolicy.appliedPresets,
      ]),
    );
  } catch (error) {
    cleanupOnError();
    throw error;
  }
}

export function prepareInitialSandboxCreatePolicy(
  basePolicyPath: string,
  activeMessagingChannels: string[],
  options: InitialPolicyOptions = {},
): InitialSandboxPolicy {
  const exactCleanup = options.agentName === "hermes" && isPortableExperimentalProfile();
  return resolveInitialSandboxCreatePolicy(basePolicyPath, activeMessagingChannels, options, {
    materialize: createTempPolicyMaterializer(exactCleanup),
    exactCleanup,
    includeSourceBytes: false,
  });
}

function hasSafeHermesPortablePolicySourceMode(
  stat: { readonly gid: bigint; readonly mode: bigint; readonly uid: bigint },
  uid: number,
  gid: number,
  hostedInstallerMode: bigint,
): boolean {
  const permissions = stat.mode & 0o777n;
  if ((permissions & 0o002n) !== 0n) return false;
  if ((permissions & 0o020n) === 0n) return true;
  return (
    (stat.mode & 0o7777n) === hostedInstallerMode &&
    stat.uid === BigInt(uid) &&
    stat.gid === BigInt(gid)
  );
}

/** Read one policy source while holding exact current-user file authority. */
export function readHermesPortableInitialPolicySource(basePolicyPath: string): string {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("Hermes portable policy source has no current-user authority.");
  }
  const parentPath = path.dirname(basePolicyPath);
  const parentBefore = fs.lstatSync(parentPath, { bigint: true });
  const named = fs.lstatSync(basePolicyPath, { bigint: true });
  if (
    !parentBefore.isDirectory() ||
    parentBefore.isSymbolicLink() ||
    (parentBefore.uid !== 0n && parentBefore.uid !== BigInt(uid)) ||
    !hasSafeHermesPortablePolicySourceMode(parentBefore, uid, gid, 0o775n) ||
    !named.isFile() ||
    named.isSymbolicLink()
  ) {
    throw new Error("Hermes portable policy source authority is unsafe.");
  }
  const descriptor = fs.openSync(
    basePolicyPath,
    fs.constants.O_RDONLY |
      fs.constants.O_NOFOLLOW |
      (typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0),
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      (before.uid !== 0n && before.uid !== BigInt(uid)) ||
      !hasSafeHermesPortablePolicySourceMode(before, uid, gid, 0o664n) ||
      before.size < 1n ||
      before.size > 256n * 1024n ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    ) {
      throw new Error("Hermes portable policy source authority is unsafe.");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const finalNamed = fs.lstatSync(basePolicyPath, { bigint: true });
    const parentAfter = fs.lstatSync(parentPath, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.gid !== after.gid ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      finalNamed.dev !== after.dev ||
      finalNamed.ino !== after.ino ||
      parentBefore.dev !== parentAfter.dev ||
      parentBefore.ino !== parentAfter.ino ||
      parentBefore.mode !== parentAfter.mode ||
      parentBefore.uid !== parentAfter.uid ||
      parentBefore.gid !== parentAfter.gid ||
      parentBefore.mtimeNs !== parentAfter.mtimeNs ||
      parentBefore.ctimeNs !== parentAfter.ctimeNs ||
      BigInt(bytes.byteLength) !== after.size
    ) {
      throw new Error("Hermes portable policy source authority changed while reading.");
    }
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new Error("Hermes portable policy source must not include a UTF-8 byte-order mark.");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Hermes portable policy source is not strict UTF-8.");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Plan exact schema-5 policy bytes without creating temporary files. */
export function planHermesPortableInitialSandboxPolicy(
  basePolicyPath: string,
  activeMessagingChannels: string[],
  options: InitialPolicyOptions,
): InitialSandboxPolicy {
  if (options.agentName !== "hermes" || !isPortableExperimentalProfile()) {
    throw new Error("Hermes portable policy planning requires the schema-5 profile.");
  }
  return resolveInitialSandboxCreatePolicy(basePolicyPath, activeMessagingChannels, options, {
    materialize: (content) => ({
      policyPath: basePolicyPath,
      sourceBytes: Buffer.from(content),
      appliedPresets: [],
    }),
    exactCleanup: false,
    includeSourceBytes: true,
    initialContent: readHermesPortableInitialPolicySource(basePolicyPath),
  });
}
