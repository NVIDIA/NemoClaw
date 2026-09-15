<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configuration contract fixtures

The YAML files are parser inputs.
Adjacent JSON files record expected serialization, digests, workspace names, and inference endpoints.

These files are parser fixtures, not authorization to apply the embedded live deployment UIDs.
Live tests must select independent identities.

The `spark.yaml` fixture exercises the inline recipe schema.
