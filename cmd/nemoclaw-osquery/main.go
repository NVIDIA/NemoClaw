// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"slices"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/config"
	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
	"github.com/osquery/osquery-go"
	"github.com/osquery/osquery-go/plugin/table"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	socket := flag.String("socket", "", "osquery extension transport")
	flag.Int("timeout", 10, "registration timeout")
	flag.Int("interval", 3, "watchdog interval")
	flag.Bool("verbose", false, "verbose mode")
	flag.Parse()
	var g config.Gateway
	if err := json.Unmarshal([]byte(os.Getenv("NEMOCLAW_INTERNAL_GATEWAY")), &g); err != nil {
		return errors.New("gateway configuration is unavailable")
	}
	c, err := oshell.Connect(g)
	if err != nil {
		return err
	}
	defer c.Close()
	s, err := osquery.NewExtensionManagerServer("nemoclaw", *socket)
	if err != nil {
		return errors.New("cannot register osquery extension")
	}
	for _, d := range oshell.Definitions {
		var cols []table.ColumnDefinition
		for _, n := range append(slices.Clone(d.Fields), "id") {
			cols = append(cols, table.TextColumn(n))
		}
		if d.Kind == "sandbox" {
			cols = append(cols, table.TextColumn("phase"))
		}
		s.RegisterPlugin(table.NewPlugin(d.Table, cols, func(ctx context.Context, q table.QueryContext) ([]map[string]string, error) {
			name, err := equal(q, "name")
			if err != nil {
				return nil, err
			}
			workspace := ""
			if d.Kind != "workspace" {
				workspace, err = equal(q, "workspace")
				if err != nil {
					return nil, err
				}
			}
			ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			row, err := oshell.Observe(ctx, c, d.Kind, workspace, name)
			if err != nil {
				return nil, err
			}
			if row == nil {
				return nil, nil
			}
			return []map[string]string{row}, nil
		}))
	}
	return s.Run()
}
func equal(q table.QueryContext, name string) (string, error) {
	for _, c := range q.Constraints[name].Constraints {
		if c.Operator == table.OperatorEquals {
			return c.Expression, nil
		}
	}
	return "", fmt.Errorf("an equality constraint on %s is required", name)
}
