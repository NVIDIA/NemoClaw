# Azure Access

Use this before any selected Azure component preflight. It handles identity,
PIM/RBAC, subscription, and region selection; Terraform outputs and cluster
state are not expected yet.

## Inputs

Get these from the user or org context before running Azure preflights:

| Input | Why |
| --- | --- |
| Tenant ID/domain | Needed when `az login` lands in the wrong tenant. |
| Subscription ID/name | All Azure components must target the same subscription. |
| Region (`location`) | Drives quota, SKUs, and `deploy.tfvars`. |
| Caller CIDR (`allowed_cidr`) | Required for Azure cluster `deploy.tfvars`; derive public IP/32 when possible. |
| PIM role | Azure cluster deploy usually needs subscription `Owner`, or `Contributor` plus `User Access Administrator`. |

If the user is unsure about PIM, tell them to open Azure Portal → PIM and
activate the eligible role for the target subscription before continuing.

## Login

Use browser login when available:

```bash
az login
```

For OpenClaw or any shell that cannot open a browser, use
`components/openclaw-azure-login/reference.md` and keep the device-code command
running until the user completes auth.

## Subscription

List visible subscriptions and make the target explicit:

```bash
az account list --refresh \
  --query "[].{name:name,id:id,state:state,tenantId:tenantId,isDefault:isDefault}" \
  -o table
az account set --subscription <subscription-id-or-name>
az account show --query "{name:name,id:id,state:state,tenantId:tenantId,user:user.name}" -o table
```

Stop if the target subscription is missing or not `Enabled`. Ask the user to
switch account/tenant or activate/access the subscription; do not infer another
subscription.

## Role And Provider Access

Run the selected Azure component preflight after login, subscription selection,
and PIM activation. It checks subscription read access and required provider
reads using `az provider show`.

If provider read fails, tell the user:

```text
Activate the Azure PIM role for the target subscription, wait a minute for RBAC
propagation, then rerun the same preflight.
```

If a provider is readable but not `Registered`, ask for permission to register
it before Terraform:

```bash
az provider register --namespace <provider> --subscription <subscription-id> --wait
```

Provider registration is a subscription mutation; do not run it as part of
preflight.

## Region

Choose the region before quota checks or Terraform. Confirm Azure exposes it:

```bash
az account list-locations \
  --query "[].{name:name,displayName:displayName}" \
  -o table
```

For Azure cluster deploys, write the selected `subscription_id`, `location`, and
`allowed_cidr` to `components/cluster-azure/scripts/deploy.tfvars`, then rerun
`components/cluster-azure/scripts/preflight.sh`. The preflight validates local
tfvars when present.

## Quota

After region selection, check quota for the planned SKUs before Terraform:

```bash
az vm list-usage -l <location> -o table
```

If CPU/GPU quota is insufficient, stop and ask for a quota increase or a
different region/SKU before provisioning.
