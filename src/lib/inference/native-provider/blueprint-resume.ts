// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  observeBlueprintCreatedInference,
  publishBlueprintNativeConfiguration,
  readBlueprintRunPlan,
  type BlueprintNativeReceipt,
} from "./blueprint";

/** Resume a recorded configuration write without acquiring new resource authority. */
export async function resumeBlueprintNativeInferenceRun(
  input: Readonly<{
    runId: string;
    gateway: Readonly<{ name: string; host: string; port: number }>;
    sandboxName: string;
    revalidate: () => Promise<void>;
  }>,
  deps?: Parameters<typeof publishBlueprintNativeConfiguration>[2],
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/u.test(input.runId)) throw new Error("Invalid blueprint recovery run ID.");
  const runs = path.join(os.homedir(), ".nemoclaw/state/runs");
  const directory = path.join(runs, input.runId);
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory())
    throw new Error("Blueprint recovery requires its original run directory.");
  const file = path.join(directory, "plan.json");
  const read = (): unknown => {
    const current = fs.lstatSync(file);
    if (
      !current.isFile() ||
      current.nlink !== 1 ||
      fs.existsSync(path.join(directory, "rolled_back"))
    )
      throw new Error("Blueprint recovery requires an unchanged, unshared run receipt.");
    return readBlueprintRunPlan(file, metadata);
  };
  const source = read();
  if (!source || typeof source !== "object" || Array.isArray(source))
    throw new Error("Blueprint recovery requires a valid run receipt.");
  const plan = source as Record<string, unknown>;
  const value = plan.native_inference;
  if (
    plan.run_id !== input.runId ||
    plan.sandbox_name !== input.sandboxName ||
    !isDeepStrictEqual(plan.gateway, input.gateway) ||
    plan.sandbox_created_by_apply !== true ||
    plan.inference_provider_created_by_apply !== true ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new Error("Blueprint recovery receipt does not match this run's resource ownership.");
  const receipt = value as BlueprintNativeReceipt;
  if (
    receipt.gatewayName !== input.gateway.name ||
    receipt.sandboxName !== input.sandboxName ||
    !receipt.sandboxId ||
    !receipt.providerAttachment ||
    (receipt.configPublished !== undefined && receipt.configPublished !== true)
  )
    throw new Error("Blueprint recovery requires recorded sandbox and provider identities.");
  const requireSamePlan = (): void => {
    if (!isDeepStrictEqual(read(), source))
      throw new Error("Blueprint recovery receipt changed; preserve the run for manual recovery.");
  };
  const revalidate = async (): Promise<void> => {
    requireSamePlan();
    await input.revalidate();
    requireSamePlan();
  };
  await revalidate();
  if (receipt.configPublished === true) {
    await observeBlueprintCreatedInference(receipt, receipt, deps);
    await revalidate();
    return;
  }
  await publishBlueprintNativeConfiguration(receipt, revalidate, deps);
  await revalidate();
  const pending = path.join(directory, `.resume-${randomUUID()}.json`);
  let created = false;
  try {
    const fd = fs.openSync(pending, "wx", 0o600);
    created = true;
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify(
          {
            ...plan,
            native_inference: { ...receipt, configPublished: true },
          },
          null,
          2,
        ),
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    requireSamePlan();
    fs.renameSync(pending, file);
    created = false;
    const directoryFd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } finally {
    if (created) fs.unlinkSync(pending);
  }
}
