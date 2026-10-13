// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "./clients/command.ts";

/** Invoke the managed Hermes API without returning its local server credential. */
export function hermesApiCommand(payload: string): string {
  return `set -a; [ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env; set +a; curl -sS --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -H "Authorization: Bearer \${API_SERVER_KEY:-}" -d ${shellQuote(payload)}`;
}
