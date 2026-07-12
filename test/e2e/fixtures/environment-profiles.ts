// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "./availability-env.ts";

function withDefaults(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv,
  gateway: string | undefined,
): NodeJS.ProcessEnv {
  return {
    ...base,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    OPENSHELL_GATEWAY: gateway ?? "nemoclaw",
    ...extra,
  };
}

function withInstalledCliPath(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const entries = [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    ...(base.PATH?.split(path.delimiter) ?? []),
  ];
  return {
    ...base,
    HOME: home,
    PATH: [...new Set(entries.filter(Boolean))].join(path.delimiter),
  };
}

export function commandEnvironment(
  extra: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return withDefaults(buildAvailabilityProbeEnv(source), extra, source.OPENSHELL_GATEWAY);
}

export function installedCommandEnvironment(
  extra: NodeJS.ProcessEnv = {},
  home = os.homedir(),
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const base = buildAvailabilityProbeEnv({ ...source, HOME: home });
  return withDefaults(withInstalledCliPath(base, home), extra, source.OPENSHELL_GATEWAY);
}

export function testHomeEnvironment(
  home: string,
  extra: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return installedCommandEnvironment(extra, home, source);
}

export function sandboxCommandEnvironment(
  sandboxName: string,
  extra: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return commandEnvironment(
    {
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_SANDBOX_NAME: sandboxName,
      ...extra,
    },
    source,
  );
}
