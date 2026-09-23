// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export type OpenShellComponents = {
  cli: string;
  gateway: string;
  sandbox: string;
};

/** Resolve an installed OpenShell component set to executable canonical paths. */
export function resolveOpenShellSiblingComponents(openshellPath: string): OpenShellComponents {
  const cli = fs.realpathSync(openshellPath);
  fs.accessSync(cli, fs.constants.X_OK);
  const installDirectory = path.dirname(cli);
  const canonicalSibling = (name: string): string => {
    const sibling = fs.realpathSync(path.join(installDirectory, name));
    fs.accessSync(sibling, fs.constants.X_OK);
    return sibling;
  };
  return {
    cli,
    gateway: canonicalSibling("openshell-gateway"),
    sandbox: canonicalSibling("openshell-sandbox"),
  };
}

/** Keep command, gateway, sandbox, and ForwardTcp ownership on one component set. */
export function withCanonicalOpenShellEnv(
  env: NodeJS.ProcessEnv,
  components: OpenShellComponents,
): NodeJS.ProcessEnv {
  return {
    ...env,
    NEMOCLAW_OPENSHELL_BIN: components.cli,
    NEMOCLAW_OPENSHELL_GATEWAY_BIN: components.gateway,
    NEMOCLAW_OPENSHELL_SANDBOX_BIN: components.sandbox,
  };
}
