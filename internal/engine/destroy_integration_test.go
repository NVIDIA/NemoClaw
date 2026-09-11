//go:build integration

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"bytes"
	"context"
	"encoding/json/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/NVIDIA/NemoClaw/internal/config"
	dm "github.com/NVIDIA/OpenShell/sdk/go/proto/datamodelv1"
	ip "github.com/NVIDIA/OpenShell/sdk/go/proto/inferencev1"
	pb "github.com/NVIDIA/OpenShell/sdk/go/proto/openshellv1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (f *fixture) DeleteSandbox(_ context.Context, q *pb.DeleteSandboxRequest) (*pb.DeleteSandboxResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.deleteFailure == "sandbox" {
		return nil, status.Error(codes.Unavailable, "sensitive-sentinel-42")
	}
	key := q.Workspace + "/" + q.Name
	if f.sandboxes[key] == nil {
		return nil, missing()
	}
	delete(f.sandboxes, key)
	f.effects++
	f.deletes = append(f.deletes, "sandbox")
	if f.loseDelete {
		f.loseDelete = false
		return nil, status.Error(codes.Unavailable, "sensitive-sentinel-42")
	}
	return &pb.DeleteSandboxResponse{}, nil
}

func (f *fixture) DeleteInferenceRoute(_ context.Context, q *ip.DeleteInferenceRouteRequest) (*ip.DeleteInferenceRouteResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sandboxes) != 0 || q.RouteName != "" {
		return nil, status.Error(codes.FailedPrecondition, "sandbox must be removed before default route")
	}
	if f.routes[q.Workspace] != nil {
		delete(f.routes, q.Workspace)
		f.effects++
		f.deletes = append(f.deletes, "route")
	}
	return &ip.DeleteInferenceRouteResponse{}, nil
}

func (f *fixture) DeleteProvider(_ context.Context, q *pb.DeleteProviderRequest) (*pb.DeleteProviderResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.routes[q.Workspace] != nil {
		return nil, status.Error(codes.FailedPrecondition, "route still references provider")
	}
	key := q.Workspace + "/" + q.Name
	if f.providers[key] == nil {
		return nil, missing()
	}
	delete(f.providers, key)
	f.effects++
	f.deletes = append(f.deletes, "provider")
	return &pb.DeleteProviderResponse{}, nil
}

func TestDestroyPreviewTeardownAndReapply(t *testing.T) {
	e, f, d, out := setup(t)
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	ids, err := e.stateIDs()
	if err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err = e.Run(t.Context(), "plan-destroy", nil); err != nil {
		t.Fatal(err)
	}
	if f.count() != 4 {
		t.Fatal("destroy preview mutated resources")
	}
	var preview Result
	if err = json.Unmarshal(out.Bytes(), &preview); err != nil || len(preview.Changes) != 3 || !slices.Equal(preview.Retained, []string{workspaceAddress}) {
		t.Fatal("unexpected teardown plan", preview, err)
	}
	if err = invoke(t, e, "apply", d); err != nil || f.count() != 4 {
		t.Fatal("destroy preview changed ordinary apply authorization", err)
	}
	if err = e.Run(t.Context(), "destroy", nil); err != nil {
		t.Fatal(err)
	}
	remaining, err := e.stateIDs()
	if err != nil || len(remaining) != 1 || remaining[workspaceAddress] != ids[workspaceAddress] {
		t.Fatal("destroy lost retained workspace binding", remaining, err)
	}
	f.mu.Lock()
	if !slices.Equal(f.deletes, []string{"sandbox", "route", "provider"}) {
		t.Error("wrong dependency order", f.deletes)
	}
	f.mu.Unlock()
	out.Reset()
	if err = e.Run(t.Context(), "destroy", nil); err != nil || f.count() != 7 {
		t.Fatal("repeat destroy was not idempotent", err)
	}
	if err = invoke(t, e, "export", d); err == nil {
		t.Fatal("destroyed deployment exported as running")
	}
	if err = invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	after, err := e.stateIDs()
	if err != nil || after[workspaceAddress] != ids[workspaceAddress] || after["nemoclaw_sandbox.agent"] == ids["nemoclaw_sandbox.agent"] {
		t.Fatal("reapply did not reuse workspace and recreate workload", after, err)
	}
}

func TestDestroyLostResponseRetainsBindingAndResumesWithoutRecreation(t *testing.T) {
	e, f, d, _ := setup(t)
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	before, _ := e.stateIDs()
	f.loseDelete = true
	if err := e.Run(t.Context(), "destroy", nil); err == nil || strings.Contains(err.Error(), "sensitive-sentinel") {
		t.Fatal("lost delete response was successful or leaked secrets", err)
	}
	r, err := loadRecord(e.StateDir)
	if err != nil || !r.Destroying || r.Destroyed {
		t.Fatal("missing destroy recovery intent", r, err)
	}
	bound, _ := e.stateIDs()
	if bound["nemoclaw_sandbox.agent"] != before["nemoclaw_sandbox.agent"] {
		t.Fatal("ambiguous delete lost sandbox binding")
	}
	if err = invoke(t, e, "apply", d); err == nil {
		t.Fatal("apply recreated a partially destroyed deployment")
	}
	if err = e.Run(t.Context(), "destroy", nil); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.creates["sandbox"] != 1 || !slices.Equal(f.deletes, []string{"sandbox", "route", "provider"}) {
		t.Fatal("recovery repeated a mutation or created resources", f.deletes)
	}
}

func TestDestroyObservationAndOwnershipFailuresHaveNoEffects(t *testing.T) {
	for _, scenario := range []string{"authentication", "transport", "partial", "foreign", "new identity", "policy drift"} {
		t.Run(scenario, func(t *testing.T) {
			e, f, d, _ := setup(t)
			if err := invoke(t, e, "apply", d); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(filepath.Join(e.StateDir, "terraform.tfstate"))
			f.mu.Lock()
			s := f.sandboxes[d.Workspace()+"/assistant"]
			switch scenario {
			case "authentication":
				f.readFailure["sandbox"] = codes.Unauthenticated
			case "transport":
				f.readFailure["provider"] = codes.Unavailable
			case "partial":
				f.partialRead["sandbox"] = true
			case "foreign":
				s.Metadata.Labels["nemoclaw.nvidia.com/uid"] = "foreign"
			case "new identity":
				s.Metadata.Id = "replacement"
			case "policy drift":
				s.Spec.Policy.Process.RunAsUser = "0"
			}
			f.mu.Unlock()
			if err := e.Run(t.Context(), "destroy", nil); err == nil {
				t.Fatal("unsafe destroy accepted")
			}
			after, _ := os.ReadFile(filepath.Join(e.StateDir, "terraform.tfstate"))
			if string(after) != string(before) || f.count() != 4 {
				t.Fatal("failed observation changed state or resources")
			}
		})
	}
}

func TestDestroyConfirmedAbsencePersistsStateWithoutDeletes(t *testing.T) {
	e, f, d, _ := setup(t)
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	clear(f.sandboxes)
	clear(f.routes)
	clear(f.providers)
	f.mu.Unlock()
	if err := e.Run(t.Context(), "destroy", nil); err != nil {
		t.Fatal(err)
	}
	ids, err := e.stateIDs()
	if err != nil || len(ids) != 1 || f.count() != 4 {
		t.Fatal("confirmed absence was not persisted without mutations", ids, err)
	}
}

func TestDestroyDoesNotRequireHealthyInferenceOrItsCredential(t *testing.T) {
	e, f, d, _ := setup(t)
	d.Spec.InferenceProviders[0].Endpoint = "https://inference.example.test/v1"
	d.Spec.InferenceProviders[0].Credential = &config.Credential{Env: "DESTROY_TEST_KEY"}
	t.Setenv("DESTROY_TEST_KEY", "sensitive-sentinel-42")
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DESTROY_TEST_KEY", "")
	f.mu.Lock()
	f.inferenceExit = 1
	f.sandboxes[d.Workspace()+"/assistant"].Status.Phase = pb.SandboxPhase_SANDBOX_PHASE_ERROR
	f.mu.Unlock()
	if err := e.Run(t.Context(), "destroy", nil); err != nil {
		t.Fatal(err)
	}
}

func TestDestroyRetainsUntrackedWorkspaceContents(t *testing.T) {
	e, f, d, _ := setup(t)
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	foreign := &dm.Provider{Metadata: &dm.ObjectMeta{Id: "foreign", Name: "other", Workspace: d.Workspace()}}
	f.providers[d.Workspace()+"/other"] = foreign
	f.mu.Unlock()
	if err := e.Run(t.Context(), "destroy", nil); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.providers[d.Workspace()+"/other"] != foreign || f.workspaces[d.Workspace()] == nil {
		t.Fatal("destroy cascaded into untracked workspace contents")
	}
}

func TestDestroyRefusesUnfinishedCreatesAndLegacyOllamaBeforeEffects(t *testing.T) {
	for _, scenario := range []string{"unfinished apply", "legacy Ollama"} {
		t.Run(scenario, func(t *testing.T) {
			e, f, d, _ := setup(t)
			if err := invoke(t, e, "apply", d); err != nil {
				t.Fatal(err)
			}
			r, err := loadRecord(e.StateDir)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "unfinished apply" {
				r.Pending = true
			} else {
				b, err := os.ReadFile("../../examples/managed-ollama.yaml")
				if err != nil {
					t.Fatal(err)
				}
				legacy, err := config.Parse(bytes.NewReader(b))
				if err != nil {
					t.Fatal(err)
				}
				r.Document.Spec.InferenceProviders[0] = legacy.Spec.InferenceProviders[0]
				r.Document.Spec.Sandboxes[0].Agents[0].Inference = legacy.Spec.Sandboxes[0].Agents[0].Inference
				r.Digest = r.Document.Digest()
			}
			if err = saveJSON(filepath.Join(e.StateDir, "intent.json"), r); err != nil {
				t.Fatal(err)
			}
			if err = e.Run(t.Context(), "destroy", nil); err == nil || f.count() != 4 {
				t.Fatal("unsupported destroy had effects", err)
			}
		})
	}
}

func TestDestroyRejectsMissingEstablishedState(t *testing.T) {
	e, f, d, _ := setup(t)
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(e.StateDir, "terraform.tfstate")); err != nil {
		t.Fatal(err)
	}
	if err := e.Run(t.Context(), "destroy", nil); err == nil || f.count() != 4 {
		t.Fatal("missing state authorized inferred deletion", err)
	}
}
