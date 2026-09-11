// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package query

import (
	"encoding/json/v2"
	"maps"
	"strings"
	"testing"
)

func receipt(key Key, status Status) map[string]string {
	r := map[string]string{}
	for _, column := range columns {
		r[column] = ""
	}
	r["kind"], r["workspace"], r["name"] = key.Kind, key.Workspace, key.Name
	r["observation_status"] = string(status)
	if status == Present {
		r["id"], r["owner"], r["generation"] = "durable-id", "owner", "generation"
		r["endpoint"] = "http://127.0.0.1:11434/v1"
	}
	return r
}

func TestCompleteObservationAndConfirmedAbsence(t *testing.T) {
	present := Key{Kind: "provider", Workspace: "workspace", Name: "local"}
	absent := Key{Kind: "provider", Workspace: "workspace", Name: "deleted"}
	b, err := json.Marshal([]map[string]string{receipt(present, Present), receipt(absent, Absent)})
	if err != nil {
		t.Fatal(err)
	}
	got, err := decode(b, []Key{present, absent})
	if err != nil {
		t.Fatal(err)
	}
	if got[present].Status != Present || got[present].ID != "durable-id" || got[present].Endpoint != "http://127.0.0.1:11434/v1" || got[present].Row()["generation"] != "generation" {
		t.Fatalf("lost resource attributes: %+v", got[present])
	}
	if got[absent].Status != Absent || got[absent].Row() != nil {
		t.Fatal("absence lost its explicit status")
	}
}

func TestInvalidObservationsNeverYieldAbsenceOrPartialSuccess(t *testing.T) {
	key := Key{Kind: "provider", Workspace: "workspace", Name: "local"}
	valid := receipt(key, Present)
	encoded := func(rows ...map[string]string) []byte {
		b, err := json.Marshal(rows)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	change := func(column, value string) []byte {
		r := maps.Clone(valid)
		r[column] = value
		return encoded(r)
	}
	missing := maps.Clone(valid)
	delete(missing, "credential_env") // Optional value still needs a complete column.
	failed := receipt(key, Failed)
	failed["observation_error"] = "gateway authentication failed"
	tests := map[string][]byte{
		"empty": []byte(`[]`), "null": []byte(`null`), "truncated": []byte(`[{`),
		"duplicate resources": encoded(valid, valid),
		"missing column":      encoded(missing),
		"null column":         []byte(strings.Replace(string(encoded(valid)), `"credential_env":""`, `"credential_env":null`, 1)),
		"duplicate column":    []byte(strings.Replace(string(encoded(valid)), `"id":"durable-id"`, `"id":"durable-id","id":"other"`, 1)),
		"wrong key":           change("name", "other"), "wrong workspace": change("workspace", "other"),
		"wrong kind": change("kind", "workspace"), "missing identity": change("id", ""),
		"missing status":        change("observation_status", ""),
		"unknown status":        change("observation_status", "unknown"),
		"contradictory absence": change("observation_status", "absent"),
		"error on present":      change("observation_error", "failure"),
		"failed":                encoded(failed),
	}
	for name, b := range tests {
		t.Run(name, func(t *testing.T) {
			if got, err := decode(b, []Key{key}); err == nil || got != nil {
				t.Fatalf("invalid observation yielded state: %+v, %v", got, err)
			}
		})
	}
	other := Key{Kind: "provider", Workspace: "workspace", Name: "other"}
	for _, b := range [][]byte{encoded(valid), encoded(valid, valid), encoded(valid, receipt(other, Failed))} {
		if got, err := decode(b, []Key{key, other}); err == nil || got != nil {
			t.Fatalf("partial batch yielded state: %+v, %v", got, err)
		}
	}
}

func TestQueryKeysAreConstrainedAndQuoted(t *testing.T) {
	key := Key{Kind: "provider", Workspace: "a'b", Name: "local' OR 1=1 --"}
	sql, err := statement([]Key{key})
	if err != nil || !strings.Contains(sql, "WHERE name='local'' OR 1=1 --' AND workspace='a''b'") {
		t.Fatalf("unquoted key: %s, %v", sql, err)
	}
	for _, keys := range [][]Key{nil, {key, key}, {{Kind: "unknown", Name: "x"}}, {{Kind: "provider", Name: "x"}}, {{Kind: "workspace", Name: "x", Workspace: "x"}}, {{Kind: "workspace", Name: "x\x00"}}} {
		if _, err := statement(keys); err == nil {
			t.Fatalf("accepted invalid keys: %+v", keys)
		}
	}
}
