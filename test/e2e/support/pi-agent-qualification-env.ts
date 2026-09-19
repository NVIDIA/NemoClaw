// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function createPiQualificationEnvironment(
  inferenceEnv: NodeJS.ProcessEnv,
  catalogPath: string,
): NodeJS.ProcessEnv {
  return {
    ...inferenceEnv,
    NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: catalogPath,
    NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON: "",
  };
}
