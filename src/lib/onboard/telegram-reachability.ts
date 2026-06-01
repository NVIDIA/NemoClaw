// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runCurlProbe } from "../adapters/http/probe";
import { cliName } from "./branding";
import { exitOnboardFromPrompt } from "./prompt-helpers";

// Curl exit codes that indicate a network-level failure (not a token problem).
// 35 (TLS handshake failure) covers corporate proxies that MITM HTTPS.
export const TELEGRAM_NETWORK_CURL_CODES = new Set([6, 7, 28, 35, 52, 56]);

export type TelegramReachabilityResult = { skipped: boolean };

export interface TelegramReachabilityDeps {
  isNonInteractive(): boolean;
  note(message: string): void;
  promptYesNoOrDefault(
    question: string,
    envVar: string | null,
    defaultIsYes: boolean,
  ): Promise<boolean>;
}

function announceTelegramSkip(reason: "unreachable" | "invalid-token"): void {
  const because =
    reason === "unreachable"
      ? "api.telegram.org is unreachable"
      : "the bot token was rejected by Telegram";
  const recovery =
    reason === "unreachable"
      ? "once network access is restored"
      : "after setting a valid TELEGRAM_BOT_TOKEN";
  console.warn(`  Telegram integration will be disabled for this onboard run because ${because}.`);
  console.warn(
    `  Re-run onboarding (or \`${cliName()} <name> channels add telegram\`) ${recovery}.`,
  );
}

export async function checkTelegramReachability(
  token: string,
  deps: TelegramReachabilityDeps,
): Promise<TelegramReachabilityResult> {
  if (process.env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY === "1") {
    deps.note("  [non-interactive] Skipping Telegram reachability probe by request.");
    return { skipped: false };
  }

  const result = runCurlProbe([
    "-sS",
    "--connect-timeout",
    "5",
    "--max-time",
    "10",
    `https://api.telegram.org/bot${token}/getMe`,
  ]);

  // HTTP 200 with "ok":true — Telegram is reachable and token is valid.
  if (result.ok) return { skipped: false };

  // HTTP 401 or 404 — Telegram rejected the bot token. The integration cannot
  // function with an invalid token, so this is "validation fails" per #4238 and
  // takes the same warn-and-skip path as a network failure: drop telegram from
  // the active messaging channel set instead of letting onboarding write an
  // unusable token into the sandbox/provider config.
  if (result.httpStatus === 401 || result.httpStatus === 404) {
    console.log("");
    console.log("  ⚠ Bot token was rejected by Telegram — verify the token is correct.");
    announceTelegramSkip("invalid-token");
    return { skipped: true };
  }

  // Network-level failure — Telegram is unreachable from this host. Treat as
  // an optional-integration soft-fail (#4238): warn, drop telegram from the
  // active messaging channel set, and let onboarding continue. Matches the
  // warn-and-skip pattern Brave uses at src/lib/onboard/web-search-flow.ts.
  if (result.curlStatus && TELEGRAM_NETWORK_CURL_CODES.has(result.curlStatus)) {
    console.log("");
    console.log("  ⚠ api.telegram.org is not reachable from this host.");
    console.log("    Telegram integration requires outbound HTTPS access to api.telegram.org.");
    console.log("    This is commonly blocked by corporate network proxies.");

    if (deps.isNonInteractive()) {
      announceTelegramSkip("unreachable");
      return { skipped: true };
    }
    // Interactive: prompt explicitly asks whether to skip telegram and continue.
    // Default Y favors the soft-fail path so an enter-press lines up with the
    // optional-integration contract. An explicit N still aborts onboarding —
    // the user opted out of both telegram and the workaround.
    if (
      await deps.promptYesNoOrDefault(
        "    Disable Telegram for this run and continue?",
        null,
        true,
      )
    ) {
      announceTelegramSkip("unreachable");
      return { skipped: true };
    }
    exitOnboardFromPrompt();
  }

  // Unexpected probe failure — warn but don't block.
  if (!result.ok && result.httpStatus > 0) {
    console.log(
      `  ⚠ Telegram API returned HTTP ${result.httpStatus} — the bot may not work correctly.`,
    );
  } else if (!result.ok) {
    console.log(`  ⚠ Telegram reachability probe failed: ${result.message}`);
  }
  return { skipped: false };
}
