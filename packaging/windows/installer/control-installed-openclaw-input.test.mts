// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function heldInputControl(reader: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-observer-input-"));
  const script = path.join(root, "observer.ps1");
  fs.writeFileSync(
    script,
    `$ErrorActionPreference='Stop'
[Console]::Out.WriteLine('before-reader'); [Console]::Out.Flush()
${reader}
[Console]::Out.WriteLine('discovery-entered'); [Console]::Out.Flush()
try {
  if ($inputLine.GetAwaiter().GetResult() -cne 'stop') { throw 'Invalid owned Stop input.' }
} finally {
  if (Get-Variable inputReader -ErrorAction SilentlyContinue) { $inputReader.Dispose() }
}
`,
  );
  const powershell =
    process.platform === "win32"
      ? path.join(
          process.env.SystemRoot ?? process.env.SYSTEMROOT!,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        )
      : "pwsh";
  const child = spawn(powershell, ["-NoProfile", "-File", script], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "",
    stderr = "",
    discoveryBeforeStop = false;
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => child.kill(), 15_000);
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (stdout.includes("before-reader") && !inputTimer)
      inputTimer = setTimeout(() => {
        discoveryBeforeStop = stdout.includes("discovery-entered");
        child.stdin.end("stop\n");
      }, 1000);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, stdout + stderr);
    assert(stdout.includes("discovery-entered"));
    return discoveryBeforeStop;
  } finally {
    clearTimeout(deadline);
    clearTimeout(inputTimer);
    if (child.exitCode === null) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("the exact observer reader starts discovery while its Stop pipe remains open", async () => {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "control-installed-openclaw.ps1"),
    "utf8",
  );
  const reader = source.match(/^\$inputReader = .+\r?\n\$inputLine = .+$/mu)?.[0];
  assert(reader);
  assert.equal(await heldInputControl(reader), true);
});

test("the prior Console.In call reproduces the observed pre-discovery block", async () => {
  assert.equal(await heldInputControl("$inputLine = [Console]::In.ReadLineAsync()"), false);
});
