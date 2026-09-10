// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// CI-only source adaptation preserves the published diagnostic entry files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import ts from "typescript";

// A zero-context patch is admitted only against these exact source bytes.
// null binds a new file to absence; it cannot overwrite an existing module.
const PREIMAGES: Readonly<Record<string, string | null>> = {
  "packaging/windows/runtime/native-assets.mts": null,
  "packaging/windows/runtime/native-configured-inference.mts":
    "7e0d283865a54b4037e98b0a8ea80c3153e639ef6b0aa1d19d71adc7b4b2c716",
  "packaging/windows/runtime/native-dispatch.mts": null,
  "packaging/windows/runtime/native-hermes-dashboard.mts":
    "b25ba29c9a5fa2a9981373252c2ec35a1c79b5bed1f751cd1ee64bdb06c86379",
  "packaging/windows/runtime/native-inference-cli.mts":
    "e239848bd0b316acf98ada0e35cc4b5831a6d9916aaa646283956e9de92dd004",
  "packaging/windows/runtime/native-inference-host.mts":
    "247f7c2881cedc92759f7405b8c8bc550501385dc837fcd91d4781a9c909b8f4",
  "packaging/windows/runtime/native-inference-manifest.mts":
    "b8bbf293a1f8efe3d8d93a042b4ff79040fdb7e93fff5b39036c29926cfcfad6",
  "packaging/windows/runtime/native-inference.mts":
    "15748ed928be7be432cede18c7b855c2121721d34868ca69b99daa800628d6ce",
  "packaging/windows/runtime/native-main.mts": null,
  "packaging/windows/runtime/native-prebuilt-inference.mts": null,
  "packaging/windows/runtime/native-prebuilt-inference.test.mts": null,
  "packaging/windows/runtime/native-runtime-inference.mts": null,
  "packaging/windows/runtime/native-runtime.mts": null,
  "packaging/windows/runtime/native-setup-configuration.mts": null,
  "packaging/windows/runtime/native-setup-configuration.test.mts": null,
  "packaging/windows/runtime/run-installed-native-console-agent.mts":
    "f4228eaa45f37fd90c6787f400cdf9f60f1b1d06c97cc1051638ab441100ea0d",
  "packaging/windows/runtime/run-installed-native-hermes-ui.mts":
    "b23064812f6ccfdd3a7ef8bf6156754d296b1e2862489370b96ccc4f8b79fbc8",
  "packaging/windows/runtime/run-installed-native-nemocua.mts":
    "61fc7add9357f8749987d3927ea477024628c9d914467bd4bc82fbef046462bc",
  "packaging/windows/runtime/run-installed-native-pi.mts":
    "24a4378593bc61b152e45e86c27d5f8a5469195bfe37078771fd704158232f8f",
  "packaging/windows/runtime/run-installed-native-turn.mts":
    "1f58109d9ca84c0f998cb537db4237d4ac238a217b904b6d7beba34e10e46d72",
  "packaging/windows/runtime/run-installed-native-web-ui.mts":
    "678394d69a416190540ae099219c8e5944dd39a752a8434bb41c951ea64458c5",
};

export function prepareRuntimeSource(source: string, patch: string) {
  const patchBytes = fs.readFileSync(patch);
  const changes = [...patchBytes.toString("utf8").matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu)];
  if (
    changes.length !== Object.keys(PREIMAGES).length ||
    new Set(changes.map((match) => match[1])).size !== changes.length ||
    changes.some(
      (match) =>
        match[1] !== match[2] ||
        !Object.hasOwn(PREIMAGES, match[1]) ||
        !/^packaging\/windows\/runtime\/[A-Za-z0-9._/-]+$/u.test(match[1]) ||
        match[1].split("/").includes(".."),
    )
  )
    throw new Error("The static-runtime adapter contains an unexpected source path.");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "native-runtime-build-"));
  const runtime = path.join(work, "packaging", "windows", "runtime");
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const inputs: { file: string; sha256: string }[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("The runtime source contains a redirected build input.");
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile())
        inputs.push({ file: path.relative(source, file), sha256: hash(fs.readFileSync(file)) });
      else throw new Error("The runtime source contains a non-file input.");
    }
  };
  try {
    visit(source);
    fs.cpSync(source, runtime, { recursive: true });
    for (const [file, expected] of Object.entries(PREIMAGES)) {
      const target = path.join(work, file);
      if (expected === null) {
        if (fs.existsSync(target)) throw new Error("A new static-runtime source already exists.");
      } else if (!fs.existsSync(target) || hash(fs.readFileSync(target)) !== expected) {
        throw new Error("The static-runtime source does not match its reviewed preimage.");
      }
    }
    const gitConfig = path.join(work, "empty.gitconfig");
    fs.writeFileSync(gitConfig, "", { flag: "wx", mode: 0o600 });
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    execFileSync("git", ["init", "--quiet", work], { env, stdio: "pipe" });
    execFileSync("git", ["apply", "--check", "--unidiff-zero", patch], {
      cwd: work,
      env,
      stdio: "pipe",
    });
    execFileSync("git", ["apply", "--unidiff-zero", patch], { cwd: work, env, stdio: "pipe" });
    const removedDiagnosticGuards: string[] = [];
    for (const [file] of new Map(changes.map((match) => [match[1], true]))) {
      if (!file.endsWith(".mts")) continue;
      const target = path.join(work, file);
      let text = fs.readFileSync(target, "utf8");
      const syntax = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const guards = syntax.statements
        .filter(ts.isIfStatement)
        .filter((statement) =>
          statement.expression.getText(syntax).startsWith("typeof NEMOCLAW_BUNDLED_RUNTIME"),
        );
      for (const statement of guards.reverse())
        text = text.slice(0, statement.getStart(syntax)) + text.slice(statement.end);
      if (guards.length) {
        fs.writeFileSync(target, text);
        removedDiagnosticGuards.push(file);
      }
    }
    if (removedDiagnosticGuards.length !== 7)
      throw new Error("The explicit diagnostic entry inventory changed.");
    return {
      runtime,
      receipt: {
        schemaVersion: 1,
        classification: "ci-only-static-runtime-adaptation",
        adapterSha256: hash(patchBytes),
        patchContextLines: 0,
        preimagesVerified: Object.keys(PREIMAGES).length,
        inputs,
        removedDiagnosticGuards,
      },
      close: () => fs.rmSync(work, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(work, { recursive: true, force: true });
    throw error;
  }
}
