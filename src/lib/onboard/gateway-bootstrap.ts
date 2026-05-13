// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../core/shell-quote";

export const GATEWAY_BOOTSTRAP_SECRET_NAMES = [
  "openshell-server-tls",
  "openshell-server-client-ca",
  "openshell-client-tls",
  "openshell-ssh-handshake",
] as const;

export type GatewayBootstrapRepairPlan = {
  missingSecrets: string[];
  needsRepair: boolean;
  needsServerTls: boolean;
  needsClientBundle: boolean;
  needsHandshake: boolean;
};

export type GatewayBootstrapRepairResult = {
  repaired: boolean;
  missingSecrets: string[];
};

type RunnerOptions = {
  ignoreError?: boolean;
  suppressOutput?: boolean;
  timeout?: number;
};

type RunResult = {
  status: number | null;
};

export type GatewayBootstrapRepairDeps = {
  buildGatewayClusterExecArgv: (script: string) => string[];
  run: (args: string[], opts?: RunnerOptions) => RunResult;
  runCapture: (args: string[], opts?: RunnerOptions) => string;
  log?: (message?: string) => void;
};

export function getGatewayBootstrapRepairPlan(
  missingSecrets: string[] = [],
): GatewayBootstrapRepairPlan {
  const allowed = new Set<string>(GATEWAY_BOOTSTRAP_SECRET_NAMES);
  const normalized = [
    ...new Set((missingSecrets || []).map((name) => String(name).trim()).filter(Boolean)),
  ].filter((name) => allowed.has(name));
  const missing = new Set(normalized);
  const needsClientBundle =
    missing.has("openshell-server-client-ca") || missing.has("openshell-client-tls");

  return {
    missingSecrets: normalized,
    needsRepair: normalized.length > 0,
    needsServerTls: missing.has("openshell-server-tls"),
    needsClientBundle,
    needsHandshake: missing.has("openshell-ssh-handshake"),
  };
}

export function buildGatewayBootstrapSecretsScript(missingSecrets: string[] = []): string {
  const plan = getGatewayBootstrapRepairPlan(missingSecrets);
  if (!plan.needsRepair) return "exit 0";

  return `
set -eu
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get namespace openshell >/dev/null 2>&1
kubectl -n openshell get statefulset/openshell >/dev/null 2>&1
TMPDIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT
if ${plan.needsServerTls ? "true" : "false"}; then
  cat >"$TMPDIR/server-ext.cnf" <<'EOF'
subjectAltName=DNS:openshell,DNS:openshell.openshell,DNS:openshell.openshell.svc,DNS:openshell.openshell.svc.cluster.local,DNS:localhost,IP:127.0.0.1
extendedKeyUsage=serverAuth
EOF
  openssl req -nodes -newkey rsa:2048 -keyout "$TMPDIR/server.key" -out "$TMPDIR/server.csr" -subj "/CN=openshell.openshell.svc.cluster.local" >/dev/null 2>&1
  openssl x509 -req -in "$TMPDIR/server.csr" -signkey "$TMPDIR/server.key" -out "$TMPDIR/server.crt" -days 3650 -sha256 -extfile "$TMPDIR/server-ext.cnf" >/dev/null 2>&1
  kubectl create secret tls -n openshell openshell-server-tls --cert="$TMPDIR/server.crt" --key="$TMPDIR/server.key" --dry-run=client -o yaml | kubectl apply -f -
fi
if ${plan.needsClientBundle ? "true" : "false"}; then
  cat >"$TMPDIR/client-ext.cnf" <<'EOF'
extendedKeyUsage=clientAuth
EOF
  openssl req -x509 -nodes -newkey rsa:2048 -keyout "$TMPDIR/client-ca.key" -out "$TMPDIR/client-ca.crt" -subj "/CN=openshell-client-ca" -days 3650 >/dev/null 2>&1
  openssl req -nodes -newkey rsa:2048 -keyout "$TMPDIR/client.key" -out "$TMPDIR/client.csr" -subj "/CN=openshell-client" >/dev/null 2>&1
  openssl x509 -req -in "$TMPDIR/client.csr" -CA "$TMPDIR/client-ca.crt" -CAkey "$TMPDIR/client-ca.key" -CAcreateserial -out "$TMPDIR/client.crt" -days 3650 -sha256 -extfile "$TMPDIR/client-ext.cnf" >/dev/null 2>&1
  kubectl create secret generic -n openshell openshell-server-client-ca --from-file=ca.crt="$TMPDIR/client-ca.crt" --dry-run=client -o yaml | kubectl apply -f -
  kubectl create secret generic -n openshell openshell-client-tls --from-file=tls.crt="$TMPDIR/client.crt" --from-file=tls.key="$TMPDIR/client.key" --from-file=ca.crt="$TMPDIR/client-ca.crt" --dry-run=client -o yaml | kubectl apply -f -
fi
if ${plan.needsHandshake ? "true" : "false"}; then
  kubectl create secret generic -n openshell openshell-ssh-handshake --from-literal=secret="$(openssl rand -hex 32)" --dry-run=client -o yaml | kubectl apply -f -
fi
`;
}

export function createGatewayBootstrapRepairHelpers(deps: GatewayBootstrapRepairDeps) {
  const log = deps.log ?? console.log;

  function runGatewayClusterCapture(script: string, opts: RunnerOptions = {}): string {
    return deps.runCapture(deps.buildGatewayClusterExecArgv(script), opts);
  }

  function runGatewayCluster(script: string, opts: RunnerOptions = {}): RunResult {
    return deps.run(deps.buildGatewayClusterExecArgv(script), opts);
  }

  function listMissingGatewayBootstrapSecrets(): string[] {
    const output = runGatewayClusterCapture(
      `
set -eu
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get namespace openshell >/dev/null 2>&1 || exit 0
kubectl -n openshell get statefulset/openshell >/dev/null 2>&1 || exit 0
for name in ${GATEWAY_BOOTSTRAP_SECRET_NAMES.map((name) => shellQuote(name)).join(" ")}; do
  kubectl -n openshell get secret "$name" >/dev/null 2>&1 || printf '%s\\n' "$name"
done
`,
      { ignoreError: true },
    );
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function gatewayClusterHealthcheckPassed(): boolean {
    const result = runGatewayCluster("/usr/local/bin/cluster-healthcheck.sh", {
      ignoreError: true,
      suppressOutput: true,
    });
    return result.status === 0;
  }

  function repairGatewayBootstrapSecrets(): GatewayBootstrapRepairResult {
    const missingSecrets = listMissingGatewayBootstrapSecrets();
    const plan = getGatewayBootstrapRepairPlan(missingSecrets);
    if (!plan.needsRepair) return { repaired: false, missingSecrets };

    log(`  OpenShell bootstrap secrets missing: ${plan.missingSecrets.join(", ")}. Repairing...`);
    const repairResult = runGatewayCluster(buildGatewayBootstrapSecretsScript(plan.missingSecrets), {
      ignoreError: true,
      suppressOutput: true,
    });
    const remainingSecrets = listMissingGatewayBootstrapSecrets();
    if (repairResult.status === 0 && remainingSecrets.length === 0) {
      log("  ✓ OpenShell bootstrap secrets created");
      return { repaired: true, missingSecrets: remainingSecrets };
    }
    return { repaired: false, missingSecrets: remainingSecrets };
  }

  return {
    runGatewayClusterCapture,
    runGatewayCluster,
    listMissingGatewayBootstrapSecrets,
    gatewayClusterHealthcheckPassed,
    repairGatewayBootstrapSecrets,
  };
}
