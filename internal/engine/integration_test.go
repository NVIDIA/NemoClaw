//go:build integration

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/config"
	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
)

func setup(t *testing.T) (*Engine, *fixture, config.Document, *bytes.Buffer) {
	t.Helper()
	f := newFixture(t)
	b, err := os.ReadFile("../../examples/local.yaml")
	if err != nil {
		t.Fatal(err)
	}
	d, err := config.Parse(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	d.Spec.Gateway.Endpoint = f.endpoint
	bundle, err := filepath.Abs("../../dist/" + runtime.GOOS + "_" + runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	if err = VerifyBundle(bundle); err != nil {
		t.Fatalf("build the native bundle before integration tests: %v", err)
	}
	out := &bytes.Buffer{}
	return &Engine{StateDir: t.TempDir(), BundleDir: bundle, Output: out}, f, d, out
}
func invoke(t *testing.T, e *Engine, operation string, d config.Document) error {
	t.Helper()
	b, err := d.YAML()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	return e.Run(ctx, operation, bytes.NewReader(b))
}

func TestPlanApplyNoOpChangeExportAndRecreate(t *testing.T) {
	e, f, d, out := setup(t)
	if err := invoke(t, e, "plan", d); err != nil {
		t.Fatal(err)
	}
	if f.count() != 0 {
		t.Fatal("plan mutated the gateway")
	}
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	effects := f.count()
	if effects != 4 {
		t.Fatalf("effects=%d", effects)
	}
	out.Reset()
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	if f.count() != effects {
		t.Fatal("second apply mutated resources")
	}
	var result Result
	if json.Unmarshal(out.Bytes(), &result) != nil || len(result.Changes) != 0 {
		t.Fatal("expected empty second plan")
	}
	f.mu.Lock()
	sandboxID := f.sandboxes[d.Workspace()+"/assistant"].Metadata.Id
	f.mu.Unlock()
	d.Spec.Sandboxes[0].Agents[0].Inference.Routes[0].Overrides.Model = "model-b"
	out.Reset()
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	if f.count() != effects+1 {
		t.Fatal("model change touched more than the route")
	}
	f.mu.Lock()
	if f.sandboxes[d.Workspace()+"/assistant"].Metadata.Id != sandboxID {
		t.Fatal("sandbox replaced")
	}
	f.mu.Unlock()
	out.Reset()
	if err := invoke(t, e, "export", d); err != nil {
		t.Fatal(err)
	}
	exported, err := config.Parse(bytes.NewReader(out.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if exported.Digest() != d.Digest() {
		t.Fatal("export changed the configuration")
	}
	fresh := newFixture(t)
	exported.Spec.Gateway.Endpoint = fresh.endpoint
	other := &Engine{StateDir: t.TempDir(), BundleDir: e.BundleDir, Output: &bytes.Buffer{}}
	if err = invoke(t, other, "apply", exported); err != nil {
		t.Fatal(err)
	}
	if fresh.count() != 4 {
		t.Fatal("export did not recreate the deployment")
	}
}

func TestLostCreateResponseRecoversWithoutDuplicate(t *testing.T) {
	e, f, d, out := setup(t)
	f.loseProvider = true
	err := invoke(t, e, "apply", d)
	if err == nil {
		t.Fatal("lost response reported success")
	}
	if strings.Contains(err.Error(), "fixture-secret") {
		t.Fatal("remote error leaked sensitive details")
	}
	if f.count() != 2 {
		t.Fatal("scheduled effects after failure")
	}
	r, err := loadRecord(e.StateDir)
	if err != nil || !r.Pending {
		t.Fatal("missing recovery record")
	}
	changed := d
	changed.Metadata.Name = "changed"
	if invoke(t, e, "apply", changed) == nil {
		t.Fatal("changed intent silently resumed")
	}
	if invoke(t, e, "export", d) == nil {
		t.Fatal("exported an unfinished deployment")
	}
	out.Reset()
	if err = invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.creates["provider"] != 1 || f.creates["workspace"] != 1 || f.creates["sandbox"] != 1 {
		t.Fatal("recovery duplicated resources")
	}
}

func TestInterruptedApplyRecoversAfterSandboxCreation(t *testing.T) {
	e, f, d, _ := setup(t)
	created := make(chan struct{})
	f.blockSandbox = created
	b, _ := d.YAML()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- e.Run(ctx, "apply", bytes.NewReader(b)) }()
	select {
	case <-created:
		cancel()
	case <-ctx.Done():
		t.Fatal("sandbox was not dispatched")
	}
	if err := <-done; err == nil {
		t.Fatal("interruption reported success")
	}
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.creates["sandbox"] != 1 {
		t.Fatal("interruption duplicated sandbox")
	}
}

func TestOwnershipAndIdentityFailuresCauseNoEffects(t *testing.T) {
	e, f, d, _ := setup(t)
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	effects := f.count()
	f.mu.Lock()
	w := f.workspaces[d.Workspace()]
	original := w.Metadata.Labels[oshell.OwnerLabel]
	w.Metadata.Labels[oshell.OwnerLabel] = "foreign"
	f.mu.Unlock()
	if invoke(t, e, "apply", d) == nil {
		t.Fatal("mutated foreign workspace")
	}
	if f.count() != effects {
		t.Fatal("foreign-owner mutation")
	}
	f.mu.Lock()
	w.Metadata.Labels[oshell.OwnerLabel] = original
	f.sandboxes[d.Workspace()+"/assistant"].Metadata.Id = "replacement"
	f.mu.Unlock()
	if invoke(t, e, "apply", d) == nil {
		t.Fatal("accepted replaced lifecycle identity")
	}
	if f.count() != effects {
		t.Fatal("identity-change mutation")
	}
}

func TestExportReadsLiveModelAndFailsWhenObservationIsMissing(t *testing.T) {
	e, f, d, out := setup(t)
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.routes[d.Workspace()].ModelId = "externally-changed"
	f.mu.Unlock()
	out.Reset()
	if err := invoke(t, e, "export", d); err != nil {
		t.Fatal(err)
	}
	exported, err := config.Parse(bytes.NewReader(out.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if exported.Spec.Sandboxes[0].Agents[0].Inference.Routes[0].Overrides.Model != "externally-changed" {
		t.Fatal("export replayed retained intent instead of live state")
	}
	f.mu.Lock()
	delete(f.providers, d.Workspace()+"/local")
	f.mu.Unlock()
	out.Reset()
	if invoke(t, e, "export", d) == nil {
		t.Fatal("missing observation became a successful export")
	}
	if out.Len() != 0 {
		t.Fatal("partial YAML was emitted")
	}
}

func TestSecretsStayOutOfPlanStateExportAndErrors(t *testing.T) {
	e, _, d, out := setup(t)
	t.Setenv("ARBITRARY_CREDENTIAL", "sensitive-sentinel-42")
	d.Spec.InferenceProviders[0].Endpoint = "https://inference.example.test/v1"
	d.Spec.InferenceProviders[0].Credential = &config.Credential{Env: "ARBITRARY_CREDENTIAL"}
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := invoke(t, e, "export", d); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(out.Bytes(), []byte("sensitive-sentinel-42")) {
		t.Fatal("export leaked credentials")
	}
	for _, name := range []string{"main.tf.json", "intent.json", "terraform.tfstate", "apply.plan"} {
		b, err := os.ReadFile(filepath.Join(e.StateDir, name))
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(b, []byte("sensitive-sentinel-42")) {
			t.Fatalf("secret in %s", name)
		}
	}
}

func TestExportRejectsPolicyAndAgentConfigurationDrift(t *testing.T) {
	e, f, d, out := setup(t)
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	p := f.sandboxes[d.Workspace()+"/assistant"].Spec.Policy
	p.Process.RunAsUser = "0"
	f.mu.Unlock()
	out.Reset()
	if invoke(t, e, "export", d) == nil || out.Len() != 0 {
		t.Fatal("export accepted policy drift")
	}
	f.mu.Lock()
	p.Process.RunAsUser = "1000"
	f.execExit = 2
	f.mu.Unlock()
	out.Reset()
	if invoke(t, e, "export", d) == nil || out.Len() != 0 {
		t.Fatal("export accepted agent file drift")
	}
}

func TestReplacementAndMissingCredentialsCauseNoEffects(t *testing.T) {
	e, f, d, _ := setup(t)
	d.Spec.InferenceProviders[0].Endpoint = "https://inference.example.test/v1"
	d.Spec.InferenceProviders[0].Credential = &config.Credential{Env: "NEMOCLAW_TEST_ABSENT"}
	t.Setenv("NEMOCLAW_TEST_ABSENT", "")
	if invoke(t, e, "apply", d) == nil || f.count() != 0 {
		t.Fatal("missing credential permitted effects")
	}
	d.Spec.InferenceProviders[0].Credential = nil
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	effects := f.count()
	d.Spec.Sandboxes[0].Image.Ref = "example.test/changed@sha256:" + strings.Repeat("a", 64)
	if invoke(t, e, "apply", d) == nil || f.count() != effects {
		t.Fatal("ordinary apply replaced a sandbox")
	}
}

func TestUnreachableInferenceRetainsAnUnfinishedDeployment(t *testing.T) {
	e, f, d, _ := setup(t)
	f.inferenceExit = 1
	if invoke(t, e, "apply", d) == nil {
		t.Fatal("unreachable inference reported success")
	}
	r, err := loadRecord(e.StateDir)
	if err != nil || !r.Pending || r.Succeeded {
		t.Fatal("inference failure lost unfinished intent")
	}
	if f.count() != 4 {
		t.Fatal("expected four retained resources")
	}
	if invoke(t, e, "export", d) == nil {
		t.Fatal("exported deployment with failed inference")
	}
	f.mu.Lock()
	f.inferenceExit = 0
	f.mu.Unlock()
	if err = invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	if f.count() != 4 {
		t.Fatal("recovery duplicated resources")
	}
}
