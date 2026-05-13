#!/usr/bin/env python3
"""Collect all items for a given sprint from the NemoClaw Development Tracker (GitHub Project #199).

Usage:
    python3 collect_sprint_items.py "Sprint 3" [repo-path] > /tmp/sprint_data.json

Outputs JSON array of sprint items to stdout. Progress to stderr.
"""
import json
import os
import subprocess
import sys

def main():
    if len(sys.argv) < 2:
        print("Usage: collect_sprint_items.py <sprint-title> [repo-path]", file=sys.stderr)
        sys.exit(1)

    target_sprint = sys.argv[1]
    repo_path = sys.argv[2] if len(sys.argv) > 2 else os.environ.get('NEMOCLAW_REPO', os.getcwd())
    all_items = []
    cursor = None
    page = 0

    while True:
        page += 1
        after_clause = f', after: "{cursor}"' if cursor else ''
        query = f'''
        {{
          organization(login: "NVIDIA") {{
            projectV2(number: 199) {{
              items(first: 100{after_clause}) {{
                nodes {{
                  content {{
                    ... on Issue {{
                      number
                      title
                      state
                      url
                      assignees(first: 5) {{ nodes {{ login }} }}
                      labels(first: 10) {{ nodes {{ name }} }}
                    }}
                    ... on PullRequest {{
                      number
                      title
                      state
                      url
                      author {{ login }}
                      assignees(first: 5) {{ nodes {{ login }} }}
                      labels(first: 10) {{ nodes {{ name }} }}
                    }}
                  }}
                  fieldValues(first: 20) {{
                    nodes {{
                      ... on ProjectV2ItemFieldSingleSelectValue {{
                        name
                        field {{ ... on ProjectV2SingleSelectField {{ name }} }}
                      }}
                      ... on ProjectV2ItemFieldIterationValue {{
                        title
                        startDate
                        duration
                        field {{ ... on ProjectV2IterationField {{ name }} }}
                      }}
                    }}
                  }}
                }}
                pageInfo {{
                  hasNextPage
                  endCursor
                }}
              }}
            }}
          }}
        }}'''

        result = subprocess.run(
            ['gh', 'api', 'graphql', '-f', f'query={query}'],
            capture_output=True, text=True,
            cwd=repo_path
        )

        if result.returncode != 0:
            print(f"GraphQL error on page {page}: {result.stderr}", file=sys.stderr)
            sys.exit(1)

        data = json.loads(result.stdout)
        items_data = data['data']['organization']['projectV2']['items']

        for item in items_data['nodes']:
            content = item.get('content', {})
            if not content:
                continue

            sprint = None
            status = None
            for fv in item['fieldValues']['nodes']:
                field_name = fv.get('field', {}).get('name', '')
                if field_name == 'Sprint' and fv.get('title') == target_sprint:
                    sprint = target_sprint
                if field_name == 'Status':
                    status = fv.get('name')

            if sprint == target_sprint:
                num = content.get('number', '?')
                title = content.get('title', '?')
                state = content.get('state', '?')
                assignees = [a['login'] for a in content.get('assignees', {}).get('nodes', [])]
                labels = [label['name'] for label in content.get('labels', {}).get('nodes', [])]
                is_pr = 'author' in content
                author = content.get('author', {}).get('login', '') if is_pr else ''

                all_items.append({
                    'number': num,
                    'title': title,
                    'state': state,
                    'status': status or 'No Status',
                    'assignees': assignees,
                    'labels': labels,
                    'type': 'PR' if is_pr else 'Issue',
                    'author': author
                })

        has_next = items_data['pageInfo']['hasNextPage']
        cursor = items_data['pageInfo']['endCursor']
        print(f"Page {page}: {len(all_items)} {target_sprint} items so far", file=sys.stderr)

        if not has_next:
            break

    print(f"Total: {len(all_items)} items", file=sys.stderr)
    json.dump(all_items, sys.stdout, indent=2)


if __name__ == '__main__':
    main()
