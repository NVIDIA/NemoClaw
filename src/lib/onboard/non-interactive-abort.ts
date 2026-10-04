// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Greppable abort marker — bare exits get buried under model-pull progress (GH #4208).
export function abortNonInteractive(reason: string, hint?: string): never {
  console.error(`  [non-interactive] Aborting: ${reason}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}
