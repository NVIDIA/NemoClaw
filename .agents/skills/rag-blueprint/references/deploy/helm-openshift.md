# Helm Deployment on OpenShift

## When to Use
- Cluster is Red Hat OpenShift or OKD (`clusterversion` resource present, or `route.openshift.io` API available)
- User mentions OpenShift, OKD, or RHEL OpenShift in the deployment context
- User wants OpenShift Routes with edge TLS instead of `kubectl port-forward` for external access

## Restrictions

Read `docs/support-matrix.md` for current Kubernetes, Helm, and OS version requirements.

- Requires GPU Operator + NIM Operator pre-installed on the OpenShift cluster
- Default StorageClass must be configured for PVC provisioning
- Disk space per `docs/support-matrix.md` (~200 GB per node for NIM cache + images + PVCs)
- NeMo Guardrails not available in Helm deployment
- OpenShift's default Route timeout is 30 s — the chart sets `haproxy.router.openshift.io/timeout: 300s` on the RAG-server Route, but manually-created Routes need this annotation

## Process

1. Read `docs/deploy-helm-openshift.md` for full commands and overlay file usage.
2. Ensure prerequisites: GPU Operator, NIM Operator, StorageClass, `NGC_API_KEY`, and a namespace:
   ```bash
   export NAMESPACE="${NAMESPACE:-rag}"
   kubectl create namespace "$NAMESPACE" 2>/dev/null || true
   ```
3. Install the chart with the `values-openshift.yaml` overlay (the overlay inherits the base `values.yaml`, so it does not need to be passed separately):
   ```bash
   helm upgrade --install rag -n "$NAMESPACE" <chart> \
     -f values-openshift.yaml \
     --set imagePullSecret.password="$NGC_API_KEY" \
     --set ngcApiSecret.password="$NGC_API_KEY" \
     --timeout 15m
   ```
   The overlay turns on `openshift.enabled`, which makes the chart create OpenShift Routes with edge TLS and an `anyuid` SCC RoleBinding for all required ServiceAccounts — no manual `oc adm policy add-scc-to-user` is needed.
4. Link the pull secret to the NIM cache ServiceAccount after it exists:
   ```bash
   oc secrets link nim-cache-sa ngc-secret --for=pull -n "$NAMESPACE"
   ```
5. Monitor pods and Routes, then access the UI via the frontend Route's external host (no `port-forward` required):
   ```bash
   kubectl get pods -n "$NAMESPACE"
   kubectl get route -n "$NAMESPACE"
   ```

## Decision Table

| Goal | Key Action |
|------|------------|
| Standard OpenShift deploy | Apply the `values-openshift.yaml` overlay |
| Constrained / API-hosted demo | Also apply `values-openshift-test.yaml` for tolerations, resource tuning, disabled observability, and API-hosted LLM |
| GPU nodes with taints | Use `--set-json` toleration entries per NIM, or copy the pattern from `values-openshift-test.yaml` |

## Agent-Specific Notes
- OpenShift Routes provide external access directly — do not propose `kubectl port-forward` workflows once Routes exist
- If a NIM pod hits `CrashLoopBackOff` with SCC-related errors, confirm `openshift.enabled: true` is set in the active overlay
- If NIMCache jobs or pods hit `ImagePullBackOff`, confirm the NGC pull secret is linked to `nim-cache-sa`
- Route timeouts during long requests → annotate the affected Route with `haproxy.router.openshift.io/timeout=300s`
- `helm uninstall` does not remove PVCs — clean up with `kubectl delete nimcache --all -n "$NAMESPACE" && kubectl delete pvc --all -n "$NAMESPACE"`

## Source Documentation
- `docs/deploy-helm-openshift.md` — OpenShift Routes, SCC, overlay usage, OpenShift-specific troubleshooting
- `docs/deploy-helm.md` — standard (non-OpenShift) Helm deployment for comparison
- `deploy/helm/nvidia-blueprint-rag/values-openshift.yaml` — the overlay itself
- `deploy/helm/nvidia-blueprint-rag/values-openshift-test.yaml` — reference overlay for constrained/API-hosted setups
