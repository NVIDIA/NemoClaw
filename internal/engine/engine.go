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
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/config"
	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
	"github.com/gofrs/flock"
)

type Engine struct {
	StateDir, BundleDir string
	Output              io.Writer
}
type Change struct {
	Resource string   `json:"resource"`
	Actions  []string `json:"actions"`
}
type Result struct {
	Outcome string   `json:"outcome"`
	Changes []Change `json:"changes"`
}
type Plan struct {
	ResourceChanges []struct {
		Address string `json:"address"`
		Change  struct {
			Actions []string `json:"actions"`
		} `json:"change"`
	} `json:"resource_changes"`
}

func (e *Engine) Run(ctx context.Context, operation string, input io.Reader) error {
	if operation != "apply" && operation != "plan" && operation != "export" {
		return errors.New("expected config apply, config plan, or config export")
	}
	var d config.Document
	var err error
	if operation != "export" {
		d, err = config.Parse(input)
		if err != nil {
			return err
		}
	}
	e.StateDir, err = filepath.Abs(e.StateDir)
	if err != nil {
		return err
	}
	e.BundleDir, err = filepath.Abs(e.BundleDir)
	if err != nil {
		return err
	}
	if err = VerifyBundle(e.BundleDir); err != nil {
		return err
	}
	if err = os.MkdirAll(e.StateDir, 0700); err != nil {
		return err
	}
	lock := flock.New(filepath.Join(e.StateDir, "deployment.lock"))
	ok, err := lock.TryLock()
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("another operation holds the deployment lock")
	}
	defer lock.Unlock()
	record, err := loadRecord(e.StateDir)
	if err != nil {
		return err
	}
	if operation == "export" {
		return e.export(ctx, record)
	}
	for _, n := range d.CredentialNames() {
		if _, err = oshell.Resolve(n); err != nil {
			return err
		}
	}
	if record.Version != 0 {
		if record.Document.Metadata.UID != d.Metadata.UID || record.Document.Spec.Gateway.Endpoint != d.Spec.Gateway.Endpoint {
			return errors.New("state is bound to a different deployment UID or gateway")
		}
		if record.Pending && record.Digest != d.Digest() {
			return errors.New("unfinished apply has different intent; reapply its original YAML before changing configuration")
		}
	} else {
		record = Record{Version: 1, Generations: newGenerations()}
	}
	c, err := oshell.Connect(d.Spec.Gateway)
	if err != nil {
		return err
	}
	defer c.Close()
	preflightCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	info, err := c.Health().GetGatewayInfo(preflightCtx)
	if err != nil {
		return errors.New("cannot observe gateway capabilities")
	}
	if info.Version != "0.0.116" {
		return errors.New("this prototype requires OpenShell gateway 0.0.116")
	}
	if len(info.ComputeDrivers) != 1 {
		return errors.New("this slice requires a gateway with one compute driver")
	}
	wantDriver := d.Spec.Sandboxes[0].Runtime.Provider
	driver := info.ComputeDrivers[0]
	if driver.Name != wantDriver && driver.DriverName != wantDriver {
		return errors.New("gateway compute driver does not satisfy the configuration")
	}
	ids, err := e.stateIDs()
	if err != nil {
		return err
	}
	for _, target := range Targets(d, record.Generations) {
		got, err := oshell.Observe(preflightCtx, c, target.Kind, target.Values["workspace"], target.Values["name"])
		if err != nil {
			return err
		}
		target.Values["id"] = ids[target.Address]
		if got != nil {
			if err = oshell.VerifyIdentity(target.Values, got); err != nil {
				return fmt.Errorf("%s: %w", target, err)
			}
		} else if target.Values["id"] != "" {
			return fmt.Errorf("%s disappeared; automatic replacement is forbidden", target)
		}
	}
	if err = e.prepare(d, record.Generations); err != nil {
		return err
	}
	if _, err = e.tofu(ctx, "init", "-upgrade", "-input=false", "-no-color"); err != nil {
		return err
	}
	if _, err = e.tofu(ctx, "plan", "-input=false", "-no-color", "-parallelism=1", "-out=apply.plan"); err != nil {
		return err
	}
	b, err := e.tofu(ctx, "show", "-json", "apply.plan")
	if err != nil {
		return err
	}
	var plan Plan
	if err = json.Unmarshal(b, &plan); err != nil {
		return errors.New("invalid OpenTofu plan")
	}
	result := Result{Outcome: "planned", Changes: []Change{}}
	for _, change := range plan.ResourceChanges {
		if slices.Contains(change.Change.Actions, "delete") {
			return errors.New("plan would delete or replace a resource; resources retained")
		}
		if len(change.Change.Actions) == 1 && change.Change.Actions[0] == "no-op" {
			continue
		}
		result.Changes = append(result.Changes, Change{change.Address, change.Change.Actions})
	}
	if operation == "plan" {
		if record.Digest == "" {
			record.Document = d
			record.Digest = d.Digest()
			if err = saveJSON(filepath.Join(e.StateDir, "intent.json"), record); err != nil {
				return err
			}
		}
		return json.NewEncoder(e.Output).Encode(result)
	}
	planBytes, err := os.ReadFile(filepath.Join(e.StateDir, "apply.plan"))
	if err != nil {
		return err
	}
	digest := sha256.Sum256(planBytes)
	record.Document = d
	record.Digest = d.Digest()
	record.Pending = true
	record.Succeeded = false
	record.PlanDigest = hex.EncodeToString(digest[:])
	if err = saveJSON(filepath.Join(e.StateDir, "intent.json"), record); err != nil {
		return err
	}
	if _, err = e.tofu(ctx, "apply", "-input=false", "-no-color", "-parallelism=1", "apply.plan"); err != nil {
		return fmt.Errorf("apply incomplete; keep the state directory and reapply identical YAML: %w", err)
	}
	if err = oshell.Ready(ctx, c, d.Workspace(), d.Spec.Sandboxes[0].Name, d.Spec.Sandboxes[0].Agents[0].Name); err != nil {
		return err
	}
	if err = oshell.InferenceReady(ctx, c, d.Workspace(), d.Spec.Sandboxes[0].Name); err != nil {
		return err
	}
	record.Pending = false
	record.Succeeded = true
	if err = saveJSON(filepath.Join(e.StateDir, "intent.json"), record); err != nil {
		return err
	}
	result.Outcome = "succeeded"
	return json.NewEncoder(e.Output).Encode(result)
}

func (e *Engine) prepare(d config.Document, g map[string]string) error {
	// Generated configuration lives alone. A user-supplied .tf file must never
	// silently become part of the plan.
	entries, err := os.ReadDir(e.StateDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		n := entry.Name()
		if (strings.HasSuffix(n, ".tf") || strings.HasSuffix(n, ".tf.json") || strings.HasSuffix(n, ".tofu") || strings.HasSuffix(n, ".tofu.json")) && n != "main.tf.json" {
			return errors.New("unexpected OpenTofu configuration in state directory")
		}
	}
	bundleBytes, err := os.ReadFile(filepath.Join(e.BundleDir, "manifest.json"))
	if err != nil {
		return err
	}
	var manifest Manifest
	if err = json.Unmarshal(bundleBytes, &manifest); err != nil {
		return err
	}
	if err = saveJSON(filepath.Join(e.StateDir, "main.tf.json"), Compile(d, g, manifest.Version)); err != nil {
		return err
	}
	mirror := filepath.ToSlash(filepath.Join(e.BundleDir, "providers"))
	b, _ := json.Marshal(mirror)
	return atomicWrite(filepath.Join(e.StateDir, "providers.tfrc"), []byte("provider_installation {\n filesystem_mirror { path = "+string(b)+" }\n}\n"))
}

func (e *Engine) stateIDs() (map[string]string, error) {
	ids := map[string]string{}
	b, err := os.ReadFile(filepath.Join(e.StateDir, "terraform.tfstate"))
	if errors.Is(err, os.ErrNotExist) {
		return ids, nil
	}
	if err != nil {
		return nil, err
	}
	var state struct {
		Resources []struct {
			Type, Name string
			Instances  []struct {
				Attributes struct {
					ID string `json:"id"`
				}
			}
		}
	}
	if err = json.Unmarshal(b, &state); err != nil {
		return nil, errors.New("OpenTofu state is unreadable; retain it for recovery")
	}
	for _, r := range state.Resources {
		if len(r.Instances) != 1 {
			return nil, errors.New("unexpected resource instances in state")
		}
		ids[r.Type+"."+r.Name] = r.Instances[0].Attributes.ID
	}
	return ids, nil
}
