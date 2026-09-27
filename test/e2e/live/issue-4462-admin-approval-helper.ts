// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const ISSUE_4462_SCOPE_UPGRADE_PHASES = [
  "confirm configured runtime availability and clear the scope-upgrade sandbox",
  "install the OpenClaw sandbox",
  "prove onboarding settled operator.write",
  "trigger and approve an operator.admin request through connect",
  "record the approval contract",
] as const;
