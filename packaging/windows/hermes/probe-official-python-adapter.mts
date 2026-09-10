// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { command, errorDetail, fileIdentity } from "./probe-component-workload.mts";

export const COMPONENT_ADAPTER_SHA256 =
  "7caba44672450d3210d2bc980453035d354d9d8355b6fbc84c27d5306b0b0c82";
const MARKER = "nemoclaw-windows-runtime.json";
const PTH = "import nemoclaw_native_windows; nemoclaw_native_windows.install()\n";

export function componentAdapterTargets(runtimeRoot: string) {
  return [
    path.join(runtimeRoot, "hermes-agent", "venv", "Lib", "site-packages"),
    path.join(
      runtimeRoot,
      "hermes-agent",
      ".hermes-runtime",
      "python",
      "cpython-3.11.16-windows-aarch64-none",
      "Lib",
      "site-packages",
    ),
  ];
}

export function assertUnadaptedComponent(runtimeRoot: string): void {
  for (const file of [
    path.join(runtimeRoot, MARKER),
    ...componentAdapterTargets(runtimeRoot).flatMap((directory) => [
      path.join(directory, "nemoclaw_native_windows.py"),
      path.join(directory, "000_nemoclaw_native_windows.pth"),
    ]),
  ]) {
    if (fs.existsSync(file))
      throw new Error("The negative control requires an unadapted official component tree.");
  }
}

export function installComponentAdapter(runtimeRoot: string, moduleBytes: Buffer) {
  if (createHash("sha256").update(moduleBytes).digest("hex") !== COMPONENT_ADAPTER_SHA256)
    throw new Error("The startup adapter does not match its frozen reviewed bytes.");
  assertUnadaptedComponent(runtimeRoot);
  const resolvedRoot = fs.realpathSync(runtimeRoot);
  const targets = componentAdapterTargets(runtimeRoot);
  for (const directory of targets) {
    const entry = fs.lstatSync(directory);
    const relative = path.relative(resolvedRoot, fs.realpathSync(directory));
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    )
      throw new Error("A component Python site directory is outside the owned runtime.");
  }
  const records = [];
  for (const directory of targets) {
    const module = path.join(directory, "nemoclaw_native_windows.py");
    const hook = path.join(directory, "000_nemoclaw_native_windows.pth");
    fs.writeFileSync(module, moduleBytes, { flag: "wx" });
    fs.writeFileSync(hook, PTH, { flag: "wx" });
    records.push(fileIdentity(module), fileIdentity(hook));
  }
  const marker = path.join(runtimeRoot, MARKER);
  fs.writeFileSync(
    marker,
    JSON.stringify(
      {
        schemaVersion: 1,
        manager: "nemoclaw-windows",
        hermesRevision: "2237be355906fbe6065ce1815711eee52b2d646e",
        layoutVersion: 1,
        classification: "component-startup-adapter-probe",
        completeRuntime: false,
        installedAcceptance: false,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  records.push(fileIdentity(marker));
  return records;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? null : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path.`);
  return path.resolve(value);
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "arm64")
    throw new Error("The startup adapter control requires Windows ARM64.");
  const installRoot = fs.realpathSync(argument("--install-root"));
  const runtimeRoot = fs.realpathSync(argument("--runtime-root"));
  const evidenceRoot = argument("--artifact-directory");
  if (
    !/^[A-Za-z]:\\NemoClawHermesProbe-[a-f0-9]{12}$/u.test(runtimeRoot) ||
    fs.existsSync(evidenceRoot)
  )
    throw new Error("The adapter control requires owned runtime and fresh evidence roots.");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const helpers = await import(
    pathToFileURL(path.join(installRoot, "qualification", "run-installed-native-turn.mts")).href
  );
  const environment = helpers.allowlistedWindowsEnvironment();
  const node = path.join(installRoot, "bin", "node.exe");
  const probe = fileURLToPath(new URL("./probe-official-components.mts", import.meta.url));
  const module = fileURLToPath(new URL("./nemoclaw_native_windows.py", import.meta.url));
  const receipt: Record<string, unknown> = {
    schemaVersion: 1,
    classification: "official-python-temp-startup-adapter-control",
    aclVerified: false,
    tokenVerified: false,
    completeRuntime: false,
    installedAcceptance: false,
    hermesShellQualified: false,
    adapterSha256: COMPONENT_ADAPTER_SHA256,
    status: "failed",
  };
  const runControl = async (control: "before" | "after") => {
    const output = path.join(evidenceRoot, control);
    console.log(`[Python temp] Running the ${control}-adapter control inside MXC.`);
    const result = await command(
      node,
      [
        "--experimental-strip-types",
        "--no-warnings",
        probe,
        "--install-root",
        installRoot,
        "--runtime-root",
        runtimeRoot,
        "--artifact-directory",
        output,
        "--python-temp-control",
        control,
      ],
      environment,
      evidenceRoot,
      300_000,
    );
    fs.writeFileSync(path.join(evidenceRoot, `${control}.stdout.log`), result.stdout, {
      flag: "wx",
    });
    fs.writeFileSync(path.join(evidenceRoot, `${control}.stderr.log`), result.stderr, {
      flag: "wx",
    });
    if (
      result.exitCode !== 0 ||
      result.error ||
      result.timedOut ||
      result.outputExceeded ||
      !result.childClosed
    )
      throw new Error(
        `The ${control}-adapter MXC control failed; its original output was retained.`,
      );
    const file = path.join(output, "mxc-components.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      value.classification !== "official-python-temp-control" ||
      value.pythonTempControl !== control ||
      value.verdict !== "pass"
    )
      throw new Error("The contained temp control receipt did not match its requested phase.");
    return { receipt: fileIdentity(file), workload: value.workload, cleanup: value.cleanup };
  };
  try {
    assertUnadaptedComponent(runtimeRoot);
    receipt.before = await runControl("before");
    receipt.adaptation = installComponentAdapter(runtimeRoot, fs.readFileSync(module));
    fs.writeFileSync(
      path.join(evidenceRoot, "adaptation.json"),
      JSON.stringify(receipt.adaptation, null, 2) + "\n",
      { flag: "wx" },
    );
    receipt.after = await runControl("after");
    receipt.status = "pass";
  } catch (error) {
    receipt.error = errorDetail(error);
    process.exitCode = 1;
  }
  fs.writeFileSync(
    path.join(evidenceRoot, "python-temp-adapter.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    `[Python temp] ${receipt.status}: ${path.join(evidenceRoot, "python-temp-adapter.json")}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(JSON.stringify(errorDetail(error)));
    process.exitCode = 1;
  });
