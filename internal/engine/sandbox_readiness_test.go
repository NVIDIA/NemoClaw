//go:build integration

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"maps"
	"testing"

	pb "github.com/NVIDIA/OpenShell/sdk/go/proto/openshellv1"
)

func TestFailedSandboxStartupRetainsBindingWithoutTaintOrRecreation(t *testing.T) {
	e, f, d, _ := setup(t)
	f.sandboxPhase = pb.SandboxPhase_SANDBOX_PHASE_ERROR
	if err := invoke(t, e, "apply", d); err == nil {
		t.Fatal("failed startup reported success")
	}
	before, err := e.stateIDs()
	if err != nil || len(before) != 4 {
		t.Fatal("readiness failure lost established bindings", before, err)
	}
	record, err := loadRecord(e.StateDir)
	if err != nil || record.Pending || record.Succeeded {
		t.Fatal("configuration remained ambiguous after readiness failure", err)
	}
	if err = invoke(t, e, "plan", d); err != nil {
		t.Fatal("failed readiness tainted the sandbox or blocked configuration observation", err)
	}
	if err = invoke(t, e, "apply", d); err == nil {
		t.Fatal("terminal sandbox error was hidden")
	}
	after, err := e.stateIDs()
	if err != nil || !maps.Equal(before, after) || f.creates["sandbox"] != 1 {
		t.Fatal("readiness retry replaced or duplicated the sandbox", err)
	}
	// This fixture models owning-system recovery, not a product write to status.
	// OpenShell 0.0.116 does not expose recovery from terminal Error over its API.
	f.mu.Lock()
	f.sandboxes[d.Workspace()+"/assistant"].Status.Phase = pb.SandboxPhase_SANDBOX_PHASE_READY
	f.mu.Unlock()
	if err = invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	after, err = e.stateIDs()
	if err != nil || !maps.Equal(before, after) || f.creates["sandbox"] != 1 {
		t.Fatal("recovered readiness lost identity", err)
	}
}
