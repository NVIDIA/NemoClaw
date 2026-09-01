// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandRunner } from "../fixtures/clients/command.ts";
import type { ShellProbeResult, TrustedShellCommand } from "../fixtures/shell-probe.ts";

export type SyntheticPolicyEndpoint = {
  host: string;
  port: number;
  protocol: string;
  request_body_credential_rewrite?: boolean;
  websocket_credential_rewrite?: boolean;
  credential_binding?: { provider: string };
};

function commandResult(command: TrustedShellCommand): ShellProbeResult {
  return {
    artifacts: { result: "", stderr: "", stdout: "" },
    command: [command.command, ...command.args],
    exitCode: 0,
    signal: null,
    stderr: "",
    stdout: "",
    timedOut: false,
  };
}

function consumeEndpoint(spec: string): SyntheticPolicyEndpoint {
  const match = /^([^:]+):([1-9][0-9]*):read-write:(rest|websocket):enforce:([^,]+)(?:,.*)?$/u.exec(
    spec,
  );
  if (!match) {
    throw new Error(`synthetic policy consumer rejected endpoint ${JSON.stringify(spec)}`);
  }
  const [, host, rawPort, protocol, rewrite] = match;
  if (rewrite !== "request-body-credential-rewrite" && rewrite !== "websocket-credential-rewrite") {
    throw new Error(`synthetic policy consumer rejected credential rewrite ${String(rewrite)}`);
  }
  return {
    host: host!,
    port: Number(rawPort),
    protocol: protocol!,
    ...(rewrite === "request-body-credential-rewrite"
      ? { request_body_credential_rewrite: true }
      : { websocket_credential_rewrite: true }),
  };
}

export class SyntheticFakeApiPolicyConsumer implements CommandRunner {
  endpoints: SyntheticPolicyEndpoint[] = [];

  constructor(private readonly openshellPath: string) {}

  async run(command: TrustedShellCommand): Promise<ShellProbeResult> {
    switch (command.command) {
      case this.openshellPath:
        if (command.args[0] !== "policy" || command.args[1] !== "update" || !command.args[2]) {
          throw new Error("synthetic policy consumer expected a policy update");
        }
        this.endpoints = command.args
          .flatMap((value, index) =>
            value === "--add-endpoint" ? [command.args[index + 1] ?? ""] : [],
          )
          .map(consumeEndpoint);
        if (this.endpoints.length === 0) {
          throw new Error("synthetic policy consumer received no endpoints");
        }
        break;
      case "bash": {
        const rawBindings = command.args.slice(-(this.endpoints.length * 4));
        if (rawBindings.length !== this.endpoints.length * 4) {
          throw new Error("synthetic policy consumer received incomplete credential bindings");
        }
        Array.from({ length: this.endpoints.length }).forEach((_, index) => {
          const [provider, host, rawPort, protocol] = rawBindings.slice(index * 4, index * 4 + 4);
          const endpoint = this.endpoints.find(
            (candidate) =>
              candidate.host === host &&
              candidate.port === Number(rawPort) &&
              candidate.protocol === protocol,
          );
          if (!provider || !endpoint) {
            throw new Error("synthetic policy consumer could not bind an endpoint");
          }
          endpoint.credential_binding = { provider };
        });
        break;
      }
      default:
        throw new Error(`synthetic policy consumer rejected command ${command.command}`);
    }
    return commandResult(command);
  }
}
