// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface LlamaCppPrivateBridgeArguments {
  readonly transactionId: string;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly listenPort: number;
  readonly bindAddresses: readonly ["127.0.0.1", string];
}

function exactPort(value: string, label: string): number {
  const port = /^[0-9]{1,5}$/u.test(value) ? Number(value) : -1;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} is invalid`);
  }
  return port;
}

function isPrivateIpv4(value: string): boolean {
  if (!net.isIPv4(value)) return false;
  const [first, second] = value.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168)
  );
}

export function parseLlamaCppPrivateBridgeArguments(
  argv: readonly string[],
): LlamaCppPrivateBridgeArguments {
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("private bridge arguments must be exact key/value pairs");
    }
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const one = (key: string): string => {
    const candidates = values.get(key);
    if (!candidates || candidates.length !== 1) throw new Error(`${key} must be provided once`);
    return candidates[0]!;
  };
  const transactionId = one("--transaction");
  const targetHost = one("--target-host");
  const bindAddresses = values.get("--bind-address") ?? [];
  const supported = new Set([
    "--transaction",
    "--target-host",
    "--target-port",
    "--listen-port",
    "--bind-address",
  ]);
  if ([...values.keys()].some((key) => !supported.has(key))) {
    throw new Error("private bridge received an unsupported argument");
  }
  if (
    !SHA256.test(transactionId) ||
    !isPrivateIpv4(targetHost) ||
    bindAddresses.length !== 2 ||
    bindAddresses[0] !== "127.0.0.1" ||
    !isPrivateIpv4(bindAddresses[1]!) ||
    bindAddresses[1] === targetHost
  ) {
    throw new Error("private bridge authority is invalid");
  }
  return Object.freeze({
    transactionId,
    targetHost,
    targetPort: exactPort(one("--target-port"), "target port"),
    listenPort: exactPort(one("--listen-port"), "listen port"),
    bindAddresses: Object.freeze(["127.0.0.1", bindAddresses[1]!]) as readonly [
      "127.0.0.1",
      string,
    ],
  });
}

export async function runLlamaCppPrivateBridge(
  authority: LlamaCppPrivateBridgeArguments,
): Promise<void> {
  const servers = authority.bindAddresses.map((host) =>
    net.createServer({ allowHalfOpen: false, pauseOnConnect: true }, (client) => {
      const upstream = net.createConnection({
        host: authority.targetHost,
        port: authority.targetPort,
      });
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", close);
      upstream.on("error", close);
      upstream.once("connect", () => {
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
    }),
  );

  const close = () => {
    for (const server of servers) server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  await Promise.all(
    servers.map(
      (server, index) =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(
            { host: authority.bindAddresses[index]!, port: authority.listenPort, exclusive: true },
            () => resolve(),
          );
        }),
    ),
  );
  await new Promise<void>((_resolve, reject) => {
    for (const server of servers) server.once("error", reject);
  });
}

if (require.main === module) {
  runLlamaCppPrivateBridge(parseLlamaCppPrivateBridgeArguments(process.argv.slice(2))).catch(
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
