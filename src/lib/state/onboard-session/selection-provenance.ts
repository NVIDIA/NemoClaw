// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Shared validation for the two route-selection receipts persisted in an onboard session. */
export {
  readModelSelectionProvenance,
  type ModelSelectionProvenance,
} from "../../domain/telemetry/provenance";
export {
  parseServingProfileProvenance,
  type ServingProfileProvenance,
} from "../../inference/serving/profile-provenance";
