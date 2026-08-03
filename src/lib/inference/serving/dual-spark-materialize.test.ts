// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { fixtureDualSparkSelection } from "./dual-spark-fixture.test-support.js";
import {
  DUAL_SPARK_VLLM_API_PORT,
  DUAL_SPARK_VLLM_MASTER_PORT,
  materializeDualSparkVllmPlan,
} from "./dual-spark-materialize.js";
import { dualSparkTopologyOutputDigest } from "./dual-spark-topology.js";

describe("dual-DGX-Spark vLLM materializer", () => {
  it("creates deterministic head and worker plans from the compiled recipe", () => {
    const selection = fixtureDualSparkSelection();
    const plan = materializeDualSparkVllmPlan(selection);
    const recipe = selection.recipe.spec;

    expect(materializeDualSparkVllmPlan(selection)).toEqual(plan);
    expect(plan.model).toEqual({
      id: recipe.model.id,
      revision: recipe.model.revision,
      servedName: recipe.model.servedName,
    });
    expect(plan.roles.head).toMatchObject({
      image: recipe.runtime.image,
      runtime: {
        networkMode: recipe.runtime.networkMode,
        ipcMode: recipe.runtime.ipcMode,
        sharedMemoryBytes: recipe.runtime.sharedMemoryBytes,
        devices: recipe.runtime.devices,
        imageDownloadSizeBytes: recipe.runtime.imageDownloadSizeBytes,
      },
      preparation: {
        ref: recipe.model.preparationRef,
        modelId: recipe.model.id,
        modelRevision: recipe.model.revision,
        modelDownloadSizeBytes: recipe.model.downloadSizeBytes,
        encodingPath: recipe.model.encodingPath,
      },
    });
    expect(plan.readiness).toEqual({
      timeoutMs: recipe.readiness.timeoutSeconds * 1000,
      expectedModel: recipe.readiness.expectedModel,
    });
    expect(plan.apiPort).toBe(DUAL_SPARK_VLLM_API_PORT);
    expect(plan.masterPort).toBe(DUAL_SPARK_VLLM_MASTER_PORT);
    expect(plan.roles.head.containerName).toBe("nemoclaw-vllm-dspark-head");
    expect(plan.roles.worker.containerName).toBe("nemoclaw-vllm-dspark-worker");
  });

  it("uses role-local topology values and starts rank 1 headless", () => {
    const plan = materializeDualSparkVllmPlan(fixtureDualSparkSelection());

    expect(plan.roles.head.environment).toMatchObject({
      VLLM_HOST_IP: "192.168.100.10",
      NCCL_IB_HCA: "rocep1s0f0:1",
      NCCL_SOCKET_IFNAME: "enp1s0f0np0",
      NCCL_IB_GID_INDEX: "3",
      NODE_RANK: "0",
    });
    expect(plan.roles.worker.environment).toMatchObject({
      VLLM_HOST_IP: "192.168.100.11",
      NCCL_IB_HCA: "rocep1s0f1:1",
      NCCL_SOCKET_IFNAME: "enp1s0f1np1",
      NCCL_IB_GID_INDEX: "6",
      NODE_RANK: "1",
      HEADLESS: "1",
    });
    expect(plan.roles.head.command.arguments).toEqual(
      expect.arrayContaining(["--host", "192.168.100.10"]),
    );
    expect(plan.roles.worker.command.arguments).toEqual(
      expect.arrayContaining(["--host", "192.168.100.11"]),
    );
    expect(plan.roles.worker.command.arguments).toContain("--headless");
    expect(plan.roles.head.command.arguments).not.toContain("--headless");
    expect(plan.roles.worker.command.arguments).toEqual(
      expect.arrayContaining([
        "--tensor-parallel-size",
        "2",
        "--pipeline-parallel-size",
        "1",
        "--distributed-executor-backend",
        "mp",
        "--nnodes",
        "2",
        "--node-rank",
        "1",
        "--master-port",
        "25000",
      ]),
    );
  });

  it("preserves the fixed DSpark serving profile without embedding the API key", () => {
    const plan = materializeDualSparkVllmPlan(fixtureDualSparkSelection());
    const headArgs = plan.roles.head.command.arguments;

    expect(headArgs).toEqual(
      expect.arrayContaining([
        "--kv-cache-dtype",
        "nvfp4_ds_mla",
        "--block-size",
        "256",
        "--max-model-len",
        "1048576",
        "--max-num-seqs",
        "6",
        "--max-num-batched-tokens",
        "8192",
        "--gpu-memory-utilization",
        "0.8",
        "--moe-backend",
        "flashinfer_b12x",
        "--async-scheduling",
        "--enable-chunked-prefill",
        "--generation-config",
        "vllm",
      ]),
    );
    expect(headArgs.join(" ")).toContain('"num_speculative_tokens":5');
    expect(headArgs).not.toContain("--api-key");
    expect(plan.roles.worker.command.arguments).not.toContain("--api-key");
  });

  it("rejects materializer-owned arguments added after catalog resolution", () => {
    const selection = fixtureDualSparkSelection();
    const serve = selection.recipe.spec.serve as unknown as {
      arguments: Array<{ name: string; value?: string | number }>;
    };
    serve.arguments.push({ name: "--headless" });

    expect(() => materializeDualSparkVllmPlan(selection)).toThrow(
      /not the shipped dual-Spark profile/,
    );
  });

  it("rejects stale topology subject and output digests", () => {
    const staleSubject = fixtureDualSparkSelection();
    (staleSubject.topologyQualification as { subjectDigest: string }).subjectDigest =
      `sha256:${"f".repeat(64)}`;
    expect(() => materializeDualSparkVllmPlan(staleSubject)).toThrow(/subject digest/);

    const staleOutput = fixtureDualSparkSelection();
    (staleOutput.topologyQualification.output.peer as { target: string }).target =
      "other-worker.local";
    expect(() => materializeDualSparkVllmPlan(staleOutput)).toThrow(/output digest/);
  });

  it("rejects an inconsistent master address even with a recomputed digest", () => {
    const selection = fixtureDualSparkSelection();
    const artifact = selection.topologyQualification;
    (artifact.output as { masterAddress: string }).masterAddress = "192.168.100.99";
    (artifact as { outputDigest: string }).outputDigest = dualSparkTopologyOutputDigest(
      artifact.output,
    );

    expect(() => materializeDualSparkVllmPlan(selection)).toThrow(/master address/);
  });

  it("requires the code-owned in-container checkpoint compatibility preparation", () => {
    const preparation = materializeDualSparkVllmPlan(fixtureDualSparkSelection()).roles.head
      .preparation;

    expect(preparation).toMatchObject({
      ref: "deepseek-v4-flash-0731/v1",
      phase: "container-before-exec",
      encodingPath: "encoding/encoding_dsv4.py",
    });
    expect(preparation.encodingSourcePath).toContain(preparation.modelRevision);
    expect(preparation.encodingTargetPath).toContain("deepseek_v4_encoding.py");
    expect(preparation.reasoningCompatibility.replacementText).toContain(
      'reasoning_effort = "low"',
    );
  });

  it("rejects a recipe changed after catalog resolution", () => {
    const mutableImage = fixtureDualSparkSelection();
    (mutableImage.recipe.spec.runtime as { image: string }).image =
      "ghcr.io/anemll/dspark-vllm-gx10:0.1.1";
    expect(() => materializeDualSparkVllmPlan(mutableImage)).toThrow(
      /not the shipped dual-Spark profile/,
    );

    const changedRevision = fixtureDualSparkSelection();
    (changedRevision.recipe.spec.model as { revision: string }).revision = "d".repeat(40);
    expect(() => materializeDualSparkVllmPlan(changedRevision)).toThrow(
      /not the shipped dual-Spark profile/,
    );
  });
});
