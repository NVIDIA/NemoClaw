// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type OpenShellInstallResult = {
  installed?: boolean;
  localBin: string | null;
  futureShellPathHint: string | null;
};

export type OpenshellInstallVersionResolution =
  | { kind: "pin"; version: string; latest: string | null; reason: "latest" | "max-cap" }
  | { kind: "no-max"; latest: string | null }
  | { kind: "incompatible"; latest: string | null; max: string; message: string };

const SEMVER_TRIPLE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * Sanitize an OpenShell release tag from an external source (GitHub release tag
 * name, blueprint field, env var) into a plain `X.Y.Z` version string. Returns
 * null for empty, leading-`-`, or non-semver-triple inputs so callers never
 * pass malformed strings into version comparison logic.
 */
export function parseOpenshellReleaseTag(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  const trimmed = tag.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("-")) return null;
  const stripped = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  if (!SEMVER_TRIPLE.test(stripped)) return null;
  return stripped;
}

/**
 * Pure resolver for which OpenShell release the installer should fetch.
 *
 * - If `options.max` is null, returns `kind: "no-max"` so callers leave the
 *   install path alone (legacy behaviour — script picks its own pin / latest).
 * - Otherwise, picks the highest entry of `available` that is `<= max`.
 *   Returns `kind: "incompatible"` with a message naming both latest and max
 *   when no such release exists.
 *
 * Malformed entries in `available` (empty string, leading `-`, non-semver) are
 * silently dropped. The shipped blueprint guarantees `max` is valid before it
 * reaches this function, but a defensive parse is also applied here.
 */
export function resolveOpenshellInstallVersion(
  available: readonly string[],
  options: { max: string | null },
  helpers: { versionGte: (a: string, b: string) => boolean },
): OpenshellInstallVersionResolution {
  const sanitized = (available ?? [])
    .map((entry) => parseOpenshellReleaseTag(entry))
    .filter((entry): entry is string => entry !== null);
  sanitized.sort((a, b) => (helpers.versionGte(a, b) ? (a === b ? 0 : -1) : 1));
  const latest = sanitized[0] ?? null;

  const max = parseOpenshellReleaseTag(options.max);
  if (!max) {
    return { kind: "no-max", latest };
  }

  if (latest && helpers.versionGte(max, latest)) {
    return { kind: "pin", version: latest, latest, reason: "latest" };
  }

  const capped = sanitized.find((entry) => helpers.versionGte(max, entry));
  if (capped) {
    return { kind: "pin", version: capped, latest, reason: "max-cap" };
  }

  return {
    kind: "incompatible",
    latest,
    max,
    message:
      `No OpenShell release ≤ ${max} is available (latest published: ${latest ?? "unknown"}). ` +
      "Upgrade NemoClaw or raise max_openshell_version in nemoclaw-blueprint/blueprint.yaml.",
  };
}

export type DockerDriverBinaryOverrides = {
  gatewayBin?: string | null;
  sandboxBin?: string | null;
  vmDriverBin?: string | null;
};

export type OpenShellInstallDeps = {
  isLinuxDockerDriverGatewayEnabled: (
    platform?: NodeJS.Platform,
    arch?: NodeJS.Architecture,
  ) => boolean;
  resolveOpenShellGatewayBinary: () => string | null;
  resolveOpenShellSandboxBinary: () => string | null;
  resolveOpenShellVmDriverBinary: () => string | null;
  isOpenshellInstalled: () => boolean;
  installOpenshell: () => OpenShellInstallResult;
  getInstalledOpenshellVersion: (versionOutput?: string | null) => string | null;
  getBlueprintMinOpenshellVersion: () => string | null;
  getBlueprintMaxOpenshellVersion: () => string | null;
  runCaptureOpenshell: (args: string[], options?: { ignoreError?: boolean }) => string;
  shouldUseOpenshellDevChannel: () => boolean;
  isOpenshellDevVersion: (versionOutput: string | null) => boolean;
  versionGte: (a: string, b: string) => boolean;
  shouldAllowOpenshellAboveBlueprintMax: (versionOutput: string | null) => boolean;
  cliDisplayName: () => string;
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => never;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
};

export function areRequiredDockerDriverBinariesPresent(
  deps: Pick<
    OpenShellInstallDeps,
    | "isLinuxDockerDriverGatewayEnabled"
    | "resolveOpenShellGatewayBinary"
    | "resolveOpenShellSandboxBinary"
    | "resolveOpenShellVmDriverBinary"
  >,
  platform: NodeJS.Platform = process.platform,
  binaries: DockerDriverBinaryOverrides = {},
  arch: NodeJS.Architecture = process.arch,
): boolean {
  if (!deps.isLinuxDockerDriverGatewayEnabled(platform, arch)) return true;
  const gatewayBinary = Object.prototype.hasOwnProperty.call(binaries, "gatewayBin")
    ? binaries.gatewayBin
    : deps.resolveOpenShellGatewayBinary();
  const sandboxBinary = Object.prototype.hasOwnProperty.call(binaries, "sandboxBin")
    ? binaries.sandboxBin
    : deps.resolveOpenShellSandboxBinary();
  const vmDriverBinary = Object.prototype.hasOwnProperty.call(binaries, "vmDriverBin")
    ? binaries.vmDriverBin
    : deps.resolveOpenShellVmDriverBinary();
  if (!gatewayBinary) return false;
  if (platform === "linux" && !sandboxBinary) return false;
  if (platform === "darwin" && !vmDriverBinary) return false;
  return true;
}

export function ensureOpenshellForOnboard(deps: OpenShellInstallDeps): OpenShellInstallResult {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  let openshellInstall: OpenShellInstallResult = {
    localBin: null,
    futureShellPathHint: null,
  };

  if (!deps.isOpenshellInstalled()) {
    deps.log("  openshell CLI not found. Installing...");
    openshellInstall = deps.installOpenshell();
    if (!openshellInstall.installed) {
      deps.error("  Failed to install openshell CLI.");
      deps.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
      deps.exit(1);
    }
  } else {
    const currentVersion = deps.getInstalledOpenshellVersion();
    if (!currentVersion) {
      deps.log("  openshell version could not be determined. Reinstalling...");
      openshellInstall = deps.installOpenshell();
      if (!openshellInstall.installed) {
        deps.error("  Failed to reinstall openshell CLI.");
        deps.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
        deps.exit(1);
      }
    } else {
      const minOpenshellVersion = deps.getBlueprintMinOpenshellVersion() ?? "0.0.39";
      const currentVersionOutput = deps.runCaptureOpenshell(["--version"], { ignoreError: true });
      const needsDevChannel =
        deps.isLinuxDockerDriverGatewayEnabled(platform, arch) &&
        deps.shouldUseOpenshellDevChannel() &&
        !deps.isOpenshellDevVersion(currentVersionOutput);
      const needsDockerDriverBinaries =
        deps.isLinuxDockerDriverGatewayEnabled(platform, arch) &&
        !areRequiredDockerDriverBinariesPresent(deps, platform, {}, arch);
      const needsUpgrade =
        !deps.versionGte(currentVersion, minOpenshellVersion) ||
        needsDevChannel ||
        needsDockerDriverBinaries;
      if (needsUpgrade) {
        if (needsDevChannel) {
          deps.log("  OpenShell Docker-driver onboarding requires the dev channel. Upgrading...");
        } else if (needsDockerDriverBinaries) {
          const required =
            platform === "linux"
              ? "gateway and sandbox"
              : platform === "darwin"
                ? "gateway and VM driver"
                : "gateway";
          deps.log(
            `  OpenShell standalone gateway onboarding requires the ${required} binaries. Reinstalling...`,
          );
        } else {
          deps.log(`  openshell ${currentVersion} is below minimum required version. Upgrading...`);
        }
        openshellInstall = deps.installOpenshell();
        if (!openshellInstall.installed) {
          deps.error("  Failed to upgrade openshell CLI.");
          deps.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
          deps.exit(1);
        }
      }
    }
  }

  const openshellVersionOutput = deps.runCaptureOpenshell(["--version"], { ignoreError: true });
  deps.log(`  \u2713 openshell CLI: ${openshellVersionOutput || "unknown"}`);
  const installedOpenshellVersion = deps.getInstalledOpenshellVersion(openshellVersionOutput);
  const minOpenshellVersion = deps.getBlueprintMinOpenshellVersion();
  if (
    installedOpenshellVersion &&
    minOpenshellVersion &&
    !deps.versionGte(installedOpenshellVersion, minOpenshellVersion)
  ) {
    deps.error("");
    deps.error(
      `  \u2717 openshell ${installedOpenshellVersion} is below the minimum required by this NemoClaw release.`,
    );
    deps.error(`    blueprint.yaml min_openshell_version: ${minOpenshellVersion}`);
    deps.error("");
    deps.error("    Upgrade openshell and retry:");
    deps.error("      https://github.com/NVIDIA/OpenShell/releases");
    deps.error("    Or remove the existing binary so the installer can re-fetch a current build:");
    deps.error('      command -v openshell && rm -f "$(command -v openshell)"');
    deps.error("");
    deps.exit(1);
  }

  const maxOpenshellVersion = deps.getBlueprintMaxOpenshellVersion();
  if (
    installedOpenshellVersion &&
    maxOpenshellVersion &&
    !deps.versionGte(maxOpenshellVersion, installedOpenshellVersion) &&
    !deps.shouldAllowOpenshellAboveBlueprintMax(openshellVersionOutput)
  ) {
    deps.error("");
    deps.error(
      `  \u2717 openshell ${installedOpenshellVersion} is above the maximum supported by this NemoClaw release.`,
    );
    deps.error(`    blueprint.yaml max_openshell_version: ${maxOpenshellVersion}`);
    deps.error("");
    deps.error(
      `    Upgrade ${deps.cliDisplayName()} to a version that supports your OpenShell release,`,
    );
    deps.error("    or install a supported OpenShell version:");
    deps.error("      https://github.com/NVIDIA/OpenShell/releases");
    deps.error("");
    deps.exit(1);
  }

  if (openshellInstall.futureShellPathHint) {
    deps.log(
      `  Note: openshell was installed to ${openshellInstall.localBin} for this onboarding run.`,
    );
    deps.log(`  Future shells may still need: ${openshellInstall.futureShellPathHint}`);
    deps.log(
      "  Add that export to your shell profile, or open a new terminal before running openshell directly.",
    );
  }
  return openshellInstall;
}
