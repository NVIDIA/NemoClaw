// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isSyntheticDiscordToken } from "./discord-enrollment-env.ts";

const token = process.env.DISCORD_BOT_TOKEN ?? process.env.NEMOCLAW_E2E_DISCORD_TOKEN;
if (isSyntheticDiscordToken(token)) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? String(input);
    const method = init?.method ?? request?.method ?? "GET";
    const headers = new Headers(init?.headers ?? request?.headers);
    if (
      url === "https://discord.com/api/v10/users/@me" &&
      method.toUpperCase() === "GET" &&
      headers.get("Authorization") === `Bot ${token}`
    ) {
      return Promise.resolve(Response.json({ id: "1", bot: true }));
    }
    return originalFetch(input, init);
  };
}
