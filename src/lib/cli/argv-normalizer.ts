// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type NormalizedRootHelpArgv = { kind: "rootHelp" };
export type NormalizedDumpCommandsArgv = { kind: "dumpCommands" };
export type NormalizedGlobalArgv = { kind: "global"; command: string; args: string[] };
export type NormalizedSandboxArgv = {
  kind: "sandbox";
  sandboxName: string;
  action: string;
  actionArgs: string[];
  connectHelpRequested: boolean;
};

export type NormalizedArgv =
  | NormalizedRootHelpArgv
  | NormalizedDumpCommandsArgv
  | NormalizedGlobalArgv
  | NormalizedSandboxArgv;

export type NormalizeArgvOptions = {
  globalCommands: ReadonlySet<string>;
  isSandboxConnectFlag: (arg: string | undefined) => boolean;
};

export function normalizeArgv(argv: readonly string[], opts: NormalizeArgvOptions): NormalizedArgv {
  const [cmd, ...args] = argv;

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    return { kind: "rootHelp" };
  }

  if (cmd === "--dump-commands") {
    return { kind: "dumpCommands" };
  }

  if (opts.globalCommands.has(cmd)) {
    return { kind: "global", command: cmd, args };
  }

  const firstSandboxArg = args[0];
  const implicitConnectArg = opts.isSandboxConnectFlag(firstSandboxArg);
  const action = !firstSandboxArg || implicitConnectArg ? "connect" : firstSandboxArg;
  const actionArgs = !firstSandboxArg || implicitConnectArg ? args : args.slice(1);

  return {
    kind: "sandbox",
    sandboxName: cmd,
    action,
    actionArgs,
    connectHelpRequested:
      action === "connect" && actionArgs.some((arg) => arg === "--help" || arg === "-h"),
  };
}

function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i++) matrix[i][0] = i;
  for (let j = 0; j < cols; j++) matrix[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[left.length][right.length];
}

export function suggestCommand(token: string, commands: Iterable<string>): string | null {
  let best: { command: string; distance: number } | null = null;
  for (const command of commands) {
    if (command.startsWith("-")) continue;
    const distance = editDistance(token, command);
    if (!best || distance < best.distance) {
      best = { command, distance };
    }
  }
  if (!best) return null;
  if (best.distance <= 1) return best.command;
  if (token.length >= 5 && best.distance <= 2) return best.command;
  return null;
}
