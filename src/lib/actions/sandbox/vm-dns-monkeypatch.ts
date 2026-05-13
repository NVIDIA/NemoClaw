// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type CaptureOpenshellResult,
  stripAnsi,
} from "../../adapters/openshell/client";
import { captureOpenshell } from "../../adapters/openshell/runtime";
import type { SandboxEntry } from "../../state/registry";

const GVPROXY_DNS = "192.168.127.1";
const LEGACY_PUBLIC_DNS_BLOCK = `    if [ ! -s /etc/resolv.conf ]; then
        echo "nameserver 8.8.8.8" > /etc/resolv.conf
        echo "nameserver 8.8.4.4" >> /etc/resolv.conf
    fi`;
const GVPROXY_DNS_BLOCK = `    echo "nameserver \${GVPROXY_GATEWAY_IP}" > /etc/resolv.conf`;

type CaptureFn = (
  args: string[],
  opts: { ignoreError?: boolean; timeout?: number },
) => CaptureOpenshellResult;

export type VmDnsMonkeypatchResult = {
  attempted: boolean;
  changed: boolean;
  ok: boolean;
  reason?: string;
  rootfs?: string;
};

export function shouldApplyVmDnsMonkeypatch(
  entry: Pick<SandboxEntry, "openshellDriver"> | null | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NEMOCLAW_DISABLE_VM_DNS_MONKEYPATCH === "1") return false;
  if (entry?.openshellDriver !== "vm") return false;
  return platform === "darwin" || env.NEMOCLAW_FORCE_VM_DNS_MONKEYPATCH === "1";
}

function dockerDriverGatewayStateDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const configured = env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  return path.join(homeDir, ".local", "state", "nemoclaw", "openshell-docker-gateway");
}

export function parseSandboxIdFromGetOutput(output: string): string | null {
  const match = stripAnsi(output).match(/^\s*(?:Id|ID):\s*([A-Za-z0-9._-]+)\s*$/m);
  return match?.[1] ?? null;
}

function patchGuestInit(initPath: string): boolean {
  if (!fs.existsSync(initPath)) return false;
  const original = fs.readFileSync(initPath, "utf-8");
  if (original.includes('nameserver ${GVPROXY_GATEWAY_IP}')) return false;
  const patched = original.replace(LEGACY_PUBLIC_DNS_BLOCK, GVPROXY_DNS_BLOCK);
  if (patched === original) return false;
  fs.writeFileSync(initPath, patched);
  return true;
}

export function applyOpenShellVmDnsMonkeypatch(
  sandboxName: string,
  entry: Pick<SandboxEntry, "openshellDriver"> | null | undefined,
  deps: {
    capture?: CaptureFn;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    platform?: NodeJS.Platform;
    stateDir?: string;
  } = {},
): VmDnsMonkeypatchResult {
  const env = deps.env ?? process.env;
  if (!shouldApplyVmDnsMonkeypatch(entry, deps.platform ?? process.platform, env)) {
    return {
      attempted: false,
      changed: false,
      ok: false,
      reason: "not a macOS OpenShell VM sandbox",
    };
  }

  const capture = deps.capture ?? captureOpenshell;
  const get = capture(["sandbox", "get", sandboxName], {
    ignoreError: true,
    timeout: 10_000,
  });
  const sandboxId = parseSandboxIdFromGetOutput(get.output || "");
  if (!sandboxId) {
    return {
      attempted: true,
      changed: false,
      ok: false,
      reason: "could not resolve OpenShell sandbox id",
    };
  }

  const stateDir =
    deps.stateDir ?? dockerDriverGatewayStateDir(env, deps.homeDir ?? os.homedir());
  const rootfs = path.join(stateDir, "vm-driver", "sandboxes", sandboxId, "rootfs");
  const resolvConf = path.join(rootfs, "etc", "resolv.conf");
  if (!fs.existsSync(rootfs)) {
    return {
      attempted: true,
      changed: false,
      ok: false,
      reason: `VM rootfs not found: ${rootfs}`,
    };
  }

  fs.mkdirSync(path.dirname(resolvConf), { recursive: true });
  const desired = `nameserver ${GVPROXY_DNS}\n`;
  const current = fs.existsSync(resolvConf) ? fs.readFileSync(resolvConf, "utf-8") : "";
  let changed = current !== desired;
  if (changed) {
    fs.writeFileSync(resolvConf, desired);
  }
  changed =
    patchGuestInit(path.join(rootfs, "srv", "openshell-vm-sandbox-init.sh")) || changed;

  return { attempted: true, changed, ok: true, rootfs };
}
