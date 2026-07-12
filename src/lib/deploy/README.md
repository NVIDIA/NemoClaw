<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy

Deploy modules support remote/Brev compatibility flows and build-image setup that
has not yet been split into action/domain/adapter layers. Prefer new orchestration
in `src/lib/actions/**` and pure deploy planning helpers in `src/lib/domain/**`.
