// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { styleText } from "node:util";

import type {
  MessagingHookHandler,
  MessagingHookOutputMap,
  MessagingHookRegistration,
} from "../../../hooks/types";
import type { MessagingSerializableValue } from "../../../manifest";

export const GOOGLECHAT_TUNNEL_AUDIENCE_GATE_HOOK_ID = "googlechat.tunnelAudienceGate";

// The tunnel audience path; must match the webhookPath rendered in manifest.ts
// (the plugin's inbound route) or Google posts to a path the gateway doesn't serve.
const DEFAULT_WEBHOOK_PATH = "/googlechat";

/** Coarse cloudflared running-state used to decide whether we must start one. */
export type GooglechatTunnelState = { readonly running: boolean };

/**
 * Process-local authority for the one live E2E composition that must exercise
 * Google Chat lifecycle non-interactively.
 *
 * Production composition never supplies this object. Keeping the audience on
 * the capability itself means an environment variable, CLI input, or
 * predictable sandbox name cannot manufacture the bypass.
 */
export interface GooglechatNonInteractiveAudienceCapability {
  readonly audience: string;
}

// Every side effect is injected so this hook file stays free of fs/process/
// credential imports (mirrors the WeChat ilink-login pattern). The real
// implementations live in ./tunnel-runtime and are wired by ./index.
export interface GooglechatTunnelAudienceGateHookOptions {
  readonly nonInteractiveAudienceCapability?: GooglechatNonInteractiveAudienceCapability;
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
  readonly hasCloudflared?: () => boolean;
  readonly readTunnelState?: () => GooglechatTunnelState;
  readonly startTunnel?: () => Promise<void>;
  readonly stopTunnel?: () => void;
  readonly getTunnelUrl?: () => string;
  readonly prompt?: (question: string) => Promise<string>;
}

function readString(value: MessagingSerializableValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function isAffirmative(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

function requireAppUrlAudience(value: string): string {
  let audience: URL;
  try {
    audience = new URL(value);
  } catch {
    throw new Error(
      "Google Chat app-url audience must be a valid HTTPS URL whose path is exactly /googlechat.",
    );
  }
  if (audience.protocol !== "https:" || audience.pathname !== DEFAULT_WEBHOOK_PATH) {
    throw new Error(
      "Google Chat app-url audience must be a valid HTTPS URL whose path is exactly /googlechat.",
    );
  }
  return value;
}

function audienceOutput(audience: string): { readonly outputs: MessagingHookOutputMap } {
  const outputs: Record<string, MessagingHookOutputMap[string]> = {
    audience: { kind: "config", value: audience },
  };
  return { outputs };
}

function printEndpointInstructions(log: (message: string) => void, audience: string): void {
  const url = styleText("cyan", audience, { stream: process.stdout });
  log("");
  log("  ┃  GOOGLE CHAT — ACTION REQUIRED");
  log("  ┃");
  log("  ┃  1.  Open    Google Cloud Console → Chat API → Configuration");
  log("  ┃  2.  Select  Connection settings  →  HTTP endpoint URL");
  log("  ┃  3.  Select  Use a common HTTP endpoint URL for all triggers");
  log("  ┃  4.  Paste   this exact URL (HTTPS, no trailing slash):");
  log("  ┃");
  log(`  ┃      ${url}`);
  log("  ┃");
  log("  ┃  HTTPS · exact match · include /googlechat · no trailing slash");
  log("  ┃");
  log("  ┃  This URL only forwards POST /googlechat — it doesn't expose your");
  log("  ┃  dashboard. Open the Control UI at http://127.0.0.1:18789 (localhost).");
  log("");
}

export function createGooglechatTunnelAudienceGateHook(
  options: GooglechatTunnelAudienceGateHookOptions = {},
): MessagingHookHandler {
  return async (context) => {
    if (context.channelId !== "googlechat") return {};

    const env = options.env ?? process.env;
    const log = options.log ?? ((message: string) => console.log(message));
    const audienceType = readString(context.inputs?.audienceType) || "app-url";

    // Non-interactive mode: always skip Google Chat. Enrollment needs manual,
    // out-of-band steps that no environment variable can satisfy — the operator
    // must paste the webhook URL into the Google Cloud Console and confirm it,
    // and personal/standalone accounts must trace the appPrincipal from the
    // first live DM. Like WeChat's host-QR login there is no unattended path, so
    // we skip rather than enroll a half-configured channel that silently 404s on
    // inbound webhooks. A pre-supplied GOOGLECHAT_AUDIENCE does NOT bypass this —
    // the Console/appPrincipal steps still require a human.
    //
    // The live channels-stop-start composition can inject a process-local
    // capability after proving its target. Ordinary runtime environment
    // variables, configured inputs, and sandbox names cannot enable this path.
    if (context.isInteractive === false) {
      const presetAudience = readString(options.nonInteractiveAudienceCapability?.audience);
      if (presetAudience) {
        const audience =
          audienceType === "app-url" ? requireAppUrlAudience(presetAudience) : presetAudience;
        log(`  ✓ Google Chat webhook audience (non-interactive, pre-supplied): ${audience}`);
        return audienceOutput(audience);
      }
      log(
        "  Skipped googlechat (interactive setup required: Google Cloud Console endpoint URL + appPrincipal)",
      );
      throw new Error(
        "Skipping Google Chat: interactive enrollment required (Cloud Console endpoint URL + appPrincipal cannot be supplied non-interactively).",
      );
    }

    // An audience supplied up front (env, prior paste, or a named tunnel) wins;
    // never touch the cloudflared tunnel in that case. Also covers project-number.
    const existingAudience =
      readString(context.inputs?.audience) || readString(env.GOOGLECHAT_AUDIENCE);
    if (existingAudience) {
      const audience =
        audienceType === "app-url" ? requireAppUrlAudience(existingAudience) : existingAudience;
      log(`  ✓ Google Chat webhook audience already set: ${audience}`);
      return audienceOutput(audience);
    }

    // Only the app-url path derives its audience from a public webhook URL. Any
    // other audienceType (e.g. project-number) is entered here — the gate is the
    // single audience authority (audience is not a config-prompt input).
    if (audienceType !== "app-url") {
      const promptAudience = requireOption(options.prompt, "prompt");
      const entered = readString(
        await promptAudience("  Google Chat webhook audience (GCP project number): "),
      );
      if (!entered) {
        log("  Skipped googlechat (no webhook audience provided)");
        throw new Error(
          `No Google Chat webhook audience provided for audienceType ${audienceType}.`,
        );
      }
      env.GOOGLECHAT_AUDIENCE = entered;
      log(`  ✓ Google Chat webhook audience set: ${entered}`);
      return audienceOutput(entered);
    }

    const readTunnelState = requireOption(options.readTunnelState, "readTunnelState");
    const getTunnelUrl = requireOption(options.getTunnelUrl, "getTunnelUrl");
    const stopTunnel = requireOption(options.stopTunnel, "stopTunnel");

    const preexisting = readTunnelState().running;
    let startedByUs = false;
    if (!preexisting) {
      const hasCloudflared = requireOption(options.hasCloudflared, "hasCloudflared");
      if (!hasCloudflared()) {
        log("  Skipped googlechat (cloudflared not installed — needed for a public webhook URL)");
        throw new Error(
          "cloudflared is not installed; cannot expose a public Google Chat webhook.",
        );
      }
      log("  Google Chat needs a public HTTPS URL. Starting a dedicated webhook tunnel…");
      const startTunnel = requireOption(options.startTunnel, "startTunnel");
      await startTunnel();
      if (!readTunnelState().running) {
        stopTunnel();
        log("  Skipped googlechat (cloudflared tunnel failed to start)");
        throw new Error("cloudflared tunnel failed to start.");
      }
      startedByUs = true;
    }

    const url = getTunnelUrl();
    if (!url) {
      if (startedByUs) stopTunnel();
      log("  Skipped googlechat (no public tunnel URL available)");
      throw new Error("No public tunnel URL is available for the Google Chat webhook.");
    }

    const audience = `${url.replace(/\/+$/, "")}${DEFAULT_WEBHOOK_PATH}`;
    printEndpointInstructions(log, audience);

    // Non-interactive mode already threw at the top of the hook, so this prompt
    // path is only reached interactively. Mirrors promptYesNoOrDefault: default
    // No, y/yes wins.
    const prompt = requireOption(options.prompt, "prompt");
    const answer = await prompt("  Set and saved it in the Console? [y/N] (N skips Google Chat): ");
    if (!isAffirmative(answer)) {
      if (startedByUs) stopTunnel();
      log("  Skipped googlechat (HTTP endpoint URL not set in Google Cloud Console)");
      throw new Error("Operator did not confirm the Google Chat HTTP endpoint URL.");
    }

    env.GOOGLECHAT_AUDIENCE = audience;
    log(`  ✓ Google Chat webhook audience set: ${audience}`);
    return audienceOutput(audience);
  };
}

function requireOption<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`Google Chat tunnel/audience gate hook requires an injected ${name}.`);
  }
  return value;
}

export function createGooglechatTunnelAudienceGateHookRegistration(
  options: GooglechatTunnelAudienceGateHookOptions = {},
): MessagingHookRegistration {
  return {
    id: GOOGLECHAT_TUNNEL_AUDIENCE_GATE_HOOK_ID,
    handler: createGooglechatTunnelAudienceGateHook(options),
  };
}
