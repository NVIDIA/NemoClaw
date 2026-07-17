// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { shellQuote } from "../fixtures/clients/command.ts";

export type OpenShellComponents = {
  cli: string;
  gateway: string;
  sandbox: string;
};

export type OpenShellDriverConfigTestWrapper = {
  directory: string;
  executable: string;
  remove(): void;
};

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

export function createOpenShellDriverConfigTestWrapper(options: {
  delegatedCapabilityMarkers?: readonly string[];
  driverConfigJson: string;
  label: string;
  realOpenshellPath: string;
}): OpenShellDriverConfigTestWrapper {
  if (!path.isAbsolute(options.realOpenshellPath)) {
    throw new Error("real OpenShell path must be absolute");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(options.label)) {
    throw new Error("OpenShell driver-config test wrapper label must be shell-safe");
  }
  fs.accessSync(options.realOpenshellPath, fs.constants.X_OK);
  const parsedDriverConfig: unknown = JSON.parse(options.driverConfigJson);
  if (
    parsedDriverConfig === null ||
    typeof parsedDriverConfig !== "object" ||
    Array.isArray(parsedDriverConfig)
  ) {
    throw new Error("OpenShell driver-config test wrapper requires a JSON object");
  }

  const capabilityComments = (options.delegatedCapabilityMarkers ?? [])
    .map((marker) => {
      if (!/^[A-Za-z0-9_-]+$/.test(marker)) {
        throw new Error("delegated OpenShell capability marker must be shell-safe");
      }
      return `# TEST-ONLY delegated-capability marker from validated canonical OpenShell: ${marker}`;
    })
    .join("\n");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `nemoclaw-${options.label}-openshell-wrapper-`),
  );
  const executable = path.join(directory, "openshell");
  const script = `#!/bin/sh
${capabilityComments}
set -eu
if [ "$#" -ge 2 ] && [ "$1" = sandbox ] && [ "$2" = create ]; then
  shift 2
  for argument in "$@"; do
    case "$argument" in
      --driver-config-json|--driver-config-json=*)
        printf '%s\n' 'refusing duplicate --driver-config-json in ${options.label} test wrapper' >&2
        exit 64
        ;;
    esac
  done
  exec ${shellQuote(options.realOpenshellPath)} sandbox create --driver-config-json ${shellQuote(options.driverConfigJson)} "$@"
fi
exec ${shellQuote(options.realOpenshellPath)} "$@"
`;
  fs.writeFileSync(executable, script, { encoding: "utf8", mode: 0o700 });

  return {
    directory,
    executable,
    remove: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

export function withOpenShellDriverConfigWrapperEnv(
  env: NodeJS.ProcessEnv,
  wrapper: OpenShellDriverConfigTestWrapper,
  components: OpenShellComponents,
): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: `${wrapper.directory}${path.delimiter}${env.PATH ?? ""}`,
    NEMOCLAW_OPENSHELL_BIN: wrapper.executable,
    NEMOCLAW_OPENSHELL_GATEWAY_BIN: components.gateway,
    NEMOCLAW_OPENSHELL_SANDBOX_BIN: components.sandbox,
  };
}
