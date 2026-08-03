// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  cleanupInstalledDualSparkVllmRuntime,
  dualSparkVllmRuntimeReceiptPath,
} from "./serving/spark-runtime-receipt";
import {
  cleanupInstalledDualStationVllmRuntime,
  dualStationVllmRuntimeReceiptPath,
} from "./vllm-station-runtime-receipt";

function pathExistsNoFollow(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function requestedReceipt(): {
  readonly filePath: string;
  readonly stateDir: string;
  readonly topology: "spark" | "station";
} {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new Error("managed distributed vLLM cleanup requires one exact receipt path");
  }
  const filePath = args[0]!;
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    throw new Error("managed distributed vLLM cleanup receipt path is invalid");
  }
  const stateDir = path.dirname(filePath);
  if (filePath === dualSparkVllmRuntimeReceiptPath(stateDir)) {
    return { filePath, stateDir, topology: "spark" };
  }
  if (filePath === dualStationVllmRuntimeReceiptPath(stateDir)) {
    return { filePath, stateDir, topology: "station" };
  }
  throw new Error("managed distributed vLLM cleanup receipt name is unsupported");
}

async function main(): Promise<void> {
  const receipt = requestedReceipt();
  if (!pathExistsNoFollow(receipt.filePath)) {
    throw new Error(`managed distributed vLLM receipt disappeared: ${receipt.filePath}`);
  }
  const otherReceipt =
    receipt.topology === "spark"
      ? dualStationVllmRuntimeReceiptPath(receipt.stateDir)
      : dualSparkVllmRuntimeReceiptPath(receipt.stateDir);
  if (pathExistsNoFollow(otherReceipt)) {
    throw new Error(
      "both dual-Spark and dual-Station runtime receipts exist; refusing ambiguous cleanup",
    );
  }

  if (receipt.topology === "spark") {
    const spark = await cleanupInstalledDualSparkVllmRuntime({ stateDir: receipt.stateDir });
    if (spark.kind !== "removed" || pathExistsNoFollow(receipt.filePath)) {
      throw new Error("the requested dual-Spark runtime receipt was not removed");
    }
    console.log(
      spark.removedContainerIds.length > 0
        ? `Removed managed dual-Spark vLLM containers: ${spark.removedContainerIds.join(", ")}`
        : "Removed managed dual-Spark vLLM state; no receipt-owned containers remained.",
    );
    return;
  }

  const station = await cleanupInstalledDualStationVllmRuntime({ stateDir: receipt.stateDir });
  if (station.kind !== "removed" || pathExistsNoFollow(receipt.filePath)) {
    throw new Error("the requested dual-Station runtime receipt was not removed");
  }
  console.log(
    station.removedContainerIds.length > 0
      ? `Removed managed dual-Station vLLM containers: ${station.removedContainerIds.join(", ")}`
      : "Removed managed dual-Station vLLM state; no receipt-owned containers remained.",
  );
}

main().catch((error: unknown) => {
  console.error(
    `Refusing uninstall before managed distributed vLLM cleanup: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
