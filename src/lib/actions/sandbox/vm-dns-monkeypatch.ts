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
const INIT_SCRIPT_RELATIVE_PATH = ["srv", "openshell-vm-sandbox-init.sh"] as const;
const RESOLV_CONF_RELATIVE_PATH = ["etc", "resolv.conf"] as const;
const GVPROXY_RESOLVER_LINE = "nameserver ${GVPROXY_GATEWAY_IP}";
const PUBLIC_FALLBACK_DNS = new Set(["8.8.8.8", "8.8.4.4"]);
const INIT_PUBLIC_FALLBACK_BLOCK_RE =
  /^([ \t]*)if\s+\[\s*!\s+-s\s+\/etc\/resolv\.conf\s*\]\s*;\s*then\s*\r?\n[ \t]*(?:echo|printf)\b[^\n]*8\.8\.8\.8[^\n]*>\s*\/etc\/resolv\.conf[^\n]*\r?\n[ \t]*(?:echo|printf)\b[^\n]*8\.8\.4\.4[^\n]*>>\s*\/etc\/resolv\.conf[^\n]*\r?\n[ \t]*fi/gm;
const INIT_ETH0_PUBLIC_FALLBACK_RE =
  /ip\s+link\s+show\s+eth0[\s\S]{0,2000}nameserver\s+8\.8\.8\.8[\s\S]{0,2000}nameserver\s+8\.8\.4\.4/;

type CaptureFn = (
  args: string[],
  opts: { ignoreError?: boolean; timeout?: number },
) => CaptureOpenshellResult;

export type VmDnsMonkeypatchStatus = "skipped" | "applied" | "already-present" | "failed";

export type VmDnsMonkeypatchResult = {
  attempted: boolean;
  changed: boolean;
  ok: boolean;
  reason?: string;
  rootfs?: string;
  status?: VmDnsMonkeypatchStatus;
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

function readTextFileIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathIfPresent(filePath: string): string | null {
  try {
    return fs.realpathSync.native(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function lstatIfPresent(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function fail(reason: string, rootfs?: string, changed = false): VmDnsMonkeypatchResult {
  return {
    attempted: true,
    changed,
    ok: false,
    reason,
    rootfs,
    status: "failed",
  };
}

function skipped(reason: string): VmDnsMonkeypatchResult {
  return {
    attempted: false,
    changed: false,
    ok: false,
    reason,
    status: "skipped",
  };
}

function shouldSkipVmDnsMonkeypatch(
  entry: Pick<SandboxEntry, "openshellDriver"> | null | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | null {
  if (env.NEMOCLAW_DISABLE_VM_DNS_MONKEYPATCH === "1") {
    return "disabled by NEMOCLAW_DISABLE_VM_DNS_MONKEYPATCH=1";
  }
  if (entry?.openshellDriver !== "vm") return "not an OpenShell VM sandbox";
  if (platform !== "darwin" && env.NEMOCLAW_FORCE_VM_DNS_MONKEYPATCH !== "1") {
    return "not running on macOS";
  }
  return null;
}

function ext4RootDiskCandidates(sandboxDir: string): string[] {
  try {
    return fs
      .readdirSync(sandboxDir)
      .filter((entry) => /(?:^|[-_.])(?:rootfs|root|disk).*(?:ext4|\.img$|\.raw$)/i.test(entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function resolveTargetInsideRootfs(
  rootfsReal: string,
  relativePath: readonly string[],
  opts: { mustExist?: boolean } = {},
): { ok: true; path: string } | { ok: false; reason: string } {
  const target = path.join(rootfsReal, ...relativePath);
  const targetReal = realpathIfPresent(target);
  if (targetReal) {
    if (!isPathInside(targetReal, rootfsReal)) {
      return {
        ok: false,
        reason: `refusing to patch ${path.join(...relativePath)} because it resolves outside VM rootfs: ${targetReal}`,
      };
    }
    return { ok: true, path: targetReal };
  }

  if (lstatIfPresent(target)?.isSymbolicLink()) {
    return {
      ok: false,
      reason: `refusing to patch ${path.join(...relativePath)} because it is a dangling symlink: ${target}`,
    };
  }

  if (opts.mustExist) {
    return {
      ok: false,
      reason: `OpenShell VM file not found: ${target}`,
    };
  }

  const parentReal = realpathIfPresent(path.dirname(target));
  if (!parentReal) {
    return {
      ok: false,
      reason: `OpenShell VM directory not found: ${path.dirname(target)}`,
    };
  }
  const resolvedTarget = path.join(parentReal, path.basename(target));
  if (!isPathInside(resolvedTarget, rootfsReal)) {
    return {
      ok: false,
      reason: `refusing to patch ${path.join(...relativePath)} because its parent resolves outside VM rootfs: ${resolvedTarget}`,
    };
  }
  return { ok: true, path: resolvedTarget };
}

function normalizeResolver(current: string): string {
  const lines = current.replace(/\r\n/g, "\n").split("\n");
  const next: string[] = [`nameserver ${GVPROXY_DNS}`];
  const seenNameservers = new Set([GVPROXY_DNS, ...PUBLIC_FALLBACK_DNS]);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const nameserverMatch = trimmed.match(/^nameserver\s+(\S+)(?:\s+.*)?$/);
    if (nameserverMatch) {
      const resolver = nameserverMatch[1];
      if (seenNameservers.has(resolver)) continue;
      seenNameservers.add(resolver);
      next.push(line.trimEnd());
      continue;
    }

    next.push(line.trimEnd());
  }

  return `${next.join("\n")}\n`;
}

function buildGvproxyDnsBlock(indent: string): string {
  return [
    `${indent}if [ -n "\${GVPROXY_GATEWAY_IP:-}" ]; then`,
    `${indent}    echo "${GVPROXY_RESOLVER_LINE}" > /etc/resolv.conf`,
    `${indent}else`,
    `${indent}    echo "nameserver ${GVPROXY_DNS}" > /etc/resolv.conf`,
    `${indent}fi`,
  ].join("\n");
}

function buildGuestInitPatch(initPath: string):
  | { ok: true; changed: boolean; content?: string }
  | { ok: false; reason: string } {
  if (path.basename(initPath) !== INIT_SCRIPT_RELATIVE_PATH.at(-1)) {
    return {
      ok: false,
      reason: `refusing to patch unexpected OpenShell VM init script path: ${initPath}`,
    };
  }

  const original = readTextFileIfPresent(initPath);
  if (original === null) {
    return {
      ok: false,
      reason: `OpenShell VM init script not found: ${initPath}`,
    };
  }
  if (original.includes(GVPROXY_RESOLVER_LINE)) return { ok: true, changed: false };

  const hasGvproxyEvidence =
    original.includes("GVPROXY_GATEWAY_IP") || INIT_ETH0_PUBLIC_FALLBACK_RE.test(original);
  if (!hasGvproxyEvidence) {
    return {
      ok: false,
      reason: "OpenShell VM init script shape not recognized; no gvproxy DNS evidence found",
    };
  }

  const patched = original.replace(INIT_PUBLIC_FALLBACK_BLOCK_RE, (match, indent: string) =>
    buildGvproxyDnsBlock(indent),
  );
  if (patched === original) {
    return {
      ok: false,
      reason: "OpenShell VM init script public-DNS fallback block was not recognized",
    };
  }
  if (!patched.includes(GVPROXY_RESOLVER_LINE)) {
    return {
      ok: false,
      reason: "OpenShell VM init script patch did not produce the gvproxy resolver line",
    };
  }
  return { ok: true, changed: true, content: patched };
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
  const platform = deps.platform ?? process.platform;
  const skipReason = shouldSkipVmDnsMonkeypatch(entry, platform, env);
  if (skipReason) {
    return skipped(skipReason);
  }

  const capture = deps.capture ?? captureOpenshell;
  const get = capture(["sandbox", "get", sandboxName], {
    ignoreError: true,
    timeout: 10_000,
  });
  const sandboxId = parseSandboxIdFromGetOutput(get.output || "");
  if (!sandboxId) {
    return fail("could not resolve OpenShell sandbox id");
  }

  const stateDir =
    deps.stateDir ?? dockerDriverGatewayStateDir(env, deps.homeDir ?? os.homedir());
  const stateDirPath = path.resolve(stateDir);
  const stateDirReal = realpathIfPresent(stateDirPath);
  if (!stateDirReal) {
    return fail(`OpenShell VM state directory not found: ${stateDirPath}`);
  }

  let changed = false;
  let rootfsContext: string | undefined;
  try {
    const sandboxDir = path.join(stateDirReal, "vm-driver", "sandboxes", sandboxId);
    const sandboxDirReal = realpathIfPresent(sandboxDir);
    if (!sandboxDirReal) {
      return fail(`OpenShell VM sandbox directory not found: ${sandboxDir}`);
    }

    const sandboxesDirReal = path.join(stateDirReal, "vm-driver", "sandboxes");
    if (!isPathInside(sandboxDirReal, sandboxesDirReal)) {
      return fail(
        `refusing to patch VM sandbox because its directory resolves outside OpenShell state: ${sandboxDirReal}`,
      );
    }

    const rootfs = path.join(sandboxDirReal, "rootfs");
    const rootfsReal = realpathIfPresent(rootfs);
    if (!rootfsReal) {
      const diskCandidates = ext4RootDiskCandidates(sandboxDirReal);
      if (diskCandidates.length > 0) {
        return fail(
          `OpenShell VM sandbox appears to use an ext4 root disk layout (${diskCandidates.join(", ")}); NemoClaw's rootfs DNS monkeypatch no longer applies`,
        );
      }
      return fail(`VM rootfs not found: ${rootfs}`);
    }
    rootfsContext = rootfsReal;
    if (!isPathInside(rootfsReal, sandboxDirReal)) {
      return fail(
        `refusing to patch VM DNS because rootfs resolves outside OpenShell sandbox directory: ${rootfsReal}`,
        rootfsReal,
      );
    }

    const initScript = resolveTargetInsideRootfs(rootfsReal, INIT_SCRIPT_RELATIVE_PATH, {
      mustExist: true,
    });
    if (!initScript.ok) return fail(initScript.reason, rootfsReal);

    const resolvConf = resolveTargetInsideRootfs(rootfsReal, RESOLV_CONF_RELATIVE_PATH);
    if (!resolvConf.ok) return fail(resolvConf.reason, rootfsReal);

    const initPatch = buildGuestInitPatch(initScript.path);
    if (!initPatch.ok) return fail(initPatch.reason, rootfsReal);

    const currentResolver = readTextFileIfPresent(resolvConf.path) ?? "";
    const desiredResolver = normalizeResolver(currentResolver);
    if (currentResolver !== desiredResolver) {
      fs.writeFileSync(resolvConf.path, desiredResolver);
      changed = true;
    }

    if (initPatch.changed && initPatch.content !== undefined) {
      fs.writeFileSync(initScript.path, initPatch.content);
      changed = true;
    }

    const verifiedInit = readTextFileIfPresent(initScript.path) ?? "";
    if (!verifiedInit.includes(GVPROXY_RESOLVER_LINE)) {
      return fail(
        "OpenShell VM init script patch verification failed: gvproxy resolver line missing",
        rootfsReal,
        changed,
      );
    }

    return {
      attempted: true,
      changed,
      ok: true,
      rootfs: rootfsReal,
      status: changed ? "applied" : "already-present",
    };
  } catch (error) {
    return {
      attempted: true,
      changed,
      ok: false,
      reason: `failed to patch VM DNS files: ${errorMessage(error)}`,
      rootfs: rootfsContext,
      status: "failed",
    };
  }
}
