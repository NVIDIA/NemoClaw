# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# With the OpenShift profile, the chart leaves the gateway's UID and fsGroup,
# and the shared supervisor's UID, group, and fsGroup, unset, so the cluster's
# security context constraint assigns them.

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

# A shared supervisor runs only with this topology, which spec.gateway.config
# selects.
run "shared_supervisor" {
  command = plan

  variables {
    values = ["inputs/openshift-shared-supervisor.json"]
  }

  assert {
    condition     = length([for object in output.objects : object if object.kind == "Deployment" && try(object.metadata.labels["app.kubernetes.io/component"], "") == "supervisor"]) == 1
    error_message = "The gateway topology must render the chart's shared supervisor."
  }

  assert {
    condition = alltrue([
      for object in output.objects : (
        object.spec.template.spec.securityContext.runAsNonRoot
        && !can(object.spec.template.spec.securityContext.runAsUser)
        && !can(object.spec.template.spec.securityContext.runAsGroup)
        && !can(object.spec.template.spec.securityContext.fsGroup)
      ) if object.kind == "Deployment" && try(object.metadata.labels["app.kubernetes.io/component"], "") == "supervisor"
    ])
    error_message = "The shared supervisor must leave its user, group, and fsGroup to OpenShift and still run as non-root."
  }
}
