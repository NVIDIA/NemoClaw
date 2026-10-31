// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NATIVE_LOCAL_AUTH_HEADER_SCRIPT } from "../../../src/lib/inference/native-local/agent-config.ts";
import { shellQuote } from "./clients/command.ts";

/**
 * Sandbox shell command for a chat request to a sandbox-owned native local provider (#13293).
 * The auth script accepts only the credential handle that OpenShell issues, so the raw local
 * credential never enters the request. The endpoint and body are shell-quoted, so request data
 * stays one curl argument.
 */
export function nativeLocalChatCommand(
  endpointUrl: string,
  body: string,
  curlFlags: "-fsS" | "-sS",
): string {
  return `${NATIVE_LOCAL_AUTH_HEADER_SCRIPT}; curl ${curlFlags} --max-time 120 ${shellQuote(`${endpointUrl}/chat/completions`)} -H "$AUTH_HEADER" -H 'Content-Type: application/json' --data ${shellQuote(body)}`;
}
