// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"github.com/NVIDIA/NemoClaw/internal/config"
	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
)

func (e *Engine) export(ctx context.Context, r Record) error {
	if !r.Succeeded || r.Pending {
		return errors.New("export requires a successfully applied deployment; reconcile any unfinished apply first")
	}
	ids, err := e.stateIDs()
	if err != nil {
		return err
	}
	d := r.Document
	// One osquery process collects four resource tables. Missing rows, including
	// a table query that failed upstream, cannot become an apparently valid export.
	columns := []string{"kind", "id", "name", "owner", "generation", "workspace", "endpoint", "credential_env", "provider_name", "model", "image", "agent_name"}
	var selects []string
	for _, t := range Targets(d, r.Generations) {
		def := oshell.DefinitionFor(t.Kind)
		var expr []string
		for _, column := range columns {
			switch {
			case column == "kind":
				expr = append(expr, "'"+t.Kind+"' AS kind")
			case column == "id" || slices.Contains(def.Fields, column):
				expr = append(expr, column)
			default:
				expr = append(expr, "'' AS "+column)
			}
		}
		query := "SELECT " + strings.Join(expr, ",") + " FROM " + def.Table + " WHERE name='" + t.Values["name"] + "'"
		if t.Kind != "workspace" {
			query += " AND workspace='" + d.Workspace() + "'"
		}
		selects = append(selects, query)
	}
	tmp, err := os.MkdirTemp("", "ncq-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	g, _ := json.Marshal(d.Spec.Gateway)
	env := append(cleanEnv(), "NEMOCLAW_INTERNAL_GATEWAY="+string(g))
	socket := filepath.Join(tmp, "em")
	if runtime.GOOS == "windows" {
		socket = `\\.\pipe\` + filepath.Base(tmp)
	}
	b, err := run(ctx, e.StateDir, executable(e.BundleDir, "osqueryi"), env, "--json", "--disable_logging=true", "--extensions_socket="+socket, "--extensions_timeout=30", "--extensions_require=nemoclaw", "--extension="+executable(e.BundleDir, "nemoclaw-osquery.ext"), strings.Join(selects, " UNION ALL "))
	if err != nil {
		return err
	}
	var rows []oshell.Row
	if json.Unmarshal(b, &rows) != nil || len(rows) != 4 {
		return errors.New("resource observation is incomplete; no YAML exported")
	}
	for _, t := range Targets(d, r.Generations) {
		var got oshell.Row
		for _, row := range rows {
			if row["kind"] == t.Kind {
				if got != nil {
					return errors.New("ambiguous resource observation")
				}
				got = row
			}
		}
		t.Values["id"] = ids[t.Address]
		if t.Values["id"] == "" {
			return errors.New("resource has no durable state identity")
		}
		if err = oshell.VerifyIdentity(t.Values, got); err != nil {
			return fmt.Errorf("export %s: %w", t.Kind, err)
		}
		switch t.Kind {
		case "provider":
			d.Spec.InferenceProviders[0].Endpoint = got["endpoint"]
			d.Spec.InferenceProviders[0].Credential = nil
			if got["credential_env"] != "" {
				d.Spec.InferenceProviders[0].Credential = &config.Credential{Env: got["credential_env"]}
			}
		case "route":
			if got["provider_name"] != d.Spec.InferenceProviders[0].Name {
				return errors.New("route references a provider outside this deployment")
			}
			d.Spec.Sandboxes[0].Agents[0].Inference.Routes[0].Overrides.Model = got["model"]
		case "sandbox":
			if got["image"] != t.Values["image"] || got["agent_name"] != t.Values["agent_name"] {
				return errors.New("sandbox configuration drift requires inspection")
			}
		}
	}
	if err = d.Validate(); err != nil {
		return err
	}
	c, err := oshell.Connect(d.Spec.Gateway)
	if err != nil {
		return err
	}
	defer c.Close()
	if err = oshell.Ready(ctx, c, d.Workspace(), d.Spec.Sandboxes[0].Name, d.Spec.Sandboxes[0].Agents[0].Name); err != nil {
		return err
	}
	b, err = d.YAML()
	if err != nil {
		return err
	}
	_, err = e.Output.Write(b)
	return err
}
