# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# `candidate` is an authenticated, validated OCI build context supplied by the
# trusted publisher. No candidate Dockerfile instruction runs in this stage.
# hadolint ignore=DL3006
FROM candidate
