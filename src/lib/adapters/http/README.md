<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# HTTP adapters

HTTP adapter modules isolate host-side network probes and subprocess-backed HTTP
checks from action/domain logic. Keep pure response classification in domain or
feature modules; keep `curl`, temporary files, and network-boundary behavior here.
