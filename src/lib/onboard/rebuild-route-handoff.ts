// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RecordedInferenceRoute } from "./provider-recovery";

export type RegistryInferenceRoute = Omit<RecordedInferenceRoute, "source"> & {
  source: "registry";
};

/** Internal, non-persisted route handoff for one destructive rebuild. */
export type RebuildRouteHandoff = {
  sandboxName: string;
  route: RegistryInferenceRoute;
};
