# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Registry pull Secrets the configuration names reach the gateway's and
# helper's pod templates and the sandbox driver; the chart owns none of them.

run "pull_secrets" {
  command = plan

  variables {
    values = ["inputs/pull-secrets.json"]
  }

  assert {
    condition = length([
      for object in output.objects : object
      if contains(["StatefulSet", "Job"], object.kind)
      && jsonencode(try(object.spec.template.spec.imagePullSecrets, [])) == jsonencode([{ name = "registry-team" }, { name = "registry.backup" }])
    ]) >= 2
    error_message = "The gateway and helper pod templates must name both pull Secrets."
  }

  assert {
    condition     = can(regex("image_pull_secrets\\s*=\\s*\\[\\s*\"registry-team\",\\s*\"registry.backup\",?\\s*\\]", output.configuration))
    error_message = "The sandbox driver must receive both pull Secret names."
  }

  assert {
    condition     = !anytrue([for object in output.objects : object.kind == "Secret" && contains(["registry-team", "registry.backup"], object.metadata.name)])
    error_message = "The chart must not own the caller's registry Secrets."
  }
}
