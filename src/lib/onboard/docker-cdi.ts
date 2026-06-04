// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { dockerInfoFormat } from "../adapters/docker";
import { shellQuote } from "../core/shell-quote";

export type RunCaptureFn = typeof import("../runner").runCapture;

export type NvidiaCdiRepairAssessment = {
  cdiNvidiaGpuSpecMissing?: boolean;
  cdiNvidiaGpuSpecStale?: boolean;
  cdiNvidiaGpuSpecMismatch?: string;
  cdiNvidiaGpuRefreshUnhealthy?: boolean;
  dockerCdiSpecDirs: string[];
  nvidiaCdiRefreshPathEnabled?: boolean | null;
  nvidiaCdiRefreshPathActive?: boolean | null;
  nvidiaCdiRefreshServiceFailed?: boolean | null;
  systemctlAvailable?: boolean;
};

export type NvidiaCdiHostAssessmentOpts = {
  dockerInfoOutput?: string;
  dockerReachable: boolean;
  hasNvidiaGpu: boolean;
  isWsl: boolean;
  nvidiaContainerToolkitInstalled: boolean;
  platform: NodeJS.Platform | string;
  readFileImpl: (filePath: string, encoding: BufferEncoding) => string;
  readdirImpl: (dir: string) => string[];
  runCaptureImpl: RunCaptureFn;
  runtime: string;
  systemctlAvailable?: boolean;
};

export type NvidiaCdiHostAssessment = {
  dockerCdiSpecDirs: string[];
  cdiNvidiaGpuSpecMissing: boolean;
  cdiNvidiaGpuSpecStale: boolean;
  cdiNvidiaGpuSpecMismatch?: string;
  cdiNvidiaGpuRefreshUnhealthy: boolean;
  cdiNvidiaGpuSpecNeedsRepair: boolean;
  nvidiaCdiRefreshPathActive: boolean | null;
  nvidiaCdiRefreshPathEnabled: boolean | null;
  nvidiaCdiRefreshServiceEnabled: boolean | null;
  nvidiaCdiRefreshServiceFailed: boolean | null;
};

type DeviceNumbers = { major: number; minor: number };

type CdiDeviceNode = DeviceNumbers & {
  filePath: string;
  path: string;
};

type EffectiveNvidiaCdiSpec = {
  filePath: string;
  parsed: unknown;
};

const NVIDIA_CDI_KIND_YAML_RE =
  /^[ \t]*kind[ \t]*:[ \t]*(?:"nvidia\.com\/gpu"|'nvidia\.com\/gpu'|nvidia\.com\/gpu)[ \t]*(?:#.*)?$/im;
const NVIDIA_CDI_KIND_JSON_RE = /"kind"\s*:\s*"nvidia\.com\/gpu"/;
const NVIDIA_CDI_REFRESH_SPEC_PATH = "/var/run/cdi/nvidia.yaml";

export function parseDockerCdiSpecDirs(value: string | null | undefined): string[] {
  const raw = String(value || "").trim();
  if (!raw || raw === "<no value>") return [];
  try {
    const parsed = JSON.parse(raw);
    const dirs: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray(parsed.CDISpecDirs)
        ? parsed.CDISpecDirs
        : [];
    return dirs.map((entry) => String(entry || "").trim()).filter(Boolean);
  } catch {
    return raw
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
}

export function getDockerCdiSpecDirs(): string[] {
  return parseDockerCdiSpecDirs(
    dockerInfoFormat("{{json .CDISpecDirs}}", { ignoreError: true }),
  );
}

function normalizeCdiSpecDir(specDir: string | undefined): string {
  const trimmed = String(specDir || "/etc/cdi")
    .trim()
    .replace(/\/+$/, "");
  return trimmed || "/etc/cdi";
}

export function getNvidiaCdiSpecPath(
  assessment: Pick<NvidiaCdiRepairAssessment, "dockerCdiSpecDirs">,
): string {
  return path.join(normalizeCdiSpecDir(assessment.dockerCdiSpecDirs[0]), "nvidia.yaml");
}

function isLikelyNvidiaCdiSpecFile(filePath: string): boolean {
  if (!/\.(json|ya?ml)$/i.test(filePath)) return false;
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }
  return /nvidia\.com\/gpu|nvidia-container|libcuda|cuda/i.test(content);
}

export function findReadableNvidiaCdiSpecFiles(dirs: string[]): string[] {
  const specs: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry);
      if (isLikelyNvidiaCdiSpecFile(candidate)) specs.push(candidate);
    }
  }
  return specs.sort();
}

export function hasNvidiaCdiSpec(
  specDirs: readonly string[],
  readdirImpl: (dir: string) => string[],
  readFileImpl: (filePath: string, encoding: BufferEncoding) => string,
): boolean {
  for (const dir of specDirs) {
    let entries: string[];
    try {
      entries = readdirImpl(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/\.(ya?ml|json)$/i.test(entry)) continue;
      let raw: string;
      try {
        raw = readFileImpl(path.join(dir, entry), "utf-8");
      } catch {
        continue;
      }
      if (NVIDIA_CDI_KIND_YAML_RE.test(raw) || NVIDIA_CDI_KIND_JSON_RE.test(raw)) return true;
    }
  }
  return false;
}

function parseIntegerLike(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const base = /^0x/i.test(trimmed) ? 16 : 10;
  const parsed = Number.parseInt(trimmed, base);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseLinuxStatDeviceNumbers(output: string | null | undefined): DeviceNumbers | null {
  const parts = String(output || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 2) return null;
  const major = Number.parseInt(parts[0], 16);
  const minor = Number.parseInt(parts[1], 16);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 0 || minor < 0) {
    return null;
  }
  return { major, minor };
}

function readLiveLinuxDeviceNumbers(
  devicePath: string,
  runCaptureImpl: RunCaptureFn,
): DeviceNumbers | null {
  try {
    return parseLinuxStatDeviceNumbers(
      runCaptureImpl(["stat", "-c", "%t %T", devicePath], { ignoreError: true }),
    );
  } catch {
    return null;
  }
}

function parseCdiSpec(raw: string, filePath: string): unknown {
  if (/\.json$/i.test(filePath)) return JSON.parse(raw);
  const YAML = require("yaml");
  return YAML.parse(raw);
}

export function findEffectiveNvidiaCdiSpec(
  specDirs: readonly string[],
  readdirImpl: (dir: string) => string[],
  readFileImpl: (filePath: string, encoding: BufferEncoding) => string,
): EffectiveNvidiaCdiSpec | null {
  // Docker CDI precedence is highest in the last configured directory.
  for (const dir of [...specDirs].reverse()) {
    let entries: string[];
    try {
      entries = readdirImpl(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/\.(ya?ml|json)$/i.test(entry)) continue;
      const filePath = path.join(dir, entry);
      let raw: string;
      try {
        raw = readFileImpl(filePath, "utf-8");
      } catch {
        continue;
      }
      if (!NVIDIA_CDI_KIND_YAML_RE.test(raw) && !NVIDIA_CDI_KIND_JSON_RE.test(raw)) {
        continue;
      }
      try {
        return { filePath, parsed: parseCdiSpec(raw, filePath) };
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function collectCdiDeviceNodes(value: unknown, filePath: string): CdiDeviceNode[] {
  const nodes: CdiDeviceNode[] = [];
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (!current || typeof current !== "object") continue;
    const obj = current as Record<string, unknown>;
    // We stat the host device, so prefer CDI's host-side path when present.
    const nodePath =
      (typeof obj.hostPath === "string" && obj.hostPath) ||
      (typeof obj.path === "string" && obj.path) ||
      "";
    const major = parseIntegerLike(obj.major);
    if (nodePath.startsWith("/dev/") && major !== null) {
      const minor = obj.minor === undefined ? 0 : parseIntegerLike(obj.minor);
      if (minor !== null) nodes.push({ filePath, path: nodePath, major, minor });
    }
    for (const child of Object.values(obj)) stack.push(child);
  }

  return nodes;
}

export function findCdiDeviceNodeMismatch(
  specDirs: readonly string[],
  readdirImpl: (dir: string) => string[],
  readFileImpl: (filePath: string, encoding: BufferEncoding) => string,
  runCaptureImpl: RunCaptureFn,
): string | null {
  const effective = findEffectiveNvidiaCdiSpec(specDirs, readdirImpl, readFileImpl);
  if (!effective) return null;
  for (const node of collectCdiDeviceNodes(effective.parsed, effective.filePath)) {
    const liveDevice = readLiveLinuxDeviceNumbers(node.path, runCaptureImpl);
    if (!liveDevice) continue;
    if (node.major === liveDevice.major && node.minor === liveDevice.minor) continue;
    return `${node.filePath} ${node.path}=${node.major}:${node.minor}, live=${liveDevice.major}:${liveDevice.minor}`;
  }
  return null;
}

function parseSystemctlState(value = ""): boolean | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (normalized === "active" || normalized === "enabled") return true;
  if (
    normalized === "inactive" ||
    normalized === "failed" ||
    normalized === "disabled" ||
    normalized === "masked"
  ) {
    return false;
  }
  return null;
}

function parseSystemctlFailedState(value = ""): boolean | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (normalized === "failed") return true;
  if (normalized === "active" || normalized === "inactive") return false;
  return null;
}

export function assessNvidiaCdiHost(opts: NvidiaCdiHostAssessmentOpts): NvidiaCdiHostAssessment {
  const dockerCdiSpecDirs = opts.dockerReachable
    ? parseDockerCdiSpecDirs(opts.dockerInfoOutput)
    : [];
  const cdiSpecPresenceApplies =
    opts.platform === "linux" && opts.hasNvidiaGpu && dockerCdiSpecDirs.length > 0;
  const cdiSpecRepairApplies =
    cdiSpecPresenceApplies && !(opts.isWsl && opts.runtime === "docker-desktop");
  const cdiNvidiaGpuSpecPresent =
    cdiSpecPresenceApplies &&
    hasNvidiaCdiSpec(dockerCdiSpecDirs, opts.readdirImpl, opts.readFileImpl);
  const cdiNvidiaGpuSpecMissing = cdiSpecPresenceApplies && !cdiNvidiaGpuSpecPresent;
  const refreshHealthApplies =
    cdiSpecRepairApplies &&
    Boolean(opts.systemctlAvailable) &&
    opts.nvidiaContainerToolkitInstalled;
  const nvidiaCdiRefreshPathEnabled = refreshHealthApplies
    ? parseSystemctlState(
        opts.runCaptureImpl(["systemctl", "is-enabled", "nvidia-cdi-refresh.path"], {
          ignoreError: true,
        }),
      )
    : null;
  const nvidiaCdiRefreshPathActive = refreshHealthApplies
    ? parseSystemctlState(
        opts.runCaptureImpl(["systemctl", "is-active", "nvidia-cdi-refresh.path"], {
          ignoreError: true,
        }),
      )
    : null;
  const nvidiaCdiRefreshServiceEnabled = refreshHealthApplies
    ? parseSystemctlState(
        opts.runCaptureImpl(["systemctl", "is-enabled", "nvidia-cdi-refresh.service"], {
          ignoreError: true,
        }),
      )
    : null;
  const nvidiaCdiRefreshServiceFailed = refreshHealthApplies
    ? parseSystemctlFailedState(
        opts.runCaptureImpl(["systemctl", "is-failed", "nvidia-cdi-refresh.service"], {
          ignoreError: true,
        }),
      )
    : null;
  const cdiNvidiaGpuRefreshUnhealthy =
    nvidiaCdiRefreshPathEnabled === false ||
    nvidiaCdiRefreshPathActive === false ||
    nvidiaCdiRefreshServiceFailed === true;
  const cdiNvidiaGpuSpecMismatch =
    cdiSpecRepairApplies && cdiNvidiaGpuSpecPresent
      ? findCdiDeviceNodeMismatch(
          dockerCdiSpecDirs,
          opts.readdirImpl,
          opts.readFileImpl,
          opts.runCaptureImpl,
        )
      : null;
  const cdiNvidiaGpuSpecStale = Boolean(cdiNvidiaGpuSpecMismatch);

  return {
    dockerCdiSpecDirs,
    cdiNvidiaGpuSpecMissing,
    cdiNvidiaGpuSpecStale,
    cdiNvidiaGpuSpecMismatch: cdiNvidiaGpuSpecMismatch ?? undefined,
    cdiNvidiaGpuRefreshUnhealthy,
    cdiNvidiaGpuSpecNeedsRepair: cdiNvidiaGpuSpecMissing || cdiNvidiaGpuSpecStale,
    nvidiaCdiRefreshPathActive,
    nvidiaCdiRefreshPathEnabled,
    nvidiaCdiRefreshServiceEnabled,
    nvidiaCdiRefreshServiceFailed,
  };
}

export function buildNvidiaCdiRepairCommands(
  assessment: Pick<NvidiaCdiRepairAssessment, "systemctlAvailable">,
  specPath: string,
): string[] {
  const specDir = path.dirname(specPath);
  const quotedSpecDir = shellQuote(specDir);
  const quotedSpecPath = shellQuote(specPath);
  const commands = [`sudo mkdir -p ${quotedSpecDir}`];
  if (assessment.systemctlAvailable !== false) {
    commands.push(
      "sudo systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service",
      "sudo systemctl start nvidia-cdi-refresh.service",
      "nvidia-ctk cdi list   # verify nvidia.com/gpu entries appear",
    );
  }
  commands.push(
    `sudo nvidia-ctk cdi generate --output=${quotedSpecPath}   # fallback if the refresh service does not repair the spec`,
    "nvidia-ctk cdi list   # verify nvidia.com/gpu entries appear",
    "nemoclaw onboard      # or rerun with --no-gpu to skip GPU passthrough",
  );
  return commands;
}

export function buildNvidiaCdiRefreshCommands(): string[] {
  return [
    "sudo systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service",
    "sudo systemctl start nvidia-cdi-refresh.service",
    "nvidia-ctk cdi list   # verify nvidia.com/gpu entries appear",
  ];
}

export function extractCdiMismatchFilePath(mismatch: string | undefined): string {
  const trimmed = String(mismatch || "").trim();
  if (!trimmed) return "";
  const firstWhitespace = trimmed.search(/\s/);
  return firstWhitespace > 0 ? trimmed.slice(0, firstWhitespace) : trimmed;
}

export function buildStaleCdiAutoFixCommands(): string[] {
  return [
    "sudo systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service",
    "sudo systemctl start nvidia-cdi-refresh.service",
  ];
}

export function buildStaleCdiWarnCommands(flaggedFilePath: string): string[] {
  const commands = buildStaleCdiAutoFixCommands();
  if (flaggedFilePath && flaggedFilePath !== NVIDIA_CDI_REFRESH_SPEC_PATH) {
    const quotedFlaggedFilePath = shellQuote(flaggedFilePath);
    commands.push(
      `sudo rm -f ${quotedFlaggedFilePath}   # optional: remove the stale leftover (the service owns ${NVIDIA_CDI_REFRESH_SPEC_PATH})`,
    );
  }
  commands.push(
    "nemoclaw onboard      # re-run to confirm the stale-spec warning clears (or --no-gpu to skip GPU)",
  );
  return commands;
}

export function buildStaleCdiManualWarnCommands(flaggedFilePath: string): string[] {
  const commands = [
    `Refresh NVIDIA CDI specs using your host's service manager so ${NVIDIA_CDI_REFRESH_SPEC_PATH} is current.`,
  ];
  if (flaggedFilePath && flaggedFilePath !== NVIDIA_CDI_REFRESH_SPEC_PATH) {
    const quotedFlaggedFilePath = shellQuote(flaggedFilePath);
    commands.push(
      `Optionally remove the stale leftover after the refresh: sudo rm -f ${quotedFlaggedFilePath}`,
    );
  }
  commands.push(
    "nemoclaw onboard      # re-run to confirm the stale-spec warning clears (or --no-gpu to skip GPU)",
  );
  return commands;
}

export function explainStaleCdiReason(mismatch: string | undefined): string {
  const detail = mismatch || "unknown device-node mismatch";
  const flaggedFilePath = extractCdiMismatchFilePath(mismatch);
  const isLeftover = flaggedFilePath && flaggedFilePath !== NVIDIA_CDI_REFRESH_SPEC_PATH;
  return (
    `An NVIDIA CDI device node no longer matches the live device (${detail}). ` +
    "OpenShell's `gateway start --gpu` injects devices from the CDI spec, so a stale " +
    "device number points the container at the wrong device and CUDA init fails " +
    "(`CUDA unknown error`). The nvidia-cdi-refresh service keeps " +
    `${NVIDIA_CDI_REFRESH_SPEC_PATH} current on driver/toolkit changes` +
    (isLeftover
      ? `; the flagged ${flaggedFilePath} is a stale leftover that the refreshed ` +
        `${NVIDIA_CDI_REFRESH_SPEC_PATH} overrides.`
      : "; re-enable and run it to regenerate the spec.")
  );
}

export function explainNvidiaCdiRepairReason(assessment: NvidiaCdiRepairAssessment): string {
  const reasons: string[] = [];
  if (assessment.cdiNvidiaGpuSpecMissing) {
    reasons.push(
      "Docker is configured for CDI device injection (CDISpecDirs is set) but no nvidia.com/gpu CDI spec is present on the host.",
    );
  }
  if (assessment.cdiNvidiaGpuSpecStale) {
    const detail = assessment.cdiNvidiaGpuSpecMismatch
      ? ` (${assessment.cdiNvidiaGpuSpecMismatch})`
      : "";
    reasons.push(
      `The NVIDIA CDI spec appears stale because a declared device node does not match the live device${detail}.`,
    );
  }
  if (assessment.cdiNvidiaGpuRefreshUnhealthy) {
    const unitDetails: string[] = [];
    if (assessment.nvidiaCdiRefreshPathEnabled === false) unitDetails.push("path disabled");
    if (assessment.nvidiaCdiRefreshPathActive === false) unitDetails.push("path inactive");
    if (assessment.nvidiaCdiRefreshServiceFailed === true) unitDetails.push("service failed");
    const suffix = unitDetails.length > 0 ? ` (${unitDetails.join(", ")})` : "";
    reasons.push(
      `NVIDIA's CDI refresh units are not healthy${suffix}, so Docker may keep using stale GPU device numbers after driver changes.`,
    );
  }
  reasons.push(
    "OpenShell's `gateway start --gpu` can fail until the CDI spec is refreshed and verified.",
  );
  return reasons.join(" ");
}
