// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";

import { listLinuxProcListenerPids } from "../../../src/lib/adapters/openshell/forward-service-ownership.ts";

export interface DashboardListenerProcessIdentity {
  pid: number;
  uid: number;
  startTimeTicks: string;
  argv: string[];
}

function dashboardListenerProcessIds(port: number): number[] {
  const processIds = listLinuxProcListenerPids(port);
  if (processIds === null) {
    throw new Error(`Could not inspect the listener process on dashboard port ${String(port)}.`);
  }
  return [...processIds].sort((left, right) => left - right);
}

export function dashboardForwardProcessIdentity(port: number): DashboardListenerProcessIdentity {
  const processIds = dashboardListenerProcessIds(port);
  if (processIds.length !== 1) {
    throw new Error(
      `Expected one listener process on dashboard port ${String(port)}, found ${String(processIds.length)}.`,
    );
  }
  const pid = processIds[0]!;
  const processDirectory = path.join("/proc", String(pid));
  const statText = fs.readFileSync(path.join(processDirectory, "stat"), "utf8");
  const commandEnd = statText.lastIndexOf(")");
  const statFields =
    commandEnd >= 0
      ? statText
          .slice(commandEnd + 2)
          .trim()
          .split(/\s+/u)
      : [];
  const startTimeTicks = statFields[19];
  if (!startTimeTicks) {
    throw new Error(`Could not read the start time for dashboard listener process ${String(pid)}.`);
  }
  return {
    pid,
    uid: fs.statSync(processDirectory).uid,
    startTimeTicks,
    argv: fs
      .readFileSync(path.join(processDirectory, "cmdline"))
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  };
}

export async function waitForDashboardListenerToStop(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (dashboardListenerProcessIds(port).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Dashboard listener on port ${String(port)} did not stop within 30 seconds.`);
}

export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startForeignDashboardListener(port: number): Promise<Server> {
  const server = createServer((socket) => {
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nforeign");
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  return server;
}
