// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CDI_HOST_ADVISORY_CHECKS } from "./cdi";
import { DOCKER_HOST_ADVISORY_CHECKS } from "./docker";
import { RUNTIME_HOST_ADVISORY_CHECKS } from "./runtime";
import { TOOLCHAIN_HOST_ADVISORY_CHECKS } from "./toolchain";

export const HOST_ADVISORY_CHECKS = Object.freeze([
  ...DOCKER_HOST_ADVISORY_CHECKS,
  ...RUNTIME_HOST_ADVISORY_CHECKS,
  ...TOOLCHAIN_HOST_ADVISORY_CHECKS,
  ...CDI_HOST_ADVISORY_CHECKS,
]);
