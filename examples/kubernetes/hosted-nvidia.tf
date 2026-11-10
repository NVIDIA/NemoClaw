# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The same managed development gateway and two sandboxes as hosted-nvidia.yaml.
# Choose one authoring path per deployment; keep its workspace and state separate.
# Pin both provider versions to the matching native bundle's manifest version.
# Adapted from examples/hcl/travel-team at 4b9f06c1c7f85724d0416a119241f6c335e23e9d.
terraform {
  required_version = "~> 1.12"
  required_providers {
    openshell = { source = "registry.opentofu.org/nvidia/openshell" }
    fabric    = { source = "registry.opentofu.org/nvidia/fabric" }
    helm      = { source = "registry.opentofu.org/hashicorp/helm", version = "= 3.3.0" }
  }
}

variable "gateway_endpoint" {
  description = "Loopback HTTPS endpoint used by command-scoped Kubernetes tunnels."
  type        = string
  default     = "https://127.0.0.1:17671"
}

variable "CLUSTER_KUBECONFIG" {
  description = "Absolute kubeconfig path for Helm; set NEMOCLAW_CLUSTER_KUBECONFIG to the same file for the OpenShell provider."
  type        = string
  sensitive   = true
}

variable "context" {
  description = "Explicit context in the selected kubeconfig."
  type        = string
  default     = "replace-with-explicit-context"
}

variable "namespace" {
  description = "Namespace for the managed gateway and caller-provisioned agent PVCs."
  type        = string
  default     = "nemoclaw-gtc-dc"
}

variable "deployment_uid" {
  description = "Fresh deployment UUID; keep it and the private Kubernetes state directory for recovery."
  type        = string
  default     = "689091f2-bca0-44c5-81bf-c9db1874d9d0"
}

variable "workspace" {
  description = "Fresh workspace name owned by this HCL deployment."
  type        = string
  default     = "gtc-dc-kubernetes-cloud"
}

variable "images" {
  description = "Linux AMD64 agent images, pushed to a registry the cluster can pull from and pinned by digest."
  type        = object({ openclaw = string, hermes = string })
  default = {
    openclaw = "registry.example.com/nemoclaw/openclaw@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    hermes   = "registry.example.com/nemoclaw/hermes@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  }
}

variable "destroy" {
  description = "Permit removing provider-owned objects during explicit teardown."
  type        = bool
  default     = false
}

provider "openshell" {
  destroy = var.destroy
}
provider "fabric" {
  destroy = var.destroy
}
provider "helm" {
  helm_driver            = "secret"
  registry_config_path   = ".helm/registry.json"
  repository_config_path = ".helm/repositories.yaml"
  repository_cache       = ".helm/cache"
  plugins_path           = ".helm/plugins"
  kubernetes = {
    config_path    = var.CLUSTER_KUBECONFIG
    config_context = var.context
  }
}

locals {
  pins         = jsondecode(file("${path.module}/versions.json"))
  gateway_name = "nc-${substr(sha256(var.deployment_uid), 0, 16)}-gateway"
  platform_images = {
    for name in ["gateway", "supervisor", "sandboxRuntime"] : name => {
      registry   = ""
      repository = split("@", local.pins.images[name])[0]
      digest     = split("@", local.pins.images[name])[1]
      pullPolicy = "IfNotPresent"
    }
  }
  gateway_settings = {
    runtime  = { provider = "kubernetes" }
    endpoint = var.gateway_endpoint
    kubernetes = {
      kubeconfig     = { env = "NEMOCLAW_CLUSTER_KUBECONFIG" }
      context        = var.context
      namespace      = var.namespace
      authentication = { profile = "development" }
    }
  }
}

resource "openshell_kubernetes_storage" "platform" {
  name                   = local.gateway_name
  owner                  = var.deployment_uid
  compute_driver         = "kubernetes"
  endpoint               = var.gateway_endpoint
  kubeconfig_env         = "NEMOCLAW_CLUSTER_KUBECONFIG"
  context                = var.context
  namespace              = var.namespace
  authentication_profile = "development"
  lifecycle {
    prevent_destroy = true
    postcondition {
      condition     = self.running == "true"
      error_message = "Managed gateway storage is not ready."
    }
  }
}

resource "openshell_kubernetes_auth" "platform" {
  name                   = local.gateway_name
  owner                  = openshell_kubernetes_storage.platform.owner
  compute_driver         = "kubernetes"
  endpoint               = var.gateway_endpoint
  kubeconfig_env         = "NEMOCLAW_CLUSTER_KUBECONFIG"
  context                = var.context
  namespace              = var.namespace
  authentication_profile = "development"
  lifecycle {
    postcondition {
      condition     = self.running == "true"
      error_message = "Managed gateway development authentication is not ready."
    }
  }
}

resource "helm_release" "gateway" {
  depends_on       = [openshell_kubernetes_auth.platform]
  name             = local.gateway_name
  namespace        = var.namespace
  chart            = local.pins.images.gatewayChart
  create_namespace = false
  take_ownership   = false
  upgrade_install  = false
  atomic           = true
  wait             = true
  wait_for_jobs    = true
  timeout          = 600
  values = [jsonencode({
    fullnameOverride = local.gateway_name
    global           = { image = { registry = "" } }
    gateway          = { image = local.platform_images.gateway }
    supervisor       = { image = local.platform_images.supervisor }
    sandboxRuntime   = { image = local.platform_images.sandboxRuntime }
    sandbox          = { image = local.platform_images.sandboxRuntime }
    server = {
      telemetryEnabled = false
      disableTls       = false
      tls = {
        enableMtls          = true
        certSecretName      = "${local.gateway_name}-server-tls"
        clientTlsSecretName = "${local.gateway_name}-client-tls"
      }
      sandboxJwt        = { signingSecretName = "${local.gateway_name}-jwt-keys" }
      credentialStorage = { existingSecret = "${local.gateway_name}-kek" }
      oidc              = { caConfigMapName = "${local.gateway_name}-oidc-ca" }
    }
    gatewayConfig = {
      "openshell.gateway.auth" = { allow_unauthenticated_users = false }
      "openshell.gateway.oidc" = {
        issuer                          = "https://${local.gateway_name}-oidc.${var.namespace}.svc.cluster.local:8443"
        audience                        = var.deployment_uid
        jwks_ttl_secs                   = 60
        roles_claim                     = "roles"
        admin_role                      = "nemoclaw-development-admin"
        user_role                       = "nemoclaw-development-user"
        scopes_claim                    = "scope"
        dangerously_allow_insecure_http = false
      }
      "openshell.drivers.kubernetes" = {
        workspace_mode                 = "shared"
        workspace_default_storage_size = "2Gi"
        allow_driver_config            = true
      }
    }
    pkiInitJob = { enabled = true }
    resources = {
      requests = { cpu = "250m", memory = "256Mi" }
      limits   = { cpu = "1", memory = "1Gi" }
    }
  })]
}

resource "openshell_kubernetes_gateway" "platform" {
  depends_on             = [helm_release.gateway]
  name                   = local.gateway_name
  owner                  = openshell_kubernetes_storage.platform.owner
  generation             = openshell_kubernetes_auth.platform.generation
  compute_driver         = "kubernetes"
  endpoint               = var.gateway_endpoint
  kubeconfig_env         = "NEMOCLAW_CLUSTER_KUBECONFIG"
  context                = var.context
  namespace              = var.namespace
  authentication_profile = "development"
  lifecycle {
    postcondition {
      condition     = self.running == "true"
      error_message = "Managed Kubernetes gateway is not ready."
    }
  }
}

data "openshell_gateway" "current" {
  depends_on = [openshell_kubernetes_gateway.platform]
  endpoint   = var.gateway_endpoint
  kubernetes = jsonencode({
    layout     = 1
    kind       = "kubernetes_gateway"
    name       = local.gateway_name
    owner      = openshell_kubernetes_storage.platform.owner
    generation = openshell_kubernetes_auth.platform.generation
    settings   = local.gateway_settings
  })
  required_compute_drivers = ["kubernetes"]
}

locals {
  agents = {
    openclaw = {
      adapter_id   = "nvidia.fabric.openclaw"
      metadata_env = "NEMOCLAW_OPENCLAW_IMAGE_METADATA"
    }
    hermes = {
      adapter_id   = "nvidia.fabric.hermes"
      metadata_env = "NEMOCLAW_HERMES_IMAGE_METADATA"
    }
  }
  inference = {
    endpoint = "https://integrate.api.nvidia.com/v1"
    model    = "nvidia/nemotron-3.5-super-vl-120b-a12b"
    api      = "openai-completions"
  }
  binaries = { for name, harness in data.fabric_harness.agent : name => jsondecode(harness.launch_json).binaries }
  configurations = {
    for name, agent in local.agents : name => {
      adapter_id  = agent.adapter_id
      model       = local.inference.model
      endpoint    = local.inference.endpoint
      api_key_env = openshell_inference.cloud[name].sandbox_env
    }
  }
}

data "fabric_harness" "agent" {
  for_each     = local.agents
  engine       = ""
  image        = var.images[each.key]
  metadata_env = each.value.metadata_env
  adapter_id   = each.value.adapter_id
  agent_name   = each.key
  lifecycle {
    postcondition {
      condition     = self.available
      error_message = "The matching agent image metadata must provide the selected Fabric harness."
    }
  }
}

resource "openshell_workspace" "deployment" {
  gateway = data.openshell_gateway.current.ref
  name    = var.workspace
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = data.openshell_gateway.current.compatible
      error_message = "The managed gateway must support the Kubernetes compute driver."
    }
  }
}

# As in the YAML compiler, each image/harness gets its own executable-bound
# registration for the shared cloud endpoint and credential reference.
resource "openshell_inference" "cloud" {
  for_each  = local.agents
  gateway   = data.openshell_gateway.current.ref
  workspace = openshell_workspace.deployment.ref
  name      = "hosted-nvidia-${each.key}"
  server = {
    type              = "inference_server"
    endpoint          = local.inference.endpoint
    credential_env    = "NVIDIA_INFERENCE_API_KEY"
    credential_source = ""
  }
  api      = local.inference.api
  binaries = local.binaries[each.key]
}

resource "terraform_data" "agent_config" {
  for_each = local.configurations
  input    = jsonencode(each.value)
}

resource "openshell_sandbox" "agent" {
  for_each    = local.agents
  gateway     = data.openshell_gateway.current.ref
  workspace   = openshell_workspace.deployment.ref
  owner       = openshell_workspace.deployment.owner
  name        = each.key
  image       = var.images[each.key]
  launch_json = data.fabric_harness.agent[each.key].launch_json
  providers   = [openshell_inference.cloud[each.key].ref]
  driver_config = jsonencode({
    kubernetes = {
      volumes = [{
        name = "agent-data"
        persistent_volume_claim = {
          claim_name = "gtc-dc-${each.key}-data"
          read_only  = false
        }
      }]
      containers = {
        agent = {
          volume_mounts = [for directory in ["workspace", "artifacts"] : {
            name       = "agent-data"
            mount_path = "/sandbox/${directory}"
            sub_path   = directory
            read_only  = false
          }]
        }
      }
    }
  })
  policy {
    explicit {
      version = 1
      process {
        run_as_user  = "10001"
        run_as_group = "10001"
      }
      filesystem_policy {
        include_workdir = true
        read_only = concat(
          ["/usr", "/opt/fabric", "/opt/nemoclaw", "/app"],
          each.key == "hermes" ? ["/opt/hermes", "/opt/nemo-relay/plugins/switchyard", "/etc/ssl/certs/ca-certificates.crt"] : [],
        )
        # Hermes's browser chat opens pseudo-terminals in /dev/pts.
        read_write = concat(["/sandbox"], each.key == "hermes" ? ["/dev/pts"] : [])
      }
      network_policies "hosted-inference" {
        name = "hosted-inference"
        endpoints {
          host = "integrate.api.nvidia.com"
          port = 443
        }
        binaries {
          path = each.key == "hermes" ? "/usr/local/bin/hermes" : "/usr/bin/openclaw"
        }
      }
    }
    managed {
      name = "nemoclaw-inference-${openshell_inference.cloud[each.key].name}"
      dynamic "binaries" {
        for_each = local.binaries[each.key]
        content {
          path = binaries.value
        }
      }
      endpoints {
        host     = "integrate.api.nvidia.com"
        port     = 443
        path     = "/v1/**"
        protocol = "rest"
        access   = "full"
      }
    }
  }
  lifecycle {
    replace_triggered_by = [terraform_data.agent_config[each.key]]
  }
}

resource "fabric_agent" "agent" {
  for_each = local.agents
  gateway  = data.openshell_gateway.current.ref
  sandbox  = openshell_sandbox.agent[each.key].ref
  harness  = data.fabric_harness.agent[each.key].ref
  name     = each.key
  dynamic "models" {
    for_each = ["default", "primary"]
    labels   = [models.value]
    content {
      provider    = "openai"
      model       = local.inference.model
      base_url    = local.inference.endpoint
      api_key_env = openshell_inference.cloud[each.key].sandbox_env
    }
  }
}
