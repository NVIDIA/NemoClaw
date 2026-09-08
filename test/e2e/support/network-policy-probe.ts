// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../fixtures/clients/command.ts";

const CURL_STATUS_FORMAT = String.raw`\nSTATUS_%{http_code}\n`;
const CURL_STATUS_RECORD = /(?:^|\r?\n)STATUS_(\d{3})\r?\n?$/u;

export function buildNetworkPolicyCurlProbe(url: string): string {
  return `curl -sS --connect-timeout 10 --max-time 20 -w ${shellQuote(CURL_STATUS_FORMAT)} ${shellQuote(url)} 2>&1`;
}

export function parseNetworkPolicyCurlOutput(
  output: string,
): { response: string; status: number } | null {
  const match = CURL_STATUS_RECORD.exec(output);
  if (!match) return null;
  return {
    response: output.slice(0, match.index),
    status: Number.parseInt(match[1]!, 10),
  };
}
