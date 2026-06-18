# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

###############################################################################
# NVIDIA Physical AI Azure Infrastructure
#
# AKS + GPU pool, PostgreSQL (private), Redis, Blob Storage,
# AI Foundry, Key Vault, Jumpbox, NAT Gateway, Log Analytics
#
# PostgreSQL and networking patterns from:
#   https://github.com/NVIDIA/OSMO/tree/main/deployments/terraform/azure/example
###############################################################################

locals {
  name       = "${var.resource_prefix}-${var.environment}"
  subnet_aks = cidrsubnet(var.vnet_address_space, 4, 1)
  subnet_gpu = cidrsubnet(var.vnet_address_space, 4, 2)
  subnet_db  = cidrsubnet(var.vnet_address_space, 4, 3)
  subnet_pe  = cidrsubnet(var.vnet_address_space, 4, 4)
}

data "azurerm_client_config" "current" {}

resource "random_password" "pg" {
  length  = 32
  special = false
}

resource "random_string" "suffix" {
  length  = 5
  special = false
  upper   = false
}

# ── Resource Group ──────────────────────────────────────────────────────────

resource "azurerm_resource_group" "this" {
  name     = "rg-${local.name}"
  location = var.location
  tags     = var.tags
}

# ── Virtual Network ─────────────────────────────────────────────────────────

resource "azurerm_virtual_network" "this" {
  name                = "vnet-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  address_space       = [var.vnet_address_space]
  tags                = var.tags
}

resource "azurerm_subnet" "aks" {
  name                 = "snet-aks"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [local.subnet_aks]
  service_endpoints    = ["Microsoft.Storage"] # storage account VNet access
}

resource "azurerm_subnet" "gpu" {
  name                 = "snet-gpu"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [local.subnet_gpu]
  service_endpoints    = ["Microsoft.Storage"] # storage account VNet access
}


resource "azurerm_subnet" "database" {
  name                 = "snet-database"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [local.subnet_db]

  delegation {
    name = "postgres-delegation"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "pe" {
  name                 = "snet-private-endpoints"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [local.subnet_pe]
}

# ── NAT Gateway ─────────────────────────────────────────────────────────────

resource "azurerm_public_ip" "nat" {
  name                = "pip-nat-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_nat_gateway" "this" {
  name                = "nat-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  sku_name            = "Standard"
  tags                = var.tags
}

resource "azurerm_nat_gateway_public_ip_association" "this" {
  nat_gateway_id       = azurerm_nat_gateway.this.id
  public_ip_address_id = azurerm_public_ip.nat.id
}

resource "azurerm_subnet_nat_gateway_association" "aks" {
  subnet_id      = azurerm_subnet.aks.id
  nat_gateway_id = azurerm_nat_gateway.this.id
}

resource "azurerm_subnet_nat_gateway_association" "gpu" {
  subnet_id      = azurerm_subnet.gpu.id
  nat_gateway_id = azurerm_nat_gateway.this.id
}

# ── Network Security Groups ────────────────────────────────────────────────

resource "azurerm_network_security_group" "aks" {
  name                = "nsg-aks-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = var.tags

  security_rule {
    name                       = "AllowHTTPS"
    priority                   = 1001
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefixes    = var.allowed_cidr
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "aks" {
  subnet_id                 = azurerm_subnet.aks.id
  network_security_group_id = azurerm_network_security_group.aks.id
}

resource "azurerm_network_security_group" "database" {
  name                = "nsg-database-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = var.tags

  security_rule {
    name                       = "AllowPostgreSQL"
    priority                   = 1001
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "5432"
    source_address_prefixes    = [local.subnet_aks, local.subnet_gpu]
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "database" {
  subnet_id                 = azurerm_subnet.database.id
  network_security_group_id = azurerm_network_security_group.database.id
}


# ── Log Analytics + Container Insights ──────────────────────────────────────

resource "azurerm_log_analytics_workspace" "this" {
  name                = "log-${local.name}-${random_string.suffix.result}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.tags
}

resource "azurerm_log_analytics_solution" "container_insights" {
  solution_name         = "ContainerInsights"
  location              = azurerm_resource_group.this.location
  resource_group_name   = azurerm_resource_group.this.name
  workspace_resource_id = azurerm_log_analytics_workspace.this.id
  workspace_name        = azurerm_log_analytics_workspace.this.name

  plan {
    publisher = "Microsoft"
    product   = "OMSGallery/ContainerInsights"
  }

  tags = var.tags
}

# ── AKS Cluster ─────────────────────────────────────────────────────────────

resource "azurerm_kubernetes_cluster" "this" {
  name                    = "aks-${local.name}"
  location                = azurerm_resource_group.this.location
  resource_group_name     = azurerm_resource_group.this.name
  dns_prefix              = "aks-${local.name}"
  kubernetes_version      = var.kubernetes_version
  private_cluster_enabled = false

  api_server_access_profile {
    authorized_ip_ranges = distinct(concat(var.allowed_cidr, [
      "${azurerm_public_ip.nat.ip_address}/32", # NAT gateway (pod egress to public API)
    ]))
  }

  depends_on = [azurerm_subnet_nat_gateway_association.aks]
  tags       = var.tags

  default_node_pool {
    name                        = "system"
    vm_size                     = var.system_vm_size
    auto_scaling_enabled        = true
    min_count                   = 3
    max_count                   = 6
    vnet_subnet_id              = azurerm_subnet.aks.id
    os_disk_size_gb             = 50
    max_pods                    = 110
    temporary_name_for_rotation = "systemtmp"
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin    = "azure"
    load_balancer_sku = "standard"
    service_cidr      = "192.168.0.0/16"
    dns_service_ip    = "192.168.0.10"
  }

  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  lifecycle {
    ignore_changes = [default_node_pool[0].node_count]
  }
}

# ── GPU Node Pool ───────────────────────────────────────────────────────────

resource "azurerm_kubernetes_cluster_node_pool" "gpu" {
  name                  = "gpu"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  vm_size               = var.gpu_vm_size
  vnet_subnet_id        = azurerm_subnet.gpu.id
  os_disk_size_gb       = 256
  priority              = var.gpu_priority
  eviction_policy       = var.gpu_priority == "Spot" ? "Delete" : null
  spot_max_price        = var.gpu_priority == "Spot" ? -1 : null
  auto_scaling_enabled  = true
  min_count             = var.gpu_min
  max_count             = var.gpu_max

  # Microsoft recommends skipping GPU driver installation in AKS
  # and letting NVIDIA GPU Operator handle it.
  #
  # This way we can use default GPU Operator Helm chart.
  # https://learn.microsoft.com/en-us/azure/aks/nvidia-gpu-operator#get-the-credentials-for-your-cluster
  gpu_driver = "None"

  node_taints = ["nvidia.com/gpu=present:NoSchedule"]
  node_labels = {
    "nvidia.com/gpu.present" = "true"
  }
  tags = var.tags
}

# ── PostgreSQL (private, delegated subnet) ──────────────────────────────────

resource "azurerm_private_dns_zone" "postgres" {
  name                = "${local.name}.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.this.name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "${local.name}-postgres-dns"
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.this.id
  resource_group_name   = azurerm_resource_group.this.name
  tags                  = var.tags
}

resource "azurerm_postgresql_flexible_server" "this" {
  name                          = "psql-${local.name}-${random_string.suffix.result}"
  location                      = azurerm_resource_group.this.location
  resource_group_name           = azurerm_resource_group.this.name
  version                       = var.pg_version
  sku_name                      = var.pg_sku
  storage_mb                    = var.pg_storage_mb
  administrator_login           = "postgres"
  administrator_password        = random_password.pg.result
  zone                          = "1"
  delegated_subnet_id           = azurerm_subnet.database.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled = false
  tags                          = var.tags

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]

  lifecycle {
    ignore_changes = [zone]
  }
}

resource "azurerm_postgresql_flexible_server_database" "osmo" {
  name      = "osmo"
  server_id = azurerm_postgresql_flexible_server.this.id
  collation = "en_US.utf8"
  charset   = "utf8"
}

# Osmo's backend drivers don't negotiate TLS with the Azure PG flex server — the
# supported config per Osmo's Azure TF reference is `require_secure_transport=off`
# inside the private VNet.
resource "azurerm_postgresql_flexible_server_configuration" "ssl_off" {
  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.this.id
  value     = "off"
}

resource "azurerm_postgresql_flexible_server_configuration" "extensions" {
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.this.id
  value     = "hstore,uuid-ossp,pg_stat_statements"

  depends_on = [azurerm_postgresql_flexible_server_configuration.ssl_off]
}

# ── Redis Cache ─────────────────────────────────────────────────────────────

resource "azurerm_managed_redis" "this" {
  name                = "redis-${local.name}-${random_string.suffix.result}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  sku_name            = "Balanced_B1"
  tags                = var.tags

  default_database {
    client_protocol                    = "Encrypted"
    clustering_policy                  = "EnterpriseCluster"
    eviction_policy                    = "VolatileLRU"
    access_keys_authentication_enabled = true
  }
}

resource "azurerm_private_dns_zone" "redis" {
  name                = "privatelink.redisenterprise.cache.azure.net"
  resource_group_name = azurerm_resource_group.this.name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "redis" {
  name                  = "${local.name}-redis-dns"
  private_dns_zone_name = azurerm_private_dns_zone.redis.name
  virtual_network_id    = azurerm_virtual_network.this.id
  resource_group_name   = azurerm_resource_group.this.name
  tags                  = var.tags
}

resource "azurerm_private_endpoint" "redis" {
  name                = "pe-redis-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  subnet_id           = azurerm_subnet.pe.id
  tags                = var.tags

  private_service_connection {
    name                           = "redis-connection"
    private_connection_resource_id = azurerm_managed_redis.this.id
    subresource_names              = ["redisEnterprise"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "redis-dns-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.redis.id]
  }
}

# ── Storage Account ─────────────────────────────────────────────────────────

resource "azurerm_storage_account" "this" {
  name                          = "st${var.resource_prefix}${var.environment}${random_string.suffix.result}"
  location                      = azurerm_resource_group.this.location
  resource_group_name           = azurerm_resource_group.this.name
  account_tier                  = "Standard"
  account_replication_type      = "LRS"
  public_network_access_enabled = true # auth + allowed_cidr gate access; network_rules below further restrict by source IP
  tags                          = var.tags

  network_rules {
    default_action             = "Deny"
    bypass                     = ["AzureServices"]                                         # AKS pods access via Azure backbone
    ip_rules                   = [for cidr in var.allowed_cidr : replace(cidr, "/32", "")] # local CLI access
    virtual_network_subnet_ids = [azurerm_subnet.aks.id, azurerm_subnet.gpu.id]
  }
}

resource "azurerm_storage_container" "osmo" {
  name                  = "osmo"
  storage_account_id    = azurerm_storage_account.this.id
  container_access_type = "private"
}

resource "azurerm_storage_container" "datasets" {
  name                  = "datasets"
  storage_account_id    = azurerm_storage_account.this.id
  container_access_type = "private"
}

# The OSMO CLI Azure data client authenticates with AAD for direct
# `osmo data` operations, so the deployer needs blob data-plane rights in
# addition to the storage key handed to the OSMO deployment.
resource "azurerm_role_assignment" "current_user_storage_blob_data_contributor" {
  scope                = azurerm_storage_account.this.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}

# Private endpoint for blob SA — AKS pods resolve
# storionsc*.blob.core.windows.net → PE private IP via the linked DNS zone,
# so Osmo backend + workflow tasks never touch the public endpoint / ACL.
# (Subnet service-endpoint path works for plain SDK calls from AKS but Osmo's
# DATA-credential validator returns AuthorizationFailure on the same path;
# PE bypasses firewall evaluation entirely by Azure design.)
# Pattern mirrors the Redis PE above.
resource "azurerm_private_dns_zone" "blob" {
  name                = "privatelink.blob.core.windows.net"
  resource_group_name = azurerm_resource_group.this.name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "blob" {
  name                  = "${local.name}-blob-dns"
  private_dns_zone_name = azurerm_private_dns_zone.blob.name
  virtual_network_id    = azurerm_virtual_network.this.id
  resource_group_name   = azurerm_resource_group.this.name
  tags                  = var.tags
}

resource "azurerm_private_endpoint" "blob" {
  name                = "pe-blob-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  subnet_id           = azurerm_subnet.pe.id
  tags                = var.tags

  private_service_connection {
    name                           = "blob-connection"
    private_connection_resource_id = azurerm_storage_account.this.id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "blob-dns-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.blob.id]
  }
}

# ── Key Vault ───────────────────────────────────────────────────────────────

resource "azurerm_key_vault" "this" {
  name                       = "kv-${local.name}-${random_string.suffix.result}"
  location                   = azurerm_resource_group.this.location
  resource_group_name        = azurerm_resource_group.this.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  purge_protection_enabled   = false
  rbac_authorization_enabled = true
  tags                       = var.tags
}

resource "azurerm_role_assignment" "kv_admin" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Administrator"
  principal_id         = data.azurerm_client_config.current.object_id
}

# NFS-backed Premium FileStorage SA hosting dynamic PVCs from
# `file.csi.azure.com` (see storage-class-nfs.yaml). Pre-created so TF owns
# the lifecycle end-to-end; `terraform destroy` removes it (and all shares
# inside). Without a pre-created SA the driver auto-provisions one with prefix
# `f<hex>` in whatever RG the StorageClass points at — that SA is outside TF
# state and blocks RG deletion.
#   Driver default-account behavior:
#     https://github.com/kubernetes-sigs/azurefile-csi-driver/blob/master/docs/driver-parameters.md
#   NFS on Azure Files requires Premium + FileStorage:
#     https://learn.microsoft.com/en-us/azure/storage/files/storage-files-how-to-mount-nfs-shares
resource "azurerm_storage_account" "nfs" {
  name                          = "stnfs${var.resource_prefix}${var.environment}${random_string.suffix.result}"
  location                      = azurerm_resource_group.this.location
  resource_group_name           = azurerm_resource_group.this.name
  account_tier                  = "Premium"     # FileStorage requires Premium
  account_kind                  = "FileStorage" # NFS shares require FileStorage kind
  account_replication_type      = "LRS"
  public_network_access_enabled = false # NFS shares are VNet-only; no public plane
  https_traffic_only_enabled    = false # NFS does not use HTTPS; enabling blocks NFS mounts
  tags                          = var.tags

  network_rules {
    default_action             = "Deny"
    bypass                     = ["AzureServices"]
    virtual_network_subnet_ids = [azurerm_subnet.aks.id, azurerm_subnet.gpu.id]
  }
}

# AKS CP identity roles so the Azure File CSI driver can:
#   1. Network Contributor on the VNet — add Microsoft.Storage service
#      endpoint to the subnet (NFS shares are private-VNet-only).
#   2. Storage Account Contributor scoped to stnfs*  — create file shares
#      inside the pre-provisioned NFS SA via ARM. Scoped to this SA only; does
#      NOT grant rights to create new SAs in the RG.
#   3. Network Contributor on each NSG — `subnets/write` (granted by #1) is
#      not enough when the target subnet has an NSG attached: the ARM call
#      validates `Microsoft.Network/networkSecurityGroups/join/action` on
#      the linked NSG too, and that's a separate scope from the VNet. The
#      file.csi.azure.com driver iterates ALL VNet subnets to add the
#      Microsoft.Storage service endpoint when provisioning a PVC, so it
#      needs join on every NSG attached to a sibling subnet, not just the
#      one its own pods land in. Without these grants, PVC provisioning
#      fails with `LinkedAuthorizationFailed: ...does not have permission
#      to perform action(s) Microsoft.Network/networkSecurityGroups/
#      join/action on the linked scope...`.
resource "azurerm_role_assignment" "aks_vnet_net_contrib" {
  scope                = azurerm_virtual_network.this.id
  role_definition_name = "Network Contributor"
  principal_id         = azurerm_kubernetes_cluster.this.identity[0].principal_id
}

resource "azurerm_role_assignment" "aks_nsg_aks_net_contrib" {
  scope                = azurerm_network_security_group.aks.id
  role_definition_name = "Network Contributor"
  principal_id         = azurerm_kubernetes_cluster.this.identity[0].principal_id
}

resource "azurerm_role_assignment" "aks_nsg_database_net_contrib" {
  scope                = azurerm_network_security_group.database.id
  role_definition_name = "Network Contributor"
  principal_id         = azurerm_kubernetes_cluster.this.identity[0].principal_id
}

resource "azurerm_role_assignment" "aks_nfs_sa_contrib" {
  scope                = azurerm_storage_account.nfs.id
  role_definition_name = "Storage Account Contributor"
  principal_id         = azurerm_kubernetes_cluster.this.identity[0].principal_id
}

# Private endpoint for NFS SA — NFS shares must route via PE when the SA has
# `public_network_access_enabled = false` (service-endpoint access is a
# restriction ON the public endpoint, not an alternative path, per
# https://learn.microsoft.com/en-us/azure/storage/files/storage-files-networking-overview
# "NFS file shares are accessible from the storage account's public endpoint
#  if and only if [...] restricted to specific virtual networks using service
#  endpoints"). With PNA=Disabled the public endpoint is gone entirely, so AKS
# nodes reach the NFS share via the `file` PE's private IP (resolved through
# the linked privatelink.file.core.windows.net DNS zone).
resource "azurerm_private_dns_zone" "file" {
  name                = "privatelink.file.core.windows.net"
  resource_group_name = azurerm_resource_group.this.name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "file" {
  name                  = "${local.name}-file-dns"
  private_dns_zone_name = azurerm_private_dns_zone.file.name
  virtual_network_id    = azurerm_virtual_network.this.id
  resource_group_name   = azurerm_resource_group.this.name
  tags                  = var.tags
}

resource "azurerm_private_endpoint" "nfs" {
  name                = "pe-nfs-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  subnet_id           = azurerm_subnet.pe.id
  tags                = var.tags

  private_service_connection {
    name                           = "nfs-connection"
    private_connection_resource_id = azurerm_storage_account.nfs.id
    subresource_names              = ["file"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "file-dns-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.file.id]
  }
}

# ── AI Foundry ──────────────────────────────────────────────────────────────

resource "azurerm_cognitive_account" "foundry" {
  name                       = "foundry-${local.name}-${random_string.suffix.result}"
  location                   = azurerm_resource_group.this.location
  resource_group_name        = azurerm_resource_group.this.name
  kind                       = "AIServices"
  sku_name                   = "S0"
  custom_subdomain_name      = "foundry-${local.name}-${random_string.suffix.result}"
  project_management_enabled = true
  tags                       = var.tags

  identity {
    type = "SystemAssigned"
  }
}

resource "azurerm_cognitive_account_project" "default" {
  name                 = "${var.resource_prefix}-project"
  cognitive_account_id = azurerm_cognitive_account.foundry.id
  location             = azurerm_resource_group.this.location

  identity {
    type = "SystemAssigned"
  }
}
