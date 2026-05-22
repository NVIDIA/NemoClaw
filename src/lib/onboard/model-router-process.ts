// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as http from "node:http";
import type { Session } from "../state/onboard-session";

export const ROUTER_HEALTH_TIMEOUT_MS = 3000;

export async function isRouterHealthy(
  port: number,
  timeoutMs = ROUTER_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      resolve(healthy);
    };
    const request = http
      .get(`http://127.0.0.1:${port}/health`, (res: http.IncomingMessage) => {
        res.resume();
        settle((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300);
      })
      .on("error", () => settle(false));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      settle(false);
    });
  });
}

export function isProcessRunning(pid: number | null | undefined): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopModelRouterProcess(pid: number, port: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let _attempt = 0; _attempt < 10; _attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!isProcessRunning(pid) && !(await isRouterHealthy(port, 1000))) return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already stopped
  }
  for (let _attempt = 0; _attempt < 5; _attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!isProcessRunning(pid) && !(await isRouterHealthy(port, 1000))) return;
  }
}

export async function stopTrackedModelRouterForAgentChange(
  session: Pick<Session, "routerPid"> | null,
  port: number,
): Promise<void> {
  const recordedPid = session?.routerPid ?? null;
  if (!recordedPid) return;
  await stopModelRouterProcess(recordedPid, port);
}
