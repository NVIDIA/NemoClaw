// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// The local Telegram fixture has no service rate limit. Keep the native queue,
// but configure its supported throttler dependency without wall-clock pacing.
import { readFileSync, readdirSync } from "node:fs";
if (process.argv[1]?.endsWith("/openclaw.mjs")) {
  const candidates = readdirSync("/app/dist").filter(
    (name) =>
      name.startsWith("send-") &&
      name.endsWith(".mjs") &&
      readFileSync(`/app/dist/${name}`, "utf8").includes("function getOrCreateAccountThrottler("),
  );
  if (candidates.length !== 1)
    throw new Error("Cannot locate pinned Telegram transport dependency");
  const exports = Object.values(await import(`/app/dist/${candidates[0]}`));
  const configure = exports.find(
    (value) => typeof value === "function" && value.name === "getOrCreateAccountThrottler",
  );
  const factory = exports.find(
    (value) => typeof value === "function" && value.name === "apiThrottler",
  );
  if (typeof configure !== "function" || typeof factory !== "function")
    throw new Error("Pinned Telegram throttler dependency changed");
  configure("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk", () =>
    factory({
      global: { maxConcurrent: 1 },
      group: { maxConcurrent: 1 },
      out: { maxConcurrent: 1 },
    }),
  );
}
