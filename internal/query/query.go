// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Package query provides complete, typed observations from the openshell tables.
// An empty SQL result is never evidence that a resource is absent.
package query

import (
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/config"
	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
	"github.com/NVIDIA/NemoClaw/internal/subprocess"
)

type Key struct {
	Kind, Workspace, Name string
}

type Status string

const (
	Present Status = "present"
	Absent  Status = "absent"
	Failed  Status = "failed"
)

type Resource struct {
	ID, Owner, Generation                 string
	Endpoint, CredentialEnv               string
	ProviderName, Model, Image, AgentName string
	Phase                                 string
}

type Observation struct {
	Key
	Status Status
	Resource
}

// Row bridges the existing mutation/state attribute representation. Absence
// stays explicit until a caller decides what it means for its operation.
func (o Observation) Row() oshell.Row {
	if o.Status != Present {
		return nil
	}
	return oshell.Row{
		"name": o.Name, "workspace": o.Workspace, "id": o.ID,
		"owner": o.Owner, "generation": o.Generation,
		"endpoint": o.Endpoint, "credential_env": o.CredentialEnv,
		"provider_name": o.ProviderName, "model": o.Model,
		"image": o.Image, "agent_name": o.AgentName, "phase": o.Phase,
	}
}

type Client struct {
	BundleDir string
	Gateway   config.Gateway
}

// Read returns all requested observations, or an error and no observations.
// The same protocol is used for one-resource refresh and multi-table export.
func (c Client) Read(ctx context.Context, keys ...Key) (map[Key]Observation, error) {
	sql, err := statement(keys)
	if err != nil {
		return nil, err
	}
	if !filepath.IsAbs(c.BundleDir) {
		return nil, errors.New("osquery requires an absolute bundle directory")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	tmp, err := os.MkdirTemp("", "ncq-")
	if err != nil {
		return nil, errors.New("cannot create osquery observation directory")
	}
	defer os.RemoveAll(tmp)
	g, err := json.Marshal(c.Gateway)
	if err != nil {
		return nil, errors.New("cannot encode osquery gateway configuration")
	}
	env := append(subprocess.CleanEnv(), "NEMOCLAW_INTERNAL_GATEWAY="+string(g))
	socket := filepath.Join(tmp, "em")
	if runtime.GOOS == "windows" {
		socket = `\\.\pipe\` + filepath.Base(tmp)
	}
	b, err := subprocess.Run(ctx, tmp, subprocess.Executable(c.BundleDir, "osqueryi"), env,
		"--json", "--disable_logging=true", "--extensions_socket="+socket,
		"--extensions_timeout=20", "--extensions_require=nemoclaw",
		"--extension="+subprocess.Executable(c.BundleDir, "nemoclaw-osquery.ext"), sql)
	if err != nil {
		// Do not echo process stderr: extension/transport errors may contain secrets.
		return nil, errors.New("osquery query or extension failed; resource absence is unconfirmed")
	}
	return decode(b, keys)
}

var columns = []string{"kind", "name", "workspace", "observation_status", "observation_error", "id", "owner", "generation", "endpoint", "credential_env", "provider_name", "model", "image", "agent_name", "phase"}

func statement(keys []Key) (string, error) {
	if len(keys) == 0 {
		return "", errors.New("no resource observations requested")
	}
	seen := map[Key]bool{}
	var selects []string
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	for _, key := range keys {
		i := slices.IndexFunc(oshell.Definitions, func(d oshell.Definition) bool { return d.Kind == key.Kind })
		if i < 0 || key.Name == "" || (key.Kind == "workspace") != (key.Workspace == "") || seen[key] || strings.ContainsAny(key.Name+key.Workspace, "\x00") {
			return "", errors.New("invalid or duplicate observation key")
		}
		seen[key] = true
		def := oshell.Definitions[i]
		var expr []string
		for _, column := range columns {
			switch {
			case column == "kind":
				expr = append(expr, quote(key.Kind)+" AS kind")
			case column == "id" || column == "observation_status" || column == "observation_error" || slices.Contains(def.Fields, column) || (column == "phase" && key.Kind == "sandbox"):
				expr = append(expr, column)
			default:
				expr = append(expr, "'' AS "+column)
			}
		}
		sql := "SELECT " + strings.Join(expr, ",") + " FROM " + def.Table + " WHERE name=" + quote(key.Name)
		if key.Kind != "workspace" {
			sql += " AND workspace=" + quote(key.Workspace)
		}
		selects = append(selects, sql)
	}
	return strings.Join(selects, " UNION ALL "), nil
}

func decode(b []byte, keys []Key) (map[Key]Observation, error) {
	// Pointer values distinguish missing/null columns from legitimate empty text.
	// JSON v2 also rejects duplicate column names and malformed UTF-8.
	var rows []map[string]*string
	if json.Unmarshal(b, &rows) != nil || len(rows) != len(keys) {
		return nil, errors.New("osquery observation is incomplete; resource absence is unconfirmed")
	}
	out := map[Key]Observation{}
	for _, raw := range rows {
		if len(raw) != len(columns) {
			return nil, errors.New("osquery observation has incomplete columns")
		}
		row := oshell.Row{}
		for _, column := range columns {
			if raw[column] == nil {
				return nil, errors.New("osquery observation has missing or null columns")
			}
			row[column] = *raw[column]
		}
		key := Key{Kind: row["kind"], Workspace: row["workspace"], Name: row["name"]}
		if !slices.Contains(keys, key) || out[key].Status != "" {
			return nil, errors.New("osquery observation has unexpected or duplicate resources")
		}
		status := Status(row["observation_status"])
		if status == Failed {
			return nil, fmt.Errorf("observe %s: %s; resource absence is unconfirmed", key.Kind, row["observation_error"])
		}
		if row["observation_error"] != "" || (status != Present && status != Absent) {
			return nil, errors.New("osquery observation has invalid status")
		}
		if status == Present {
			for _, column := range append(slices.Clone(oshell.DefinitionFor(key.Kind).Fields), "id") {
				if column != "credential_env" && row[column] == "" {
					return nil, fmt.Errorf("osquery %s observation has incomplete resource attributes", key.Kind)
				}
			}
			if key.Kind == "sandbox" && row["phase"] == "" {
				return nil, errors.New("osquery sandbox observation is missing its phase")
			}
		} else {
			for _, column := range columns[5:] {
				if row[column] != "" {
					return nil, errors.New("osquery absence conflicts with resource attributes")
				}
			}
		}
		out[key] = Observation{Key: key, Status: status,
			ID: row["id"], Owner: row["owner"], Generation: row["generation"],
			Endpoint: row["endpoint"], CredentialEnv: row["credential_env"],
			ProviderName: row["provider_name"], Model: row["model"], Image: row["image"],
			AgentName: row["agent_name"], Phase: row["phase"],
		}
	}
	return out, nil
}
