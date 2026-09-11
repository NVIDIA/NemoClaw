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
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
	"github.com/NVIDIA/NemoClaw/internal/subprocess"
	"google.golang.org/grpc/codes"
	"google.golang.org/protobuf/proto"
)

// The test executable can stand in for a broken osquery process. The actual
// OpenTofu/provider processes still perform Read, with no SDK fallback possible.
func TestMain(m *testing.M) {
	if output, ok := os.LookupEnv("NEMOCLAW_TEST_QUERY_RESULT"); ok {
		os.Stdout.WriteString(output)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// Exercise Resource.Read directly through OpenTofu, bypassing the CLI's separate
// ownership preflight. A preflight failure must not mask a broken refresh.
func refreshTofu(t *testing.T, e *Engine, bundle string, args ...string) ([]byte, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	defer cancel()
	env := append(subprocess.CleanEnv(), "NEMOCLAW_INTERNAL_BUNDLE="+bundle,
		"TF_IN_AUTOMATION=1", "TF_INPUT=0", "CHECKPOINT_DISABLE=1",
		"TF_CLI_CONFIG_FILE="+filepath.Join(e.StateDir, "providers.tfrc"))
	return subprocess.Run(ctx, e.StateDir, subprocess.Executable(e.BundleDir, "tofu"), env, args...)
}

func planRefresh(t *testing.T, e *Engine, bundle string) (Plan, error) {
	t.Helper()
	_, err := refreshTofu(t, e, bundle, "plan", "-input=false", "-no-color", "-parallelism=1", "-out=refresh.plan")
	if err != nil {
		return Plan{}, err
	}
	b, err := e.tofu(t.Context(), "show", "-json", "refresh.plan")
	if err != nil {
		t.Fatal(err)
	}
	var p Plan
	if err = json.Unmarshal(b, &p); err != nil {
		t.Fatal(err)
	}
	return p, nil
}

func stateBytes(t *testing.T, e *Engine) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(e.StateDir, "terraform.tfstate"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestProviderRefreshObservesLiveValuesAndPlansDrift(t *testing.T) {
	e, f, d, out := setup(t)
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	before := stateBytes(t, e)
	p, err := planRefresh(t, e, e.BundleDir)
	if err != nil || len(p.ResourceChanges) != 4 {
		t.Fatalf("successful refresh: %+v, %v", p, err)
	}
	for _, change := range p.ResourceChanges {
		if !slices.Equal(change.Change.Actions, []string{"no-op"}) {
			t.Fatalf("unchanged resource: %+v", change)
		}
	}
	f.mu.Lock()
	f.providers[d.Workspace()+"/local"].Config["OPENAI_BASE_URL"] = "http://127.0.0.1:11435/v1"
	f.routes[d.Workspace()].ModelId = "external-model"
	f.mu.Unlock()
	p, err = planRefresh(t, e, e.BundleDir)
	if err != nil {
		t.Fatal(err)
	}
	updates := map[string]bool{}
	for _, change := range p.ResourceChanges {
		if slices.Equal(change.Change.Actions, []string{"update"}) {
			updates[change.Address] = true
		} else if !slices.Equal(change.Change.Actions, []string{"no-op"}) {
			t.Fatalf("refresh planned replacement: %+v", change)
		}
	}
	if !reflect.DeepEqual(updates, map[string]bool{"nemoclaw_provider.inference": true, "nemoclaw_route.primary": true}) {
		t.Fatalf("wrong drift: %+v", updates)
	}
	if !bytes.Equal(before, stateBytes(t, e)) || f.count() != 4 {
		t.Fatal("planning changed durable state or remote resources")
	}
	out.Reset()
	if err = invoke(t, e, "export", d); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "external-model") || !strings.Contains(out.String(), "11435/v1") {
		t.Fatal("export did not consume the same live observations")
	}
}

func TestProviderRefreshOnlyConfirmedAbsenceRemovesState(t *testing.T) {
	for _, kind := range []string{"workspace", "provider", "route", "sandbox"} {
		t.Run(kind, func(t *testing.T) {
			e, f, d, _ := setup(t)
			if err := invoke(t, e, "apply", d); err != nil {
				t.Fatal(err)
			}
			before, err := e.stateIDs()
			if err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			switch kind {
			case "workspace":
				delete(f.workspaces, d.Workspace())
			case "provider":
				delete(f.providers, d.Workspace()+"/local")
			case "route":
				delete(f.routes, d.Workspace())
			case "sandbox":
				delete(f.sandboxes, d.Workspace()+"/assistant")
			}
			f.mu.Unlock()
			// The CLI still forbids automatic replacement of missing managed objects.
			if err = invoke(t, e, "apply", d); err == nil || f.count() != 4 {
				t.Fatal("CLI recreated a missing managed resource")
			}
			// Refresh-only apply persists Read's state decision without creating.
			if _, err = refreshTofu(t, e, e.BundleDir, "apply", "-refresh-only", "-auto-approve", "-input=false", "-no-color", "-parallelism=1"); err != nil {
				t.Fatal(err)
			}
			after, err := e.stateIDs()
			if err != nil {
				t.Fatal(err)
			}
			for _, target := range Targets(d, nil) {
				absent := target.Kind == kind || (kind == "workspace" && target.Kind == "route")
				if absent && after[target.Address] != "" {
					t.Fatalf("confirmed absence retained %s", target.Address)
				}
				if !absent && after[target.Address] != before[target.Address] {
					t.Fatalf("unrelated resource lost identity: %s", target.Address)
				}
			}
			if f.count() != 4 {
				t.Fatal("refresh mutated resources")
			}
		})
	}
}

func TestProviderRefreshFailuresStopPlanningAndRetainState(t *testing.T) {
	e, f, d, out := setup(t)
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	before := stateBytes(t, e)
	tests := []struct {
		name, kind, diagnostic string
		code                   codes.Code
		partial                bool
	}{
		{name: "authentication", kind: "provider", code: codes.Unauthenticated, diagnostic: "authentication failed"},
		{name: "authorization", kind: "provider", code: codes.PermissionDenied, diagnostic: "permission denied"},
		{name: "transport", kind: "provider", code: codes.Unavailable, diagnostic: "transport"},
		{name: "deadline", kind: "provider", code: codes.DeadlineExceeded, diagnostic: "transport"},
		{name: "unknown remote error", kind: "provider", code: codes.Internal, diagnostic: "inconclusive"},
		{name: "missing policy is not missing sandbox", kind: "policy", code: codes.NotFound, diagnostic: "read active sandbox policy"},
		{name: "partial workspace", kind: "workspace", partial: true, diagnostic: "incomplete workspace"},
		{name: "partial provider", kind: "provider", partial: true, diagnostic: "incomplete provider"},
		{name: "partial route", kind: "route", partial: true, diagnostic: "incomplete inference route"},
		{name: "partial sandbox", kind: "sandbox", partial: true, diagnostic: "incomplete sandbox"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f.mu.Lock()
			f.readFailure[tt.kind] = tt.code
			f.partialRead[tt.kind] = tt.partial
			f.mu.Unlock()
			defer func() {
				f.mu.Lock()
				clear(f.readFailure)
				clear(f.partialRead)
				f.mu.Unlock()
			}()
			_, err := planRefresh(t, e, e.BundleDir)
			if err == nil || !strings.Contains(err.Error(), "Resource observation") || !strings.Contains(err.Error(), tt.diagnostic) {
				t.Fatalf("missing refresh diagnostic: %v", err)
			}
			if strings.Contains(err.Error(), "sensitive-sentinel-42") {
				t.Fatal("remote diagnostic leaked credentials")
			}
			if _, err = refreshTofu(t, e, e.BundleDir, "apply", "-refresh-only", "-auto-approve", "-input=false", "-no-color", "-parallelism=1"); err == nil {
				t.Fatal("failed observation allowed state persistence")
			}
			out.Reset()
			if invoke(t, e, "export", d) == nil || out.Len() != 0 {
				t.Fatal("failed or partial observation became YAML")
			}
			if f.count() != 4 || !bytes.Equal(before, stateBytes(t, e)) {
				t.Fatal("observation failure lost state or recreated resources")
			}
		})
	}
	// An ordinary retry after observation recovers remains a no-op.
	if err := invoke(t, e, "apply", d); err != nil || f.count() != 4 {
		t.Fatalf("observation recovery recreated resources: %v", err)
	}
}

func TestProviderRefreshRetainsOwnershipIdentityAndPolicyGuards(t *testing.T) {
	e, f, d, _ := setup(t)
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	before := stateBytes(t, e)
	for _, kind := range []string{"workspace", "provider", "sandbox"} {
		for _, field := range []string{"owner", "generation", "id"} {
			t.Run(kind+"/"+field, func(t *testing.T) {
				f.mu.Lock()
				meta := f.workspaces[d.Workspace()].Metadata
				if kind == "provider" {
					meta = f.providers[d.Workspace()+"/local"].Metadata
				}
				if kind == "sandbox" {
					meta = f.sandboxes[d.Workspace()+"/assistant"].Metadata
				}
				old := proto.Clone(meta)
				if field == "id" {
					meta.Id = "replacement"
				} else {
					meta.Labels["nemoclaw.nvidia.com/"+map[string]string{"owner": "uid", "generation": "generation"}[field]] = "foreign"
				}
				f.mu.Unlock()
				_, err := planRefresh(t, e, e.BundleDir)
				f.mu.Lock()
				proto.Reset(meta)
				proto.Merge(meta, old)
				f.mu.Unlock()
				if err == nil || !strings.Contains(err.Error(), "Resource observation") {
					t.Fatalf("accepted %s drift: %v", field, err)
				}
				if !bytes.Equal(before, stateBytes(t, e)) || f.count() != 4 {
					t.Fatal("identity failure changed state")
				}
			})
		}
	}
	for _, field := range []string{"policy", "command", "environment", "image"} {
		t.Run(field, func(t *testing.T) {
			f.mu.Lock()
			s := f.sandboxes[d.Workspace()+"/assistant"]
			old := proto.Clone(s.Spec)
			switch field {
			case "policy":
				s.Spec.Policy.Process.RunAsUser = "0"
			case "command":
				s.Spec.Command = []string{"other"}
			case "environment":
				s.Spec.Environment = oshell.Environment("other")
			case "image":
				s.Spec.Template.Image = "example.test/other@sha256:" + strings.Repeat("a", 64)
			}
			f.mu.Unlock()
			_, err := planRefresh(t, e, e.BundleDir)
			f.mu.Lock()
			proto.Reset(s.Spec)
			proto.Merge(s.Spec, old)
			f.mu.Unlock()
			if err == nil {
				t.Fatal("unsafe configuration drift was accepted")
			}
			if !bytes.Equal(before, stateBytes(t, e)) || f.count() != 4 {
				t.Fatal("configuration failure changed state")
			}
		})
	}
}

func TestProviderRefreshDoesNotFallbackWhenOsqueryFails(t *testing.T) {
	e, f, d, _ := setup(t)
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	before := stateBytes(t, e)
	for _, mode := range []string{"missing query", "missing extension", "empty result", "partial result"} {
		t.Run(mode, func(t *testing.T) {
			bundle := t.TempDir()
			if err := os.MkdirAll(filepath.Join(bundle, "libexec"), 0700); err != nil {
				t.Fatal(err)
			}
			if mode != "missing query" {
				source := subprocess.Executable(e.BundleDir, "osqueryi")
				if mode != "missing extension" {
					var err error
					source, err = os.Executable()
					if err != nil {
						t.Fatal(err)
					}
					result := `[]`
					if mode == "partial result" {
						result = `[{"observation_status":"absent"}]`
					}
					t.Setenv("NEMOCLAW_TEST_QUERY_RESULT", result)
				}
				// A hard link avoids copying the large upstream osquery executable.
				if err := os.Link(source, subprocess.Executable(bundle, "osqueryi")); err != nil {
					t.Fatal(err)
				}
			}
			_, err := planRefresh(t, e, bundle)
			if err == nil || !strings.Contains(err.Error(), "Resource observation") {
				t.Fatalf("missing query failure: %v", err)
			}
			if _, err = refreshTofu(t, e, bundle, "apply", "-refresh-only", "-auto-approve", "-input=false", "-no-color", "-parallelism=1"); err == nil {
				t.Fatal("query failure allowed state persistence")
			}
			if f.count() != 4 || !bytes.Equal(before, stateBytes(t, e)) {
				t.Fatal("query failure lost state or recreated resources")
			}
		})
	}
	if err := invoke(t, e, "apply", d); err != nil || f.count() != 4 {
		t.Fatalf("query recovery recreated resources: %v", err)
	}
}
