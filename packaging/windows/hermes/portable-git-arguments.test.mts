// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("./prepare-official-components.ps1", import.meta.url));
const fixture = fileURLToPath(new URL("./portable-git-arguments-fixture.ps1", import.meta.url));
const powershell =
  process.env.NEMOCLAW_TEST_POWERSHELL ??
  (process.platform === "win32"
    ? path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "pwsh");
const destination = "C:\\NemoClawHermesProbe-0123456789ab\\git";

function render(mode: "portable" | "arguments", values: string[]) {
  return spawnSync(
    powershell,
    [
      "-NoProfile",
      "-File",
      fixture,
      source,
      mode,
      Buffer.from(values.join("\0")).toString("base64"),
    ],
    { env: process.env, encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
}

function rendered(mode: "portable" | "arguments", values: string[]): string {
  const result = render(mode, values);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
}

// Independent specification of the exact upstream raw-switch grammar. This is
// not Windows extraction proof. The shipped SFX was matched (excluding signing
// fields) to build-extra5d788634; its source is SfxSetup.cpp at
// git-for-windows/7-Zip/d2a8cd8e727de1138498c208a327bc3fcaa0d244.
// In that parser, -o has explicit quote handling; -y has none.
function parseSfx26(commandLine: string) {
  let remaining = commandLine.trim();
  let assumeYes = false;
  let installPath = "";
  while (remaining.length > 0) {
    if (remaining.toLowerCase().startsWith("-y")) {
      assumeYes = true;
      remaining = remaining.slice(2).trim();
      continue;
    }
    const outputSwitch = /^(?:-o|"-o|-"o)/iu.exec(remaining);
    if (!outputSwitch) break;
    let quoted = outputSwitch[0].includes('"');
    remaining = remaining.slice(outputSwitch[0].length);
    if (!quoted) remaining = remaining.trimStart();
    let position = 0;
    for (; position < remaining.length; position += 1) {
      const character = remaining[position];
      if (character === '"') {
        if (quoted && remaining[position + 1] === '"') {
          installPath += '"';
          position += 1;
        } else quoted = !quoted;
      } else if (!quoted && (character === " " || character === "\t")) break;
      else installPath += character;
    }
    remaining = remaining.slice(position).trim();
  }
  return { assumeYes, installPath, remaining };
}

test("the old generic argv rendering fails the pinned SFX silent-mode grammar", () => {
  const commandLine = rendered("arguments", [`-o${destination}`, "-y"]);
  assert.equal(commandLine, `"-o${destination}" "-y"`);
  assert.deepEqual(parseSfx26(commandLine), {
    assumeYes: false,
    installPath: destination,
    remaining: '"-y"',
  });
});

test("the actual extractor helper emits the canonical raw line and enables silent mode", () => {
  const commandLine = rendered("portable", [destination]);
  assert.equal(commandLine, `-o"${destination}" -y`);
  assert.deepEqual(parseSfx26(commandLine), {
    assumeYes: true,
    installPath: destination,
    remaining: "",
  });
});

test("the pinned SFX grammar accepts a leading bare yes switch", () => {
  assert.deepEqual(parseSfx26(`-y -o"${destination}"`), {
    assumeYes: true,
    installPath: destination,
    remaining: "",
  });
});

test("ordinary component argv quoting stays unchanged", () => {
  assert.equal(
    rendered("arguments", ["-NoProfile", "two words", "-Stage", "python"]),
    '"-NoProfile" "two words" "-Stage" "python"',
  );
});

for (const [name, invalid] of [
  ["foreign root", "C:\\temp\\git"],
  ["path traversal", "C:\\NemoClawHermesProbe-0123456789ab\\..\\git"],
  ["extra raw switch", `${destination}\" -y -oC:\\other`],
  ["trailing newline", `${destination}\n`],
  ["wrong child", "C:\\NemoClawHermesProbe-0123456789ab\\other"],
] as const) {
  test(`the extractor helper rejects ${name}`, () => {
    const result = render("portable", [invalid]);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /owned shallow Git directory/u);
  });
}

test("generic argv still rejects embedded quotes", () => {
  const result = render("arguments", ['bad"argument']);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot be represented/u);
});
