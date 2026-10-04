// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resultText, shellQuote } from "./clients/command.ts";
import {
  type SandboxClient,
  sandboxAccessEnv,
  trustedSandboxShellScript,
} from "./clients/sandbox.ts";
import type { ShellProbeRunOptions } from "./shell-probe.ts";

export interface HermesSessionRow {
  id: string;
  last_active: number;
  message_count: number;
  preview: string;
}

const SESSION_ROW_SCRIPT =
  "from hermes_state import SessionDB; import json, sys; row = next((r for r in SessionDB().list_sessions_rich(limit=200) if r['id'] == sys.argv[1]), None); assert row is not None, sys.argv[1]; print(json.dumps({'id': row['id'], 'last_active': row['last_active'], 'message_count': row['message_count'], 'preview': row['preview']}))";

export async function hermesSessionRow(
  sandbox: SandboxClient,
  sandboxName: string,
  sessionId: string,
  artifactName: string,
): Promise<HermesSessionRow> {
  const result = await sandbox.exec(
    sandboxName,
    ["/opt/hermes/.venv/bin/python", "-c", SESSION_ROW_SCRIPT, sessionId],
    { artifactName, env: sandboxAccessEnv(), timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) throw new Error(resultText(result));
  const row = JSON.parse(result.stdout) as HermesSessionRow;
  if (typeof row.last_active !== "number") {
    throw new Error(`Hermes session row missing numeric last_active: ${result.stdout}`);
  }
  return row;
}

export async function hermesLastActive(
  sandbox: SandboxClient,
  sandboxName: string,
  sessionId: string,
  artifactName: string,
): Promise<number> {
  return (await hermesSessionRow(sandbox, sandboxName, sessionId, artifactName)).last_active;
}

export async function exportHermesSession(
  sandbox: SandboxClient,
  sandboxName: string,
  sessionId: string,
  exportPath: string,
  prompts: [string, string, string],
  options: ShellProbeRunOptions,
): Promise<void> {
  const exportScript = [
    `rm -f ${shellQuote(exportPath)}`,
    `hermes sessions export --session-id ${shellQuote(sessionId)} ${shellQuote(exportPath)}`,
    `python3 -c ${shellQuote("import json,sys\nraw=open(sys.argv[1],encoding='utf-8').read()\ntry:\n    docs=[json.loads(raw)]\nexcept Exception:\n    docs=[json.loads(line) for line in raw.splitlines() if line.strip()]\nmsgs=[]\ndef walk(v):\n    if isinstance(v,dict) and isinstance(v.get('messages'),list):\n        [walk(item) for item in v['messages']]\n    elif isinstance(v,dict) and isinstance(v.get('role'),str) and 'content' in v:\n        content=v['content'] if isinstance(v['content'],str) else json.dumps(v['content'],sort_keys=True)\n        msgs.append((v['role'],content))\n    elif isinstance(v,dict):\n        [walk(item) for item in v.values()]\n    elif isinstance(v,list):\n        [walk(item) for item in v]\n[walk(doc) for doc in docs]\ndef pos(prompt):\n    return next((i for i,(role,content) in enumerate(msgs) if role=='user' and prompt in content),-1)\ns,r,c=[pos(prompt) for prompt in sys.argv[2:5]]\nassert 0 <= s < r < c, msgs\nassert any(role=='assistant' for role,_ in msgs[r+1:c]), msgs\nassert any(role=='assistant' for role,_ in msgs[c+1:]), msgs")} ${shellQuote(exportPath)} ${prompts.map(shellQuote).join(" ")}`,
    `cat ${shellQuote(exportPath)}`,
  ].join(" && ");
  const result = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(exportScript),
    options,
  );
  if (result.exitCode !== 0) throw new Error(resultText(result));
}
