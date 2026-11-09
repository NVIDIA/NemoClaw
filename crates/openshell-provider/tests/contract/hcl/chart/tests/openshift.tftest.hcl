# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# With the OpenShift profile, the chart leaves the gateway's UID and fsGroup
# unset, so the cluster's security context constraint assigns them.

run "openshift" {
  command = plan

  variables {
    values = ["inputs/openshift.json"]
  }

  assert {
    condition = (
      !strcontains(output.manifest, "runAsUser:")
      && !strcontains(output.manifest, "fsGroup:")
      && strcontains(output.manifest, "runAsNonRoot: true")
    )
    error_message = "The gateway must leave its user and fsGroup to OpenShift and still run as non-root."
  }

  assert {
    condition = length(setintersection(
      toset([for object in output.objects : "${object.kind}/${object.metadata.name}"]),
      toset([for object in jsondecode(file("inputs/prepared.json")) : "${object.kind}/${object.name}"]),
    )) == 0 && !anytrue([for object in output.objects : object.kind == "Namespace"])
    error_message = "Helm must not own a namespace or any object NemoClaw prepares."
  }
}
