// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { buildOpenShellSubprocessEnv } from "./resolve-shared";

/** Transport evidence only; callers must establish listener ownership separately. */
export function probeLocalForwardListener(port: number): boolean {
  const script =
    "const net=require('node:net');" +
    `const s=net.createConnection({host:'127.0.0.1',port:${String(port)}});` +
    "s.setTimeout(1000);" +
    "s.on('connect',()=>{s.destroy();process.exit(0)});" +
    "s.on('error',()=>process.exit(1));" +
    "s.on('timeout',()=>{s.destroy();process.exit(1)});";
  const result = spawnSync(process.execPath, ["-e", script], {
    env: buildOpenShellSubprocessEnv(),
    stdio: "ignore",
    timeout: 2_000,
  });
  return result.status === 0;
}
