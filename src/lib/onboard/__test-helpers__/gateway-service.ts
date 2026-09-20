// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type { SpawnSyncLikeResult } from "../docker-driver-gateway-service";

export function spawnResult(status = 0, stderr = "", stdout = ""): SpawnSyncLikeResult {
  return { status, stderr, stdout };
}

export function trustedShowOutput(
  fragmentPath = "/lib/systemd/user/openshell-gateway.service",
  execPath = "/usr/bin/openshell-gateway",
): string {
  return [
    `FragmentPath=${fragmentPath}`,
    `ExecStart={ path=${execPath} ; argv[]=${execPath} ; }`,
  ].join("\n");
}

export function nonSymlinkStat(): never {
  return { isSymbolicLink: () => false } as never;
}

export function systemdSpawn(
  events: string[],
  fragmentPath = "/lib/systemd/user/openshell-gateway.service",
  execPath = "/usr/bin/openshell-gateway",
) {
  return vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    return args.includes("show")
      ? spawnResult(0, "", trustedShowOutput(fragmentPath, execPath))
      : spawnResult();
  });
}
