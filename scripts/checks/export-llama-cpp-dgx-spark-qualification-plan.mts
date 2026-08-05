// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { githubOutput, loadLlamaCppImageConfigFromRoot } from "./export-llama-cpp-image-config.mts";
import {
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_ACTIVATION_PATH,
  parseLlamaCppDgxSparkExecutionPlan,
  parseLlamaCppDgxSparkQualificationActivation,
  parseLlamaCppDgxSparkQualificationPlan,
} from "./llama-cpp-dgx-spark-qualification-contract.mts";

function readBoundedRegularFile(root: string, relativePath: string): string {
  const file = path.resolve(root, relativePath);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`invalid protected qualification path: ${relativePath}`);
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const status = fs.fstatSync(descriptor);
    if (!status.isFile() || status.size < 1 || status.size > 4096) {
      throw new Error(`protected qualification activation must be a bounded regular file`);
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function exportLlamaCppDgxSparkQualificationPlan(sourceRoot: string) {
  const root = fs.realpathSync(sourceRoot);
  parseLlamaCppDgxSparkQualificationActivation(
    readBoundedRegularFile(root, LLAMA_CPP_DGX_SPARK_QUALIFICATION_ACTIVATION_PATH),
  );

  const config = loadLlamaCppImageConfigFromRoot(root);
  const qualification = parseLlamaCppDgxSparkQualificationPlan(
    JSON.parse(config.publication_qualification) as unknown,
  );
  if (
    qualification.execution !== "enabled" ||
    qualification.runner === null ||
    qualification.environment === null ||
    qualification.model.hostPath === null
  ) {
    throw new Error("protected llama.cpp DGX Spark qualification is not enabled");
  }
  parseLlamaCppDgxSparkExecutionPlan(
    JSON.parse(config.publication_qualification_plan) as unknown,
    config.publication_qualification_plan_sha256,
  );

  return {
    environment: qualification.environment,
    execution: qualification.execution,
    model_host_path: qualification.model.hostPath,
    plan: config.publication_qualification_plan,
    plan_sha256: config.publication_qualification_plan_sha256,
    qualification: config.publication_qualification,
    runner: qualification.runner,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--source-root" || !args[1]) {
    throw new Error("usage: export-llama-cpp-dgx-spark-qualification-plan.mts --source-root PATH");
  }
  const output = githubOutput(exportLlamaCppDgxSparkQualificationPlan(args[1]));
  const githubOutputPath = process.env.GITHUB_OUTPUT;
  if (githubOutputPath)
    fs.appendFileSync(githubOutputPath, output, { encoding: "utf8", mode: 0o600 });
  else process.stdout.write(output);
}
