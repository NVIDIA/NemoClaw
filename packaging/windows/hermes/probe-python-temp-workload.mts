// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  command,
  commandPassed,
  errorDetail,
  type CommandResult,
} from "./probe-component-workload.mts";

const ADAPTER_SHA256 = "7caba44672450d3210d2bc980453035d354d9d8355b6fbc84c27d5306b0b0c82";

export function tempControlPassed(result: CommandResult, control: string, nonce: string): boolean {
  if (control === "after") return commandPassed(result, `TEMP_PARENT_CHILD_OK_${nonce}`);
  return (
    control === "before" &&
    result.exitCode !== null &&
    result.exitCode !== 0 &&
    result.error === null &&
    !result.timedOut &&
    !result.outputExceeded &&
    result.childClosed &&
    result.stdout.split(/\r?\n/u).includes(`TEMP_DIRECTORY_CREATED_${nonce}`) &&
    /PermissionError|WinError 5|Access is denied/iu.test(result.stderr)
  );
}

export function pythonTempSource(): string {
  return [
    "import hashlib, json, pathlib, subprocess, sys, tempfile",
    "nonce, control, expected_hash = sys.argv[1:]",
    "adapter = sys.modules.get('nemoclaw_native_windows')",
    "assert (adapter is not None) == (control == 'after'), 'Unexpected startup adapter state'",
    "if adapter is not None:",
    "    assert hashlib.sha256(pathlib.Path(adapter.__file__).read_bytes()).hexdigest() == expected_hash",
    "print(json.dumps({'executable': sys.executable, 'baseExecutable': sys._base_executable, 'adapterLoaded': adapter is not None, 'adapterFile': getattr(adapter, '__file__', None)}), flush=True)",
    "with tempfile.TemporaryDirectory() as directory:",
    "    print('TEMP_DIRECTORY_CREATED_' + nonce, flush=True)",
    "    target = pathlib.Path(directory) / 'parent.txt'",
    "    target.write_text(nonce, encoding='utf-8')",
    "    assert target.read_text(encoding='utf-8') == nonce",
    "    target.unlink()",
    "    assert not target.exists()",
    "assert not pathlib.Path(directory).exists()",
    "child = '''import hashlib, pathlib, sys, tempfile",
    "adapter = sys.modules.get('nemoclaw_native_windows')",
    "assert adapter is not None, 'Child startup hook did not load'",
    "assert hashlib.sha256(pathlib.Path(adapter.__file__).read_bytes()).hexdigest() == sys.argv[2]",
    "with tempfile.TemporaryDirectory() as directory:",
    "    target = pathlib.Path(directory) / 'child.txt'",
    "    target.write_text(sys.argv[1], encoding='utf-8')",
    "    assert target.read_text(encoding='utf-8') == sys.argv[1]",
    "    target.unlink()",
    "    assert not target.exists()",
    "assert not pathlib.Path(directory).exists()",
    "print('TEMP_CHILD_OK_' + sys.argv[1])'''",
    "observed = subprocess.check_output([sys.executable, '-I', '-c', child, nonce, expected_hash], text=True, timeout=15).strip()",
    "assert observed == 'TEMP_CHILD_OK_' + nonce",
    "print('TEMP_PARENT_CHILD_OK_' + nonce, flush=True)",
  ].join("\n");
}

async function main() {
  const [runtime, output, nonce, control] = process.argv.slice(2);
  if (
    process.platform !== "win32" ||
    !runtime ||
    !output ||
    !/^[a-f0-9]{24}$/u.test(nonce ?? "") ||
    !["before", "after"].includes(control ?? "")
  )
    throw new Error("Invalid contained Python temp control.");
  const components: (CommandResult & { id: string; controlPassed: boolean })[] = [];
  for (const [id, relative] of [
    ["official-venv-parent-child", "hermes-agent/venv/Scripts/python.exe"],
    [
      "official-base-parent-child",
      "hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/python.exe",
    ],
  ]) {
    const result = await command(
      path.join(runtime, relative),
      ["-I", "-c", pythonTempSource(), nonce, control, ADAPTER_SHA256],
      process.env,
      process.cwd(),
    );
    components.push({ ...result, id, controlPassed: tempControlPassed(result, control, nonce) });
  }
  const passed = components.length === 2 && components.every((value) => value.controlPassed);
  const result = {
    schemaVersion: 1,
    classification: "official-python-temp-control",
    aclVerified: false,
    tokenVerified: false,
    nonce,
    control,
    expectedAdapterSha256: ADAPTER_SHA256,
    completeRuntime: false,
    installedAcceptance: false,
    components,
    passed,
  };
  fs.writeFileSync(`${output}.tmp`, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(`${output}.tmp`, output);
  // This exit describes the control, not whether the before-adapter Python child
  // succeeded. Its real nonzero exit and denial remain in the negative receipt.
  process.exitCode = passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(JSON.stringify(errorDetail(error)));
    process.exitCode = 1;
  });
