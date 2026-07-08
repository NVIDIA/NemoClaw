// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as registry from "./state/registry";

export interface UseCommandDeps {
  readonly listSandboxes: () => {
    readonly sandboxes: ReadonlyArray<{ readonly name: string }>;
    readonly defaultSandbox: string | null;
  };
  readonly setDefault: (name: string) => boolean;
}

export type UseCommandResult =
  | {
      readonly outcome: "set";
      readonly sandboxName: string;
      readonly previousDefault: string | null;
    }
  | {
      readonly outcome: "already-default";
      readonly sandboxName: string;
    }
  | {
      readonly outcome: "not-found";
      readonly sandboxName: string;
      readonly knownSandboxes: ReadonlyArray<string>;
    };

export function buildUseCommandDeps(): UseCommandDeps {
  return {
    listSandboxes: () => registry.listSandboxes(),
    setDefault: (name) => registry.setDefault(name),
  };
}

export function runUseCommand(sandboxName: string, deps: UseCommandDeps): UseCommandResult {
  const current = deps.listSandboxes();
  const known = current.sandboxes.map((sb) => sb.name);
  if (!known.includes(sandboxName)) {
    return { outcome: "not-found", sandboxName, knownSandboxes: known };
  }
  const wasAlreadyDefault = current.defaultSandbox === sandboxName;
  const updated = deps.setDefault(sandboxName);
  if (!updated) {
    // setDefault rechecks existence under the registry lock. Refresh after a
    // concurrent removal so the not-found diagnostic reflects post-lock state.
    const refreshed = deps.listSandboxes();
    return {
      outcome: "not-found",
      sandboxName,
      knownSandboxes: refreshed.sandboxes.map((sb) => sb.name),
    };
  }
  if (wasAlreadyDefault) {
    return { outcome: "already-default", sandboxName };
  }
  return { outcome: "set", sandboxName, previousDefault: current.defaultSandbox };
}
