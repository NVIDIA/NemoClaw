// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const REBUILD_HERMES_PHASES = [
  "confirm Docker and prepare Hermes rebuild resources",
  "onboard the current Hermes sandbox",
  "pull and verify the historical Hermes base fixture",
  "create the historical Hermes sandbox",
  "seed persistent Hermes state and registry metadata",
  "prepare the current-base rebuild condition",
  "rebuild the Hermes sandbox",
  "validate upgraded state inference and backup hygiene",
] as const;
