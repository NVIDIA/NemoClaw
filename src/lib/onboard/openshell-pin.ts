// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  type OpenShellInstallResult,
  type OpenshellInstallVersionResolution,
  resolveOpenshellInstallVersion,
} from "./openshell-install";

const GH_LIMIT = 1000;
const PER_PAGE = 100;
const PAGE_BUDGET = 10;

type ReleaseFetcher = () => string[] | null;

export type OpenshellInstallPinDeps = {
  getBlueprintMinOpenshellVersion?: () => string | null;
  getBlueprintMaxOpenshellVersion: () => string | null;
  versionGte: (a: string, b: string) => boolean;
  listReleases?: ReleaseFetcher;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type OpenshellInstallEnvDirective =
  | { env: NodeJS.ProcessEnv }
  | { env: null };

export type OpenshellInstallPinResult =
  | { kind: "pin"; version: string; latest: string | null; reason: "latest" | "max-cap" }
  | { kind: "no-max" }
  | { kind: "incompatible"; message: string };

/**
 * List published OpenShell release tags. Returns `null` on any fetch failure
 * (gh missing, curl failure, network down) so callers fall back to the legacy
 * install path. Pages beyond `PER_PAGE` results so the resolver does not miss
 * older compatible releases once the repo exceeds one page (#3446 review).
 */
export function listOpenshellReleaseTags(): string[] | null {
  const ghTags = listOpenshellReleaseTagsViaGh();
  if (ghTags !== null) return ghTags;
  return listOpenshellReleaseTagsViaCurl();
}

function listOpenshellReleaseTagsViaGh(): string[] | null {
  const options: SpawnSyncOptionsWithStringEncoding = {
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "",
    },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  };
  const result = spawnSync(
    "gh",
    [
      "release",
      "list",
      "--repo",
      "NVIDIA/OpenShell",
      "--limit",
      String(GH_LIMIT),
      "--json",
      "tagName",
    ],
    options,
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((entry) => (entry && typeof entry.tagName === "string" ? entry.tagName : null))
      .filter((tag): tag is string => tag !== null);
  } catch {
    return null;
  }
}

function listOpenshellReleaseTagsViaCurl(): string[] | null {
  const tags: string[] = [];
  for (let page = 1; page <= PAGE_BUDGET; page += 1) {
    const result = spawnSync(
      "curl",
      [
        "-fsSL",
        "-H",
        "Accept: application/vnd.github+json",
        `https://api.github.com/repos/NVIDIA/OpenShell/releases?per_page=${PER_PAGE}&page=${page}`,
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
    );
    // Any per-page failure invalidates the whole list — a partial result
    // could let the resolver wrongly return `incompatible` because an older
    // compatible release on a missing page is invisible to it. Returning
    // null lets the caller fall back to the script's legacy behaviour
    // (#3446 CodeRabbit).
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) break;
    for (const entry of parsed) {
      if (entry && typeof (entry as { tag_name?: unknown }).tag_name === "string") {
        tags.push((entry as { tag_name: string }).tag_name);
      }
    }
    if (parsed.length < PER_PAGE) break;
  }
  return tags;
}

/**
 * Resolve which OpenShell release to pin the installer to. Orchestrates the
 * GitHub fetch and the pure resolver. Returns a result that the caller can map
 * to env var / error / no-op without itself touching the network.
 *
 * When the GitHub query fails (offline, gh missing), returns `kind: "no-max"`
 * so the shell installer falls back to its hardcoded pin. The blueprint's
 * upper-bound is still enforced post-install by the existing gate, so a stale
 * fetch never silently raises the cap.
 */
export function resolveOpenshellInstallPin(
  deps: OpenshellInstallPinDeps,
): OpenshellInstallPinResult {
  const maxVersion = deps.getBlueprintMaxOpenshellVersion();
  if (!maxVersion) return { kind: "no-max" };
  const releases = (deps.listReleases ?? listOpenshellReleaseTags)();
  if (releases === null || releases.length === 0) return { kind: "no-max" };
  const resolution: OpenshellInstallVersionResolution = resolveOpenshellInstallVersion(
    releases,
    { max: maxVersion },
    { versionGte: deps.versionGte },
  );
  if (resolution.kind === "pin") {
    if (resolution.reason === "max-cap" && deps.log) {
      deps.log(
        `  Pinning OpenShell to ${resolution.version} (latest ${resolution.latest ?? "unknown"} exceeds blueprint max ${maxVersion})`,
      );
    }
    return {
      kind: "pin",
      version: resolution.version,
      latest: resolution.latest,
      reason: resolution.reason,
    };
  }
  if (resolution.kind === "incompatible") {
    return { kind: "incompatible", message: resolution.message };
  }
  return { kind: "no-max" };
}

/**
 * Compose the resolution with side-effects so the caller can map a single
 * value into the `spawnSync` call: `env` is the env to pass through, or
 * `null` to abort (the helper has already logged a clear error in that case).
 */
export function computeOpenshellInstallEnv(
  baseEnv: NodeJS.ProcessEnv,
  deps: OpenshellInstallPinDeps,
): OpenshellInstallEnvDirective {
  const pin = resolveOpenshellInstallPin(deps);
  if (pin.kind === "incompatible") {
    const error = deps.error ?? ((m: string) => console.error(m));
    error("");
    error(`  ✗ ${pin.message}`);
    error("");
    return { env: null };
  }
  const overlay: NodeJS.ProcessEnv = {};
  const blueprintMin = deps.getBlueprintMinOpenshellVersion?.() ?? null;
  const blueprintMax = deps.getBlueprintMaxOpenshellVersion();
  if (blueprintMin) overlay.NEMOCLAW_OPENSHELL_MIN_VERSION = blueprintMin;
  if (blueprintMax) overlay.NEMOCLAW_OPENSHELL_MAX_VERSION = blueprintMax;
  if (pin.kind === "pin") overlay.NEMOCLAW_OPENSHELL_PIN_VERSION = pin.version;
  return Object.keys(overlay).length === 0
    ? { env: baseEnv }
    : { env: { ...baseEnv, ...overlay } };
}

export type RunOpenshellInstallDeps = OpenshellInstallPinDeps & {
  scriptsDir: string;
  cwd: string;
  resolveOpenshell: () => string | null;
  getFutureShellPathHint: (binDir: string, pathValue?: string) => string | null;
  setOpenshellBin: (binPath: string | null) => void;
};

/**
 * Execute `scripts/install-openshell.sh`, wiring in the blueprint-driven pin
 * resolution and the host-side state updates onboard.ts cares about (binary
 * path, PATH augmentation, `OPENSHELL_BIN` cache). Lives in this submodule so
 * the top-level onboard entrypoint stays net-neutral (#3404 follow-up).
 */
export function runOpenshellInstall(deps: RunOpenshellInstallDeps): OpenShellInstallResult {
  const { env } = computeOpenshellInstallEnv(process.env, deps);
  if (env === null) return { installed: false, localBin: null, futureShellPathHint: null };
  const result = spawnSync("bash", [path.join(deps.scriptsDir, "install-openshell.sh")], {
    cwd: deps.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 300_000,
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (output) console.error(output);
    return { installed: false, localBin: null, futureShellPathHint: null };
  }
  const localBin = process.env.XDG_BIN_HOME || path.join(process.env.HOME || "", ".local", "bin");
  const openshellPath = path.join(localBin, "openshell");
  const futureShellPathHint = fs.existsSync(openshellPath)
    ? deps.getFutureShellPathHint(localBin, process.env.PATH)
    : null;
  if (fs.existsSync(openshellPath) && futureShellPathHint) {
    process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH}`;
  }
  const bin = deps.resolveOpenshell();
  deps.setOpenshellBin(bin);
  if (bin) process.env.NEMOCLAW_OPENSHELL_BIN = bin;
  return { installed: bin !== null, localBin, futureShellPathHint };
}
