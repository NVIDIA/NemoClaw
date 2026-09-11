// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/config"
	"github.com/NVIDIA/NemoClaw/internal/managed"
	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
)

func runtimeSpecs(d config.Document, g map[string]string) []managed.Spec {
	if d.Spec.Gateway.Management != "managed" {
		return nil
	}
	s := []managed.Spec{{Layout: 2, Kind: managed.GatewayKind, Name: d.Workspace() + "-gateway", Owner: d.Metadata.UID, Generation: g[managed.GatewayKind], Gateway: d.Spec.Gateway}}
	if service := d.Spec.InferenceProviders[0].Service; service != nil {
		s = append(s, managed.Spec{Kind: managed.ServiceKind, Name: d.Workspace() + "-inference", Owner: d.Metadata.UID, Generation: g[managed.ServiceKind], Gateway: d.Spec.Gateway, Service: service})
	}
	return s
}

func runtimeAddress(s managed.Spec) string { return "nemoclaw_" + s.Kind + ".runtime" }

func runtimeStorage(d config.Document, g map[string]string) managed.Storage {
	return managed.Storage{Name: d.Workspace() + "-inference-data", Owner: d.Metadata.UID, Generation: g[managed.ServiceKind], Engine: d.Spec.Gateway.Engine}
}

func gatewayStorageSpec(d config.Document, g map[string]string) managed.Spec {
	s := runtimeSpecs(d, g)[0]
	s.Layout = 0
	return s
}

const gatewayStorageAddress = "nemoclaw_gateway_storage.runtime"
const storageAddress = "nemoclaw_inference_storage.runtime"

func (e *Engine) runtimeStage(ctx context.Context, operation string, d config.Document, r *Record) ([]Change, bool, error) {
	if d.Spec.Gateway.Management != "managed" {
		return nil, false, nil
	}
	for _, k := range []string{managed.GatewayKind, managed.ServiceKind} {
		if r.Generations[k] == "" {
			r.Generations[k] = newGenerations()[k]
		}
	}
	stage := &Engine{StateDir: filepath.Join(e.StateDir, "runtime"), BundleDir: e.BundleDir, Output: e.Output}
	if err := os.MkdirAll(stage.StateDir, 0700); err != nil {
		return nil, false, err
	}
	ids, err := stage.stateIDs()
	if err != nil {
		return nil, false, err
	}
	bindings, err := stage.stateBindings()
	if err != nil {
		return nil, false, err
	}
	specs := runtimeSpecs(d, r.Generations)
	expected := len(specs) + 1
	if d.Spec.InferenceProviders[0].Service != nil {
		expected++
	}
	if len(ids) > expected {
		return nil, false, errors.New("ordinary apply cannot remove a managed runtime")
	}
	docker, err := managed.New(d.Spec.Gateway.Engine)
	if err != nil {
		return nil, false, err
	}
	defer docker.Close()
	gatewayStorageID, err := docker.GatewayStorage(ctx, gatewayStorageSpec(d, r.Generations), ids[gatewayStorageAddress], false)
	if err != nil && !errors.Is(err, managed.ErrPartial) {
		return nil, false, err
	}
	storageIdentity := ""
	if d.Spec.InferenceProviders[0].Service != nil {
		storageIdentity, err = docker.Storage(ctx, runtimeStorage(d, r.Generations), ids[storageAddress], false)
		if err != nil {
			return nil, false, err
		}
	}
	gatewayRunning := false
	replacements := map[string]bool{}
	for _, s := range specs {
		observedSpec, err := boundRuntimeSpec(s, bindings[runtimeAddress(s)])
		if err != nil {
			return nil, false, err
		}
		if observedSpec.JSON() != s.JSON() {
			switch s.Kind {
			case managed.ServiceKind:
				replacements[runtimeAddress(s)] = storageIdentity != ""
			case managed.GatewayKind:
				replacements[runtimeAddress(s)] = gatewayStorageID != ""
			}
		}
		o, err := docker.Observe(ctx, observedSpec, ids[runtimeAddress(s)])
		if err != nil && !errors.Is(err, managed.ErrPartial) {
			return nil, false, err
		}
		if s.Kind == managed.GatewayKind {
			gatewayRunning = o != nil && o.Running
		}
		if s.Service != nil {
			if err = docker.Capacity(ctx, s, o); err != nil {
				return nil, false, err
			}
		}
	}
	if err = stage.prepare(d, r.Generations); err != nil {
		return nil, false, err
	}
	b, err := os.ReadFile(filepath.Join(stage.StateDir, "main.tf.json"))
	if err != nil {
		return nil, false, err
	}
	var compiled map[string]any
	if err = json.Unmarshal(b, &compiled); err != nil {
		return nil, false, err
	}
	resources := map[string]any{"nemoclaw_gateway_storage": map[string]any{"runtime": map[string]any{"spec": gatewayStorageSpec(d, r.Generations).JSON(), "lifecycle": map[string]any{"prevent_destroy": true}}}}
	if d.Spec.InferenceProviders[0].Service != nil {
		storage, _ := json.Marshal(runtimeStorage(d, r.Generations))
		resources["nemoclaw_inference_storage"] = map[string]any{"runtime": map[string]any{"spec": string(storage), "lifecycle": map[string]any{"prevent_destroy": true}}}
	}
	for _, s := range specs {
		attrs := map[string]any{"spec": s.JSON(), "depends_on": []string{gatewayStorageAddress}}
		if s.Service != nil {
			attrs["depends_on"] = []string{"nemoclaw_managed_gateway.runtime", storageAddress}
		}
		resources["nemoclaw_"+s.Kind] = map[string]any{"runtime": attrs}
	}
	compiled["resource"] = resources
	if err = saveJSON(filepath.Join(stage.StateDir, "main.tf.json"), compiled); err != nil {
		return nil, false, err
	}
	if _, err = stage.tofu(ctx, "init", "-upgrade", "-input=false", "-no-color"); err != nil {
		return nil, false, err
	}
	if _, err = stage.tofu(ctx, "plan", "-input=false", "-no-color", "-parallelism=1", "-out=apply.plan"); err != nil {
		return nil, false, err
	}
	b, err = stage.tofu(ctx, "show", "-json", "apply.plan")
	if err != nil {
		return nil, false, err
	}
	var plan Plan
	if json.Unmarshal(b, &plan) != nil {
		return nil, false, errors.New("invalid runtime plan")
	}
	allowed := map[string]bool{gatewayStorageAddress: true}
	if d.Spec.InferenceProviders[0].Service != nil {
		allowed[storageAddress] = true
	}
	for _, s := range specs {
		allowed[runtimeAddress(s)] = true
	}
	changes, err := checkRuntimePlan(plan, allowed, replacements)
	if err != nil {
		return nil, false, err
	}
	if operation == "plan" {
		if !gatewayRunning {
			childIDs, err := e.stateIDs()
			if err != nil {
				return nil, false, err
			}
			if len(childIDs) != 0 {
				return nil, false, errors.New("runtime restart is planned but OpenShell observations are unavailable; apply the unchanged intent to reconcile the runtime stage")
			}
		}
		if r.Digest == "" {
			r.Document = d
			r.Digest = d.Digest()
			if err = saveJSON(filepath.Join(e.StateDir, "intent.json"), r); err != nil {
				return nil, false, err
			}
		}
		return changes, !gatewayRunning, nil
	}
	// Each explicit graph has its own checked saved plan. Persist intent before
	// runtime effects; a crash can then reconcile the same operation generations.
	b, err = os.ReadFile(filepath.Join(stage.StateDir, "apply.plan"))
	if err != nil {
		return nil, false, err
	}
	h := sha256.Sum256(b)
	r.Document = d
	r.Digest = d.Digest()
	r.Pending = true
	r.Succeeded = false
	r.PlanDigest = hex.EncodeToString(h[:])
	if err = saveJSON(filepath.Join(e.StateDir, "intent.json"), r); err != nil {
		return nil, false, err
	}
	if _, err = stage.tofu(ctx, "apply", "-input=false", "-no-color", "-parallelism=1", "apply.plan"); err != nil {
		return nil, false, fmt.Errorf("runtime apply incomplete; retain data and reapply identical YAML: %w", err)
	}
	r.Pending = false
	if err = saveJSON(filepath.Join(e.StateDir, "intent.json"), r); err != nil {
		return nil, false, err
	}
	if err = waitRuntime(ctx, d, specs, docker, stage); err != nil {
		return nil, false, err
	}
	return changes, false, nil
}

// State records the configuration actually established by OpenTofu. Intent may
// already contain a new image when interruption leaves the old container bound.
func boundRuntimeSpec(want managed.Spec, binding stateBinding) (managed.Spec, error) {
	if binding.ID == "" {
		return want, nil
	}
	var old managed.Spec
	if json.Unmarshal([]byte(binding.Spec), &old) != nil || old.Validate() != nil || old.Kind != want.Kind || old.Name != want.Name || old.Owner != want.Owner || old.Generation != want.Generation || old.Gateway.Engine != want.Gateway.Engine {
		return old, errors.New("managed runtime state identity or configuration is invalid")
	}
	return old, nil
}

func checkRuntimePlan(plan Plan, allowed map[string]bool, replacements map[string]bool) ([]Change, error) {
	changes := []Change{}
	seen := map[string]bool{}
	for _, c := range plan.ResourceChanges {
		replacement := (c.Address == "nemoclaw_inference_service.runtime" || c.Address == "nemoclaw_managed_gateway.runtime") && replacements[c.Address] && slices.Equal(c.Change.Actions, []string{"delete", "create"})
		if !allowed[c.Address] || seen[c.Address] || (!replacement && (len(c.Change.Actions) != 1 || !slices.Contains([]string{"no-op", "create", "update"}, c.Change.Actions[0]))) {
			return nil, errors.New("runtime plan would remove, replace, or affect an undeclared resource")
		}
		seen[c.Address] = true
		if c.Change.Actions[0] != "no-op" {
			changes = append(changes, Change{Resource: c.Address, Actions: c.Change.Actions})
		}
	}
	if len(seen) != len(allowed) {
		return nil, errors.New("runtime plan omitted a required resource; no changes applied")
	}
	return changes, nil
}

func waitRuntime(ctx context.Context, d config.Document, specs []managed.Spec, docker *managed.Docker, stage *Engine) error {
	c, err := oshell.Connect(d.Spec.Gateway)
	if err != nil {
		return err
	}
	defer c.Close()
	ready, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	for {
		probe, stop := context.WithTimeout(ready, 2*time.Second)
		_, err = c.Health().GetGatewayInfo(probe)
		stop()
		if err == nil {
			break
		}
		select {
		case <-ready.Done():
			return errors.New("managed gateway readiness failed; established identity and data retained")
		case <-time.After(time.Second):
		}
	}
	ids, err := stage.stateIDs()
	if err != nil {
		return err
	}
	for _, s := range specs {
		if s.Service == nil {
			continue
		}
		wait, cancel := context.WithTimeout(ctx, 9*time.Hour)
		defer cancel()
		lastPhase := ""
		for {
			o, err := docker.Observe(wait, s, ids[runtimeAddress(s)])
			if err != nil {
				return err
			}
			if o == nil || !o.Running {
				return errors.New("inference runtime stopped; identity and model data retained; inspect container logs and explicitly reapply")
			}
			status, err := docker.Status(wait, o)
			if err != nil {
				return err
			}
			if status.Phase != lastPhase {
				fmt.Fprintln(os.Stderr, "Spark runtime:", status.Phase)
				lastPhase = status.Phase
			}
			if status.Phase == "ready" {
				return docker.VerifyArtifacts(wait, o)
			}
			select {
			case <-wait.Done():
				return errors.New("runtime readiness interrupted; container, watchdog, and persistent data remain owned")
			case <-time.After(5 * time.Second):
			}
		}
	}
	return nil
}
