// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const OPENCLAW_CONFIG = "/sandbox/.openclaw/openclaw.json";
const REFRESH_HELPER = "/usr/local/lib/nemoclaw/refresh-openclaw-wechat-placeholder.py";

type WechatPlaceholderRefreshDependencies = {
  readonly existsSync: (path: fs.PathLike) => boolean;
  readonly lstatSync: (path: fs.PathLike) => Pick<fs.Stats, "isFile" | "isSymbolicLink">;
  readonly spawnSync: (
    command: string,
    args: readonly string[],
    options: {
      readonly env: NodeJS.ProcessEnv;
      readonly stdio: "inherit";
      readonly timeout: number;
    },
  ) => { readonly error?: Error; readonly status: number | null };
};

export function refreshWechatAccountPlaceholder(
  dependencies: WechatPlaceholderRefreshDependencies = {
    existsSync: fs.existsSync,
    lstatSync: fs.lstatSync,
    spawnSync,
  },
): void {
  if (!dependencies.existsSync(OPENCLAW_CONFIG)) return;
  if (!dependencies.existsSync(REFRESH_HELPER)) {
    throw new Error("[SECURITY] WeChat account placeholder refresher is missing.");
  }
  const helperMetadata = dependencies.lstatSync(REFRESH_HELPER);
  if (helperMetadata.isSymbolicLink() || !helperMetadata.isFile()) {
    throw new Error("[SECURITY] WeChat account placeholder refresher is not a regular file.");
  }
  const result = dependencies.spawnSync(
    "/usr/bin/python3",
    ["-I", REFRESH_HELPER, OPENCLAW_CONFIG],
    { env: process.env, stdio: "inherit", timeout: 30_000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error("[SECURITY] WeChat account placeholder refresh failed.");
  }
}

refreshWechatAccountPlaceholder();
