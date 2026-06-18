# Azure AI Foundry Inference

> **Docs:** https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/deploy-models-serverless

## Prerequisites

| Requirement | Details |
|-------------|---------|
| Azure CLI + ML extension | Complete `components/azure-access/reference.md` first, then `az extension add -n ml`. |
| Foundry resource + project | Provisioned by the Azure cluster component; consumed during install, not preflight. |

## Supporting files

| Path | Use | When |
|------|-----|------|
| `scripts/preflight.sh` | Run first | Checks Azure subscription/provider read access, CLI, `jq`, ML extension, and local Terraform root; Foundry outputs are install-time inputs. |
| `scripts/install.sh` | Run | Deploys or lists Azure AI Foundry serverless endpoints. |

## Capability catalog

Agent picks the endpoint name + Model ID when invoking `install.sh`:

| Endpoint name | Model ID | Capabilities |
|---------------|----------|--------------|
| `llama-3-1-8b` | `azureml://registries/azureml-meta/models/Meta-Llama-3.1-8B-Instruct` | `text-llm`, `chat` |
| `llama-3-1-70b` | `azureml://registries/azureml-meta/models/Meta-Llama-3.1-70B-Instruct` | `text-llm`, `chat` |
| `phi-3-5-vision` | `azureml://registries/azureml/models/Phi-3.5-vision-instruct` | `vlm`, `image-qa`, `chat` |
| `deepseek-r1` | `azureml://registries/azureml-deepseek/models/DeepSeek-R1` | `text-llm`, `reasoning` |

Pattern for any Foundry-supported model: `azureml://registries/<registry>/models/<model>`.

Foundry has no `video-generation` / `video-style-transfer` — combine with NVCF or NIM Operator for video; root SKILL must reject unsatisfiable combos before submitting.

## Install

```bash
skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/inference-azure/scripts/install.sh                         # deploy one endpoint (default llama-3-1-8b)
skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/inference-azure/scripts/install.sh -n <name> -m <model-id> # deploy a specific model from the catalog above
skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/inference-azure/scripts/install.sh --list                  # list deployed endpoints
```

Pipeline needs multiple endpoints → invoke `install.sh` per name. Reads RG + project from `skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/cluster-azure/scripts` TF outputs. `--help` for full flags.

## Operations

```bash
az ml serverless-endpoint get-credentials -n <name>  # fetch URL + key for pipeline's *_URL env
az ml serverless-endpoint delete -n <name> --yes     # tear down one endpoint
```
