// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadManagedInferenceCatalog } from "../../src/lib/inference/serving/catalog-loader";
import { verifyHuggingFaceModelReferences } from "../../src/lib/inference/serving/hugging-face-model-verification";

async function main(): Promise<void> {
  const catalog = loadManagedInferenceCatalog();
  await verifyHuggingFaceModelReferences(catalog.models);
  console.log(`Verified ${catalog.models.length} Hugging Face model references.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
