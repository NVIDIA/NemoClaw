# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Gateway settings plan without contacting a host: the engine fixture answers
# reads only, and no cluster exists.

run "plan" {
  command = plan

  assert {
    condition = (
      data.openshell_docker_gateway_runtime.gateway.entrypoint == tolist(["/usr/local/bin/openshell-gateway"])
      && data.openshell_docker_gateway_runtime.gateway.command == tolist([
        "--config", "${var.data_path}/gateway.toml",
        "--name", "nc-0123456789abcdef-gateway",
        "--bind-address", "0.0.0.0",
        "--port", "17670",
      ])
      && toset(data.openshell_docker_gateway_runtime.gateway.env) == toset([
        "OPENSHELL_DB_URL=sqlite:${var.data_path}/gateway.db",
        "XDG_STATE_HOME=${var.data_path}/state",
      ])
    )
    error_message = "The Docker gateway must launch from its typed settings and keep its state under its data path."
  }

  assert {
    condition = alltrue([
      for line in [
        "log_level = \"debug\"",
        "sandbox_label = \"nc-0123456789abcdef-gateway\"",
        "kid_path = \"${var.data_path}/tls/jwt/kid\"",
      ] : strcontains(data.openshell_docker_gateway_runtime.gateway.config_file, line)
    ])
    error_message = "The gateway configuration must merge the authored settings: ${data.openshell_docker_gateway_runtime.gateway.config_file}"
  }

  assert {
    condition     = openshell_gateway_storage.docker.name == "nc-0123456789abcdef-gateway" && openshell_gateway_storage.docker.compute_driver == "docker"
    error_message = "The Docker gateway's storage must plan from its typed settings, without writing to the engine."
  }

  assert {
    condition     = data.openshell_gateway_prerequisites.docker.status == "available"
    error_message = "A Docker engine must host a Docker-driver gateway."
  }

  assert {
    condition     = jsondecode(data.openshell_gateway_prerequisites.podman.observation_json).reason == "Podman sandbox driver requires a Podman engine socket"
    error_message = "A Docker engine must not host a Podman-driver gateway: ${data.openshell_gateway_prerequisites.podman.observation_json}"
  }

  assert {
    condition = alltrue([
      for resource in [
        openshell_kubernetes_storage.platform,
        openshell_kubernetes_auth.platform,
        openshell_kubernetes_gateway.platform,
      ] : resource.namespace == "agents" && resource.environment == tolist(["AWS_PROFILE"])
    ])
    error_message = "Each Kubernetes resource must plan from its typed settings."
  }
}
