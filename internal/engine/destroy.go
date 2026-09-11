// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
)

const workspaceAddress = "nemoclaw_workspace.deployment"

type teardown struct {
	engine  *Engine
	changes []Change
	planned bool
}

func (e *Engine) destroy(ctx context.Context, r Record, preview bool) error {
	if r.Version == 0 {
		return errors.New("destroy requires an existing deployment state directory")
	}
	if r.Pending {
		return errors.New("unfinished apply may have unbound effects; reconcile its original YAML before destroy")
	}
	if r.Document.Spec.InferenceProviders[0].Ollama != nil {
		return errors.New("destroy does not yet support the combined Ollama container/storage resource; no changes made")
	}
	result := Result{Outcome: "planned", Changes: []Change{}}
	var err error
	result.Retained, err = e.retainedDestroyResources(r)
	if err != nil {
		return err
	}
	// A completed teardown has no running gateway to read. Its retained state
	// remains authoritative for the retention report, never for recreating data.
	if r.Destroyed {
		if !preview {
			result.Outcome = "destroyed"
		}
		return json.MarshalWrite(e.Output, result)
	}
	var stages []*teardown
	if !r.DestroyRuntime {
		stage, err := e.planTeardown(ctx, r, false)
		if err != nil {
			return err
		}
		stages = append(stages, stage)
	}
	if r.Document.Spec.Gateway.Management == "managed" {
		runtime := &Engine{StateDir: filepath.Join(e.StateDir, "runtime"), BundleDir: e.BundleDir}
		stage, err := runtime.planTeardown(ctx, r, true)
		if err != nil {
			return err
		}
		stages = append(stages, stage)
	}
	for _, stage := range stages {
		result.Changes = append(result.Changes, stage.changes...)
	}
	if preview {
		return json.MarshalWrite(e.Output, result)
	}
	// Both graphs have been observed and their complete saved plans checked.
	// Persist the operation before any deletes so apply cannot recreate children
	// during an interrupted teardown.
	r.Destroying = true
	r.Succeeded = false
	persist := func() error { return saveJSON(filepath.Join(e.StateDir, "intent.json"), r) }
	if err := persist(); err != nil {
		return err
	}
	for _, stage := range stages {
		if stage.planned {
			if _, err := stage.engine.tofu(ctx, "apply", "-input=false", "-no-color", "-parallelism=1", "destroy.plan"); err != nil {
				return fmt.Errorf("destroy incomplete; retain state and rerun destroy: %w", err)
			}
		}
		if stage.engine == e {
			r.DestroyRuntime = true
			if err := persist(); err != nil {
				return err
			}
		}
	}
	r.Destroying = false
	r.Destroyed = true
	r.PlanDigest = ""
	if err := persist(); err != nil {
		return err
	}
	result.Outcome = "destroyed"
	return json.MarshalWrite(e.Output, result)
}

func (e *Engine) retainedDestroyResources(r Record) ([]string, error) {
	retained := []string{}
	// Do not report allocations that never existed (for example plan-only state).
	ids, err := e.stateIDs()
	if err != nil {
		return nil, err
	}
	if ids[workspaceAddress] != "" {
		retained = append(retained, workspaceAddress)
	}
	if r.Document.Spec.Gateway.Management == "managed" {
		runtime := &Engine{StateDir: filepath.Join(e.StateDir, "runtime")}
		ids, err := runtime.stateIDs()
		if err != nil {
			return nil, err
		}
		for _, address := range []string{gatewayStorageAddress, storageAddress} {
			if ids[address] != "" {
				retained = append(retained, address)
			}
		}
	}
	return retained, nil
}

// planTeardown compiles only retained resources; removed blocks let OpenTofu use
// its recorded dependency graph for deletion. No -target or -refresh=false path
// can bypass the complete observations or plan action check.
func (e *Engine) planTeardown(ctx context.Context, r Record, runtime bool) (*teardown, error) {
	bindings, err := e.stateBindings()
	if err != nil {
		return nil, err
	}
	stage := &teardown{engine: e}
	if len(bindings) == 0 {
		if r.Succeeded || r.Destroying {
			return nil, errors.New("established deployment state is missing; destroy cannot infer unbound resources")
		}
		return stage, nil
	}
	if !runtime && bindings[workspaceAddress].ID == "" {
		return nil, errors.New("destroy requires the retained workspace binding")
	}
	if runtime {
		for _, spec := range runtimeSpecs(r.Document, r.Generations) {
			if bindings[runtimeAddress(spec)].ID != "" && (bindings[gatewayStorageAddress].ID == "" || (spec.Service != nil && bindings[storageAddress].ID == "")) {
				return nil, errors.New("destroy requires independent storage bindings before removing a managed process")
			}
		}
	}
	allowed := map[string]oshell.Row{}
	retained := map[string]bool{}
	if runtime {
		for _, spec := range runtimeSpecs(r.Document, r.Generations) {
			address := runtimeAddress(spec)
			old, err := boundRuntimeSpec(spec, bindings[address])
			if err != nil {
				return nil, err
			}
			allowed[address] = oshell.Row{"spec": old.JSON()}
		}
		allowed[gatewayStorageAddress] = oshell.Row{"spec": gatewayStorageSpec(r.Document, r.Generations).JSON()}
		retained[gatewayStorageAddress] = true
		if r.Document.Spec.InferenceProviders[0].Service != nil {
			b, err := json.Marshal(runtimeStorage(r.Document, r.Generations))
			if err != nil {
				return nil, err
			}
			allowed[storageAddress] = oshell.Row{"spec": string(b)}
			retained[storageAddress] = true
		}
	} else {
		for _, target := range Targets(r.Document, r.Generations) {
			allowed[target.Address] = target.Values
		}
		retained[workspaceAddress] = true
	}
	for address, binding := range bindings {
		want, ok := allowed[address]
		if !ok {
			return nil, errors.New("destroy encountered an undeclared resource binding")
		}
		want["id"] = binding.ID
		if runtime && want["spec"] != binding.Spec {
			return nil, errors.New("destroy storage configuration disagrees with retained intent")
		}
	}
	if err = e.prepare(r.Document, r.Generations); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(e.StateDir, "main.tf.json"))
	if err != nil {
		return nil, err
	}
	var compiled map[string]any
	if err = json.Unmarshal(b, &compiled); err != nil {
		return nil, err
	}
	compiled["provider"].(map[string]any)["nemoclaw"].(map[string]any)["destroy"] = true
	resources := map[string]any{}
	for address := range retained {
		if bindings[address].ID == "" {
			continue
		}
		kind, name, _ := strings.Cut(address, ".")
		attrs := map[string]any{"lifecycle": map[string]any{"prevent_destroy": true}}
		for k, v := range allowed[address] {
			if k != "id" {
				attrs[k] = v
			}
		}
		resources[kind] = map[string]any{name: attrs}
	}
	compiled["resource"] = resources
	if err = saveJSON(filepath.Join(e.StateDir, "main.tf.json"), compiled); err != nil {
		return nil, err
	}
	if _, err = e.tofu(ctx, "init", "-upgrade", "-input=false", "-no-color"); err != nil {
		return nil, err
	}
	if _, err = e.tofu(ctx, "plan", "-input=false", "-no-color", "-parallelism=1", "-out=destroy.plan"); err != nil {
		return nil, err
	}
	b, err = e.tofu(ctx, "show", "-json", "destroy.plan")
	if err != nil {
		return nil, err
	}
	var plan Plan
	if err = json.Unmarshal(b, &plan); err != nil {
		return nil, errors.New("invalid destroy plan")
	}
	stage.changes, err = checkDestroyPlan(plan, bindings, allowed, retained)
	stage.planned = err == nil
	return stage, err
}

func checkDestroyPlan(plan Plan, bindings map[string]stateBinding, allowed map[string]oshell.Row, retained map[string]bool) ([]Change, error) {
	changes := []Change{}
	seen := map[string]bool{}
	absent := map[string]bool{}
	for _, drift := range plan.ResourceDrift {
		if _, ok := allowed[drift.Address]; !ok || bindings[drift.Address].ID == "" {
			return nil, errors.New("destroy plan contains unbound resource drift")
		}
		if slices.Equal(drift.Change.Actions, []string{"delete"}) {
			if absent[drift.Address] || retained[drift.Address] || drift.Change.Before["id"] != bindings[drift.Address].ID {
				return nil, errors.New("destroy plan lost a retained or differently bound resource")
			}
			absent[drift.Address] = true
		}
	}
	for _, change := range plan.ResourceChanges {
		address := change.Address
		want, ok := allowed[address]
		if !ok || bindings[address].ID == "" || seen[address] || absent[address] {
			return nil, errors.New("destroy plan contains an unknown, unbound, or duplicate resource")
		}
		seen[address] = true
		if change.Change.Before["id"] != bindings[address].ID {
			return nil, errors.New("destroy plan changed a durable resource identity")
		}
		for _, key := range []string{"name", "workspace", "owner", "generation", "spec"} {
			if v, exists := want[key]; exists && change.Change.Before[key] != v {
				return nil, errors.New("destroy plan ownership or configuration disagrees with retained intent")
			}
		}
		action := "delete"
		if retained[address] {
			action = "no-op"
		}
		if !slices.Equal(change.Change.Actions, []string{action}) {
			return nil, errors.New("destroy plan would create, update, replace, forget, or delete retained data")
		}
		if action == "delete" {
			changes = append(changes, Change{Resource: address, Actions: change.Change.Actions})
		}
	}
	for address := range bindings {
		if !seen[address] && !absent[address] {
			return nil, errors.New("destroy plan omitted a resource without confirmed absence")
		}
	}
	return changes, nil
}
