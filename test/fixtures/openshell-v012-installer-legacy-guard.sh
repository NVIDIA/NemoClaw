# shellcheck shell=bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Every installation entrypoint must verify legacy state before downloading or
# replacing components. The Homebrew service-control operation above remains
# available so the installed legacy gateway can still be stopped and retired.
command -v node >/dev/null 2>&1 || fail "Node.js is required to verify legacy OpenShell state."
# Keep this guard in the installer: protected execution projects this file alone.
# shellcheck disable=SC2016 # JavaScript template literals are evaluated by Node.js.
node --input-type=module -e '
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

function deny(reason) {
  throw new Error(
    `Cannot replace OpenShell: ${reason}. Back up and retire the legacy gateway with the installed CLI before retrying. Existing components and gateway data were not changed.`,
  );
}

function query(binary, args) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 15_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || result.stderr.trim()) {
    deny("the installed CLI could not verify legacy gateway state");
  }
  return result.stdout.trim();
}

function missing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function gatewayNames() {
  const config = process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config");
  const system = process.env.OPENSHELL_SYSTEM_GATEWAY_DIR ?? "/etc/openshell";
  if (!isAbsolute(config) || !isAbsolute(system))
    deny("gateway configuration paths are not absolute");
  const names = new Map();
  for (const root of [join(config, "openshell", "gateways"), join(system, "gateways")]) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) continue;
      deny("legacy gateway registrations could not be read");
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) deny("a legacy gateway registration is a symbolic link");
      if (!entry.isDirectory()) continue;
      const metadataPath = join(root, entry.name, "metadata.json");
      // An absent record cannot prove retirement. Check and read the opened
      // file, without following a substituted symlink or blocking on a FIFO.
      const descriptor = openSync(
        metadataPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let metadata;
      try {
        if (!fstatSync(descriptor).isFile()) deny("legacy gateway metadata is not a regular file");
        metadata = JSON.parse(readFileSync(descriptor, "utf8"));
      } finally {
        closeSync(descriptor);
      }
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.name) ||
        metadata?.name !== entry.name ||
        typeof metadata.gateway_endpoint !== "string" ||
        !metadata.gateway_endpoint.trim()
      ) {
        deny("legacy gateway metadata is invalid");
      }
      if (names.has(entry.name) && names.get(entry.name) !== metadata.gateway_endpoint) {
        deny("user and system legacy gateway registrations disagree");
      }
      names.set(entry.name, metadata.gateway_endpoint);
    }
  }
  return [...names.keys()];
}

function verify() {
  // Match the component installer PATH selection, not a different CLI override.
  const binary = query("bash", ["-c", "command -v openshell || true"]);
  if (binary) {
    const version = /^openshell (\d+)\.(\d+)\.(\d+)(?:[.+-][A-Za-z0-9.+-]+)?$/.exec(
      query(binary, ["--version"]),
    );
    if (!version) deny("the installed CLI version is unknown");
  }
  // Native gateway list silently omits corrupt metadata. Inspect registrations
  // before querying each gateway, rather than trusting an empty gateway list.
  const names = gatewayNames();
  if (names.length && (!binary || process.env.OPENSHELL_GATEWAY_ENDPOINT?.trim())) {
    deny("legacy gateway inventory requires its installed CLI and recorded endpoint");
  }
  for (const name of names) {
    const inventory = JSON.parse(query(binary, ["sandbox", "list", "-g", name, "-o", "json"]));
    const empty = Array.isArray(inventory)
      ? inventory.length === 0
      : inventory !== null &&
        Array.isArray(inventory.sandboxes) &&
        inventory.sandboxes.length === 0 &&
        inventory.next_page_token === "";
    if (!empty) deny("a legacy gateway has sandboxes or an incomplete inventory");
  }
}

try {
  verify();
} catch (error) {
  console.error(
    error instanceof Error && error.message.startsWith("Cannot replace OpenShell:")
      ? error.message
      : "Cannot replace OpenShell: legacy gateway state is unreadable. Preserve the installed CLI and resolve the registration before retrying.",
  );
  process.exitCode = 1;
}
'
