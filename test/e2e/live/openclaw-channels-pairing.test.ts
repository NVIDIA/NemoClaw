// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test as unitTest } from "vitest";

import { test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import {
  OPENCLAW_DISCORD_PAIRING_TIMEOUT_MS,
  runOpenClawDiscordPairing,
} from "./openclaw-channels-pairing-discord.ts";
import {
  OPENCLAW_SLACK_PAIRING_TIMEOUT_MS,
  runOpenClawSlackPairing,
} from "./openclaw-channels-pairing-slack.ts";
import {
  openClawWhatsappQrCompactTimeoutOptions,
  runOpenClawWhatsappQrCompact,
} from "./openclaw-channels-pairing-whatsapp-qr.ts";

test.skipIf(!shouldRunLiveE2E())(
  "openclaw channels pairing approves Discord requests through connect-shell",
  { timeout: OPENCLAW_DISCORD_PAIRING_TIMEOUT_MS },
  runOpenClawDiscordPairing,
);

test.skipIf(!shouldRunLiveE2E())(
  "openclaw channels pairing approves Slack Socket Mode requests through connect-shell",
  { timeout: OPENCLAW_SLACK_PAIRING_TIMEOUT_MS },
  runOpenClawSlackPairing,
);

unitTest(
  "openclaw channels pairing renders WhatsApp QR compactly",
  openClawWhatsappQrCompactTimeoutOptions(),
  runOpenClawWhatsappQrCompact,
);
