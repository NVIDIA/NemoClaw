// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  proveOllamaSystemdServiceExecutable,
  type OllamaExecutableCaptureResult,
} from "../../../src/lib/onboard/ollama-systemd/executable-proof.ts";
import { runCaptureEx } from "../../../src/lib/runner.ts";

export type OllamaProofProcessFixture = {
  childPath: string;
  childPid: number | null;
  executablePath: string;
  pidPath: string;
  root: string;
};

function capture(exitCode: number, stdout = ""): OllamaExecutableCaptureResult {
  return { exitCode, stdout, timedOut: false };
}

export function createOllamaProofProcessFixture(): OllamaProofProcessFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-proof-tree-"));
  const childPath = path.join(root, "persistent-child.sh");
  const executablePath = path.join(root, "ollama-proof.sh");
  const pidPath = path.join(root, "child.pid");
  fs.writeFileSync(childPath, "#!/bin/sh\nwhile :; do /usr/bin/sleep 1; done\n", {
    mode: 0o755,
  });
  fs.writeFileSync(
    executablePath,
    `#!/bin/sh\n${JSON.stringify(childPath)} &\nchild_pid=$!\nprintf '%s\\n' "$child_pid" > ${JSON.stringify(pidPath)}\nwait "$child_pid"\n`,
    { mode: 0o755 },
  );
  return { childPath, childPid: null, executablePath, pidPath, root };
}

export function fixtureProcessIdentityMatches(fixture: OllamaProofProcessFixture): boolean {
  if (fixture.childPid === null) return false;
  try {
    const status = fs.readFileSync(`/proc/${String(fixture.childPid)}/status`, "utf8");
    const command = fs.readFileSync(`/proc/${String(fixture.childPid)}/cmdline`, "utf8");
    const uid = status.match(/^Uid:\s+(\d+)/mu)?.[1];
    return uid === String(process.getuid?.()) && command.includes(fixture.childPath);
  } catch {
    return false;
  }
}

export function disposeOllamaProofProcessFixture(fixture: OllamaProofProcessFixture): void {
  if (fixtureProcessIdentityMatches(fixture) && fixture.childPid !== null) {
    try {
      process.kill(fixture.childPid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  fs.rmSync(fixture.root, { force: true, recursive: true });
}

export function runOllamaProofProcessFixture(
  fixture: OllamaProofProcessFixture,
  serviceUser: string,
): {
  durationMs: number;
  proof: ReturnType<typeof proveOllamaSystemdServiceExecutable>;
  systemdResult?: OllamaExecutableCaptureResult;
} {
  const proofCapture: { systemdResult?: OllamaExecutableCaptureResult } = {};
  const startedAt = Date.now();
  const proof = proveOllamaSystemdServiceExecutable({
    sudoPrefix: "sudo -n",
    readElfInterpreterImpl: () => "/bin/sh",
    runCaptureExImpl: (command, options) => {
      if (command[0] === "/usr/bin/systemctl") {
        return capture(
          0,
          `User=${serviceUser}\nExecStart={ path=${fixture.executablePath} ; argv[]=${fixture.executablePath} serve ; }`,
        );
      }
      if (command[0] === "/usr/bin/id") return capture(0, `${serviceUser}\n`);
      proofCapture.systemdResult = runCaptureEx(command, options);
      return proofCapture.systemdResult;
    },
  });
  return { durationMs: Date.now() - startedAt, proof, ...proofCapture };
}

export async function waitForOllamaProofProcessExit(
  fixture: OllamaProofProcessFixture,
): Promise<void> {
  for (let attempt = 0; attempt < 20 && fixtureProcessIdentityMatches(fixture); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
