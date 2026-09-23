// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";

const GATEWAY_STOP_TIMEOUT_MS = 2_000;

export function externalGatewayHealthProcessStopped(gateway: ChildProcess): boolean {
  return gateway.exitCode !== null || gateway.signalCode !== null;
}

function waitForGatewayStop(gateway: ChildProcess): Promise<boolean> {
  if (externalGatewayHealthProcessStopped(gateway)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (stopped: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      gateway.off("exit", onExit);
      resolve(stopped);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(
      () => finish(externalGatewayHealthProcessStopped(gateway)),
      GATEWAY_STOP_TIMEOUT_MS,
    );
    timer.unref();
    gateway.once("exit", onExit);
    if (externalGatewayHealthProcessStopped(gateway)) finish(true);
  });
}

export async function stopExternalGatewayHealthGateway(gateway: ChildProcess): Promise<void> {
  if (externalGatewayHealthProcessStopped(gateway)) return;
  gateway.kill("SIGTERM");
  if (await waitForGatewayStop(gateway)) return;
  gateway.kill("SIGKILL");
  if (!(await waitForGatewayStop(gateway))) {
    throw new Error("external gateway health gateway did not stop after SIGKILL");
  }
}
