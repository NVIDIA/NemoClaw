// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { GATEWAY_PORT } from "../../core/ports";
import { resolveGatewayStateDirForPort } from "../../onboard/gateway-binding";
import { nemoclawStateRoot } from "../../state/state-root";

export const DEFAULT_GATEWAY_NAME = "nemoclaw";
export const NEMOCLAW_PROVIDERS = [
  "nvidia-nim",
  "vllm-local",
  "ollama-local",
  "nvidia-ncp",
  "nim-local",
] as const;
export const OPENSHELL_MANAGED_BINARIES = [
  "openshell",
  "openshell-gateway",
  "openshell-sandbox",
  "openshell-driver-vm",
] as const;

export interface UninstallPathOptions {
  gatewayStateDir?: string;
  home: string;
  repoRoot?: string;
  tmpDir?: string;
  xdgBinHome?: string;
}

/** Agent-alias CLI shims installed alongside `nemoclaw` (e.g. nemohermes). */
export const AGENT_ALIAS_CLI_BINARIES = ["nemohermes", "nemo-deepagents"] as const;

export interface UninstallPaths {
  helperServiceGlob: string;
  huggingFaceModelCacheDir: string;
  managedSwapMarkerPath: string;
  nemoclawConfigDir: string;
  nemoclawShimPath: string;
  /** Sibling agent-alias shims (nemohermes, nemo-deepagents) in the same bin dir. */
  agentAliasShimPaths: Array<{ binName: string; path: string }>;
  nemoclawStateDir: string;
  gatewayLocalStateDir: string;
  selectedGatewayLocalStateDir: string;
  openshellConfigDir: string;
  openshellInstallPaths: string[];
  repoRoot: string;
  runtimeTempGlobs: string[];
  shellProfilePaths: string[];
  nvmDir: string;
}

export function gatewayVolumeCandidates(gatewayName = DEFAULT_GATEWAY_NAME): string[] {
  return [`openshell-cluster-${gatewayName}`];
}

function openshellInstallPathsForBinDirs(binDirs: string[]): string[] {
  return binDirs.flatMap((binDir) =>
    OPENSHELL_MANAGED_BINARIES.map((binary) => path.join(binDir, binary)),
  );
}

export function defaultUninstallPaths(options: UninstallPathOptions): UninstallPaths {
  const xdgBinHome = options.xdgBinHome || path.join(options.home, ".local", "bin");
  const tmpDir = options.tmpDir || "/tmp";
  const gatewayLocalStateDir = path.join(options.home, ".local", "state", "nemoclaw");
  return {
    helperServiceGlob: path.join(tmpDir, "nemoclaw-services-*"),
    huggingFaceModelCacheDir: path.join(options.home, ".cache", "huggingface"),
    managedSwapMarkerPath: path.join(options.home, ".nemoclaw", "managed_swap"),
    nemoclawConfigDir: path.join(options.home, ".config", "nemoclaw"),
    nemoclawShimPath: path.join(options.home, ".local", "bin", "nemoclaw"),
    agentAliasShimPaths: AGENT_ALIAS_CLI_BINARIES.map((binName) => ({
      binName,
      path: path.join(options.home, ".local", "bin", binName),
    })),
    nemoclawStateDir: nemoclawStateRoot(options.home, GATEWAY_PORT),
    gatewayLocalStateDir,
    selectedGatewayLocalStateDir: resolveGatewayStateDirForPort({
      configured: options.gatewayStateDir,
      home: options.home,
      port: GATEWAY_PORT,
    }),
    openshellConfigDir: path.join(options.home, ".config", "openshell"),
    openshellInstallPaths: openshellInstallPathsForBinDirs(["/usr/local/bin", xdgBinHome]),
    repoRoot: options.repoRoot || path.resolve(__dirname, "..", "..", "..", ".."),
    runtimeTempGlobs: [
      path.join(tmpDir, "nemoclaw-create-*.log"),
      path.join(tmpDir, "nemoclaw-tg-ssh-*.conf"),
    ],
    shellProfilePaths: [
      path.join(options.home, ".bashrc"),
      path.join(options.home, ".zshrc"),
      path.join(options.home, ".profile"),
      path.join(options.home, ".config", "fish", "config.fish"),
      path.join(options.home, ".tcshrc"),
      path.join(options.home, ".cshrc"),
    ],
    nvmDir: path.join(options.home, ".nvm"),
  };
}

export function selectedGatewayStateDirIsWithinDefaultRoot(
  paths: Pick<UninstallPaths, "gatewayLocalStateDir" | "selectedGatewayLocalStateDir">,
): boolean {
  const relative = path.relative(
    path.resolve(paths.gatewayLocalStateDir),
    path.resolve(paths.selectedGatewayLocalStateDir),
  );
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function uninstallStatePaths(
  paths: Pick<
    UninstallPaths,
    | "gatewayLocalStateDir"
    | "nemoclawConfigDir"
    | "nemoclawStateDir"
    | "openshellConfigDir"
    | "selectedGatewayLocalStateDir"
  >,
): string[] {
  return [
    paths.nemoclawStateDir,
    paths.gatewayLocalStateDir,
    ...(selectedGatewayStateDirIsWithinDefaultRoot(paths)
      ? []
      : [paths.selectedGatewayLocalStateDir]),
    paths.openshellConfigDir,
    paths.nemoclawConfigDir,
  ];
}
