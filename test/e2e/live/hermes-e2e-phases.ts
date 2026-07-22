// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const HERMES_E2E_PHASES = [
  "prepare clean Hermes runner",
  "install and onboard Hermes sandbox",
  "validate sandbox layout and health",
  "restart Hermes gateway and validate supervision",
  "exercise hosted and inference.local routes",
  "validate CLI manifest and locked-config behavior",
  "finalize Hermes sandbox resources",
] as const;
