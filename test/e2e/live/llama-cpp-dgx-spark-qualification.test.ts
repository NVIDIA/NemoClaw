// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_ACTIVATION_PATH,
  parseLlamaCppDgxSparkExecutionPlan,
  parseLlamaCppDgxSparkQualificationActivation,
  parseLlamaCppDgxSparkQualificationReceipt,
} from "../../../scripts/checks/llama-cpp-dgx-spark-qualification-contract.mts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  llamaCppDgxSparkQualificationEnvironment,
  readLlamaCppQualificationArtifact,
} from "./llama-cpp-dgx-spark-qualification-helpers.ts";

test("binds the exact NemoClaw-built llama.cpp image candidate to protected NVIDIA DGX Spark evidence (#8260)", {
  meta: {
    e2ePhases: [
      "validate trusted activation and dispatch identity",
      "validate declarative image and serving plan",
      "validate exact DGX Spark execution and cleanup evidence",
    ],
  },
}, ({ progress }) => {
  const environment = llamaCppDgxSparkQualificationEnvironment();

  progress.phase("validate trusted activation and dispatch identity");
  const activation = readLlamaCppQualificationArtifact(
    path.join(environment.activationRoot, LLAMA_CPP_DGX_SPARK_QUALIFICATION_ACTIVATION_PATH),
    environment.activationRoot,
  );
  parseLlamaCppDgxSparkQualificationActivation(activation.toString("utf8"));

  progress.phase("validate declarative image and serving plan");
  const plan = readLlamaCppQualificationArtifact(
    environment.planFile,
    path.dirname(environment.planFile),
  );
  const parsedPlan = parseLlamaCppDgxSparkExecutionPlan(
    JSON.parse(plan.toString("utf8")) as unknown,
    environment.planSha256,
  );

  progress.phase("validate exact DGX Spark execution and cleanup evidence");
  const evidence = readLlamaCppQualificationArtifact(
    environment.evidenceFile,
    environment.artifactDirectory,
  );
  expect(() =>
    parseLlamaCppDgxSparkQualificationReceipt(
      JSON.parse(evidence.toString("utf8")) as unknown,
      environment.identity,
      parsedPlan,
    ),
  ).not.toThrow();
});
