// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TEST_SYSTEM_PATH, writeExecutable } from "./installer-sourced-env";

const INSTALLER = path.join(import.meta.dirname, "..", "..", "install.sh");
const SERVICE_TEMPLATE = fs.readFileSync(
  path.join(import.meta.dirname, "..", "..", "scripts", "lib", "openshell-gateway.service.in"),
  "utf-8",
);

export const SYSTEMD_IDENTITY_PROPERTIES = [
  "FragmentPath",
  "ExecStart",
  "DropInPaths",
  "ExecCondition",
  "ExecStartPre",
  "ExecStartPost",
  "ExecReload",
  "ExecStop",
  "ExecStopPost",
] as const;

export const SYSTEMD_CANONICAL_PROPERTIES = [
  ...SYSTEMD_IDENTITY_PROPERTIES,
  "ActiveState",
  "UnitFileState",
] as const;

export function systemdPropertyArgs(properties: readonly string[]): string {
  return properties.map((property) => `--property=${property}`).join(" ");
}

export function makeInstallerGatewayTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function renderManagedGatewayUnit(gatewayBin: string): string {
  return SERVICE_TEMPLATE.replaceAll("@OPENSHELL_GATEWAY_BIN@", gatewayBin);
}

export function writeManagedGatewayUnit(
  unitPath: string,
  gatewayBin: string,
  transform: (contents: string) => string = (contents) => contents,
): void {
  fs.writeFileSync(unitPath, transform(renderManagedGatewayUnit(gatewayBin)));
}

export function runInstallerGatewayServiceBody(
  home: string,
  body: string,
  env: NodeJS.ProcessEnv = {},
) {
  const platformBin = path.join(home, "test-platform-bin");
  fs.mkdirSync(platformBin, { recursive: true });
  writeExecutable(path.join(platformBin, "uname"), "#!/usr/bin/env bash\nprintf 'Linux\\n'\n");
  const { PATH: injectedPath, ...injectedEnv } = env;
  return spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        `source ${JSON.stringify(INSTALLER)}`,
        "systemd_user_service_system_unit_roots() { :; }",
        body,
      ].join("\n"),
    ],
    {
      cwd: home,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${platformBin}:${injectedPath ?? `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`}`,
        XDG_CONFIG_HOME: "",
        XDG_CONFIG_DIRS: path.join(home, "empty-xdg-config-dirs"),
        XDG_DATA_DIRS: path.join(home, "empty-xdg-data-dirs"),
        XDG_DATA_HOME: "",
        XDG_RUNTIME_DIR: path.join(home, "runtime"),
        SYSTEMD_UNIT_PATH: "",
        NEMOCLAW_REPO_ROOT: path.dirname(INSTALLER),
        ...injectedEnv,
      },
      timeout: 30_000,
    },
  );
}
