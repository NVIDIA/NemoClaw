# NemoClaw on Kubernetes

> **⚠️ Experimental**: This deployment method is intended for **trying out NemoClaw on Kubernetes**, not for production use. It requires a **privileged pod** running **Docker-in-Docker (DinD)** to create isolated sandbox environments. Operational requirements (storage, runtime, security policies) vary by cluster configuration.

The sample manifest now uses a few safer defaults out of the box:

- disables Kubernetes service account token automounting
- disables service-link environment injection
- runs the workspace container with `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, and `RuntimeDefault` seccomp
- applies NemoClaw's suggested policy presets instead of skipping policy setup
- downloads the installer to a local file with HTTPS-only curl flags before execution

Run [NemoClaw](https://github.com/NVIDIA/NemoClaw) on Kubernetes with GPU inference powered by [Dynamo](https://github.com/ai-dynamo/dynamo) or any OpenAI-compatible endpoint.

---

## Quick Start

### Prerequisites

- Kubernetes cluster with `kubectl` access
- An OpenAI-compatible inference endpoint (Dynamo vLLM, vLLM, etc.)
- Permissions to create **privileged pods** (required for Docker-in-Docker)
- Sufficient node resources (~8GB memory, 2 CPUs for DinD container)

### 1. Deploy NemoClaw

If your compatible endpoint requires an API key, create the optional
`nemoclaw-compatible-api-key` Secret after creating the namespace and before
running `kubectl apply`. The same Secret-backed flow is described again in the
configuration section below.

```bash
kubectl create namespace nemoclaw
kubectl create secret generic nemoclaw-compatible-api-key \
  -n nemoclaw \
  --from-literal=api-key='<your-api-key>'
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/k8s/nemoclaw-k8s.yaml
```

### 2. Check Logs

```bash
kubectl logs -f nemoclaw -n nemoclaw -c workspace
```

Wait for "Onboard complete" message.

### 3. Connect to Your Sandbox

```bash
kubectl exec -it nemoclaw -n nemoclaw -c workspace -- nemoclaw my-assistant connect
```

You're now inside a secure sandbox with an AI agent ready to help.

---

## Configuration

Edit the environment variables in `nemoclaw-k8s.yaml` before deploying:

| Variable | Required | Description |
|----------|----------|-------------|
| `DYNAMO_HOST` | Yes | Inference endpoint for socat proxy (e.g., `vllm-frontend.dynamo.svc:8000`) |
| `NEMOCLAW_ENDPOINT_URL` | Yes | URL the sandbox uses (usually `http://host.openshell.internal:8000/v1`) |
| `COMPATIBLE_API_KEY` | No | Loaded from the optional `nemoclaw-compatible-api-key` Secret; defaults to `dummy` for Dynamo/vLLM when the Secret is absent |
| `NEMOCLAW_MODEL` | Yes | Model name (e.g., `meta-llama/Llama-3.1-8B-Instruct`) |
| `NEMOCLAW_SANDBOX_NAME` | No | Sandbox name (default: `my-assistant`) |
| `NEMOCLAW_POLICY_MODE` | No | Policy preset mode for non-interactive onboarding (default: `suggested`) |

### Optional: Store a Real API Key in a Secret

If your compatible endpoint requires authentication, create the Secret before
you apply the manifest in Step 1:

```bash
kubectl create secret generic nemoclaw-compatible-api-key \
  -n nemoclaw \
  --from-literal=api-key='<your-api-key>'
```

### Example: Custom Endpoint

```yaml
env:
  - name: DYNAMO_HOST
    value: "my-vllm.my-namespace.svc.cluster.local:8000"
  - name: NEMOCLAW_ENDPOINT_URL
    value: "http://host.openshell.internal:8000/v1"
  - name: NEMOCLAW_MODEL
    value: "mistralai/Mistral-7B-Instruct-v0.3"
```

---

## Using NemoClaw

### Access the Workspace Shell

```bash
kubectl exec -it nemoclaw -n nemoclaw -c workspace -- bash
```

### Check Sandbox Status

```bash
kubectl exec nemoclaw -n nemoclaw -c workspace -- nemoclaw list
kubectl exec nemoclaw -n nemoclaw -c workspace -- nemoclaw my-assistant status
```

### Connect to Sandbox

```bash
kubectl exec -it nemoclaw -n nemoclaw -c workspace -- nemoclaw my-assistant connect
```

### Test Inference

From inside the sandbox:

```bash
curl -s https://inference.local/v1/models

curl -s https://inference.local/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"meta-llama/Llama-3.1-8B-Instruct","messages":[{"role":"user","content":"Hello!"}],"max_tokens":50}'
```

### Verify Local Inference

Confirm NemoClaw is using your Dynamo/vLLM endpoint:

```bash
# Check model from sandbox
kubectl exec -it nemoclaw -n nemoclaw -c workspace -- nemoclaw my-assistant connect
sandbox@my-assistant:~$ curl -s https://inference.local/v1/models
# Should show your model (e.g., meta-llama/Llama-3.1-8B-Instruct)

# Compare with Dynamo directly (from workspace)
kubectl exec nemoclaw -n nemoclaw -c workspace -- curl -s http://localhost:8000/v1/models
# Should show the same model

# Check provider configuration
kubectl exec nemoclaw -n nemoclaw -c workspace -- openshell inference get
# Shows: Provider: compatible-endpoint, Model: <your-model>

# Test the agent
sandbox@my-assistant:~$ openclaw agent --agent main -m "What is 7 times 8?"
# Should respond with 56
```

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                     Kubernetes Cluster                          │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    NemoClaw Pod                           │  │
│  │                                                           │  │
│  │  ┌─────────────────┐    ┌─────────────────────────────┐   │  │
│  │  │ Docker-in-Docker│    │    Workspace Container      │   │  │
│  │  │                 │    │                             │   │  │
│  │  │  ┌───────────┐  │    │  nemoclaw CLI               │   │  │
│  │  │  │    k3s    │  │◄───│  openshell CLI              │   │  │
│  │  │  │  cluster  │  │    │                             │   │  │
│  │  │  │           │  │    │  socat proxy ───────────────│───│──┼──► Dynamo/vLLM
│  │  │  │ ┌───────┐ │  │    │  localhost:8000             │   │  │
│  │  │  │ │Sandbox│ │  │    │                             │   │  │
│  │  │  │ └───────┘ │  │    │  host.openshell.internal    │   │  │
│  │  │  └───────────┘  │    │  routes to socat            │   │  │
│  │  └─────────────────┘    └─────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**How it works:**

1. NemoClaw runs in a privileged pod with Docker-in-Docker
2. OpenShell creates a nested k3s cluster for sandbox isolation
3. A socat proxy bridges K8s DNS to the nested environment
4. Inside the sandbox, `host.openshell.internal:8000` routes to the inference endpoint

---

## Troubleshooting

### Pod won't start

```bash
kubectl describe pod nemoclaw -n nemoclaw
```

Common issues:

- Missing privileged security context
- Insufficient memory (needs ~8GB for DinD)

### Docker daemon not starting

```bash
kubectl logs nemoclaw -n nemoclaw -c dind
```

Usually resolves after 30-60 seconds.

### Inference not working

Check socat is running:

```bash
kubectl exec nemoclaw -n nemoclaw -c workspace -- pgrep -a socat
```

Test endpoint directly:

```bash
kubectl exec nemoclaw -n nemoclaw -c workspace -- curl -s http://localhost:8000/v1/models
```

---

## Learn More

- [NemoClaw Documentation](https://docs.nvidia.com/nemoclaw)
- [OpenShell](https://github.com/NVIDIA/OpenShell)
- [Dynamo](https://github.com/ai-dynamo/dynamo)
- [OpenClaw](https://openclaw.ai)
