# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The integration test root. Each tests/<scenario>.tftest.hcl applies
# ./cases/<scenario>, which the runner compiles from ../cases/<scenario>.yaml
# beside a copy of harness/main.tf.

terraform {
  required_version = "= 1.12.9"
}
