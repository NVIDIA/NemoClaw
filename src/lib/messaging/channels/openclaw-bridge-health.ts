// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookHandler, MessagingHookRegistration } from "../hooks/types";

const OPENCLAW_CONFIG_FILE = "/sandbox/.openclaw/openclaw.json";
const OPENCLAW_GATEWAY_LOG_FILE = "/tmp/gateway.log";
const OPENCLAW_BRIDGE_WARNING_PATTERN =
  /credential placeholder|Bot API rejected|startup probe (?:failed|returned)|provider failed to start|bridge did not start within|invalid_auth|token_revoked|token_expired/i;
const OPENCLAW_BRIDGE_POSITIVE_STARTUP_PATTERN = /\bstarting provider\b|\bprovider ready\b/;

export interface OpenClawBridgeHealthCommandResult {
  readonly status?: number | null;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

export type OpenClawBridgeHealthCommandRunner = (
  command: string,
  timeoutMs: number,
) => OpenClawBridgeHealthCommandResult | null | undefined;

export interface OpenClawBridgeHealthHookOptions {
  readonly sandboxName?: string;
  readonly executeSandboxCommand?: OpenClawBridgeHealthCommandRunner;
  readonly log?: (message: string) => void;
}

export interface OpenClawBridgeHealthStartupContext {
  readonly channelBlock: unknown;
  readonly log: (message: string) => void;
}

export interface OpenClawBridgeHealthChannelSpec {
  readonly channelId: string;
  readonly handlerId: string;
  readonly onStartupDetected?: (context: OpenClawBridgeHealthStartupContext) => void;
}

export function createOpenClawBridgeHealthHookRegistration(
  spec: OpenClawBridgeHealthChannelSpec,
  options: OpenClawBridgeHealthHookOptions = {},
): MessagingHookRegistration {
  return {
    id: spec.handlerId,
    handler: createOpenClawBridgeHealthHook(spec, options),
  };
}

export function createOpenClawBridgeHealthHook(
  spec: OpenClawBridgeHealthChannelSpec,
  options: OpenClawBridgeHealthHookOptions = {},
): MessagingHookHandler {
  return () => {
    const execute = options.executeSandboxCommand;
    if (!execute) {
      throw new Error("OpenClaw bridge health check requires executeSandboxCommand.");
    }

    const log = options.log ?? console.log;
    const sandboxName = normalizeSandboxName(options.sandboxName);
    const configProbe = execute(`cat ${OPENCLAW_CONFIG_FILE} 2>/dev/null || true`, 10000);
    if (!configProbe || configProbe.status !== 0 || !configProbe.stdout) {
      log(
        `  ⚠ Could not read ${OPENCLAW_CONFIG_FILE} to verify '${spec.channelId}' bridge startup.`,
      );
      log(`    Run the status command for '${sandboxName}' once the sandbox is fully running.`);
      return {};
    }

    let channelBlock: unknown = null;
    let channelEnabled = false;
    try {
      const cfg = JSON.parse(String(configProbe.stdout));
      channelBlock = getObjectPath(cfg, `channels.${spec.channelId}`);
      channelEnabled = Boolean(getObjectPath(channelBlock, "enabled"));
    } catch {
      // Malformed config: continue to a clear disabled warning.
    }

    if (!channelEnabled) {
      log(
        `  ⚠ '${spec.channelId}' channel was not marked enabled in baked ${OPENCLAW_CONFIG_FILE} after rebuild.`,
      );
      log(
        "    The bridge will not start. Re-run the sandbox rebuild or remove and add the channel again.",
      );
      return {};
    }

    const logLineRegex = new RegExp(
      `^\\[${escapeRegExp(spec.channelId)}\\] |^\\[channels\\] \\[${escapeRegExp(spec.channelId)}\\]`,
    );
    const logProbe = execute(`tail -n 400 ${OPENCLAW_GATEWAY_LOG_FILE} 2>/dev/null || true`, 10000);
    const lines = String(logProbe?.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && logLineRegex.test(line));
    if (lines.length === 0) {
      log(
        `  ⚠ '${spec.channelId}' bridge did not log a startup breadcrumb in ${OPENCLAW_GATEWAY_LOG_FILE} yet.`,
      );
      log(
        `    Tail it with 'openshell sandbox exec --name ${sandboxName} -- tail -f ${OPENCLAW_GATEWAY_LOG_FILE}' if the channel stays silent.`,
      );
      return {};
    }

    const credentialWarnings = lines.filter((line) => OPENCLAW_BRIDGE_WARNING_PATTERN.test(line));
    if (credentialWarnings.length > 0) {
      log(`  ⚠ '${spec.channelId}' bridge logged credential/startup warnings:`);
      for (const line of credentialWarnings.slice(0, 3)) {
        log(`    ${line}`);
      }
      log(
        `    Verify the OpenShell provider for ${spec.channelId} holds a valid credential and re-run the sandbox rebuild if needed.`,
      );
      return {};
    }

    if (lines.some((line) => OPENCLAW_BRIDGE_POSITIVE_STARTUP_PATTERN.test(line))) {
      log(`  ✓ '${spec.channelId}' bridge startup detected in sandbox runtime log.`);
      spec.onStartupDetected?.({ channelBlock, log });
      return {};
    }

    log(`  ⚠ '${spec.channelId}' bridge log lines found but no startup confirmation yet.`);
    log(
      `    Tail it with 'openshell sandbox exec --name ${sandboxName} -- tail -f ${OPENCLAW_GATEWAY_LOG_FILE}' if the channel stays silent.`,
    );
    return {};
  };
}

function normalizeSandboxName(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "<sandbox>";
}

function getObjectPath(value: unknown, dottedPath: string): unknown {
  let current = value;
  for (const segment of dottedPath.split(".").filter(Boolean)) {
    if (!isObjectRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
