#!/usr/bin/env python3
"""One-off catalog coverage survey against the ServiceNow demo instance.

Enumerates every variable type used by active catalog items, fetches a sample
item per type through the SAME catalog API the MCP server uses
(/api/sn_sc/servicecatalog/items/{sys_id}), and prints the friendly_type the
API returns so we can confirm the widget field mapper covers it.

Usage: SN_AUTH='admin:pwd' python3 scripts/dev/catalog-coverage-survey.py
"""
import os, sys, json, urllib.request, base64, collections

SN = os.environ.get("SN_URL", "https://your-instance.service-now.com")
AUTH = os.environ["SN_AUTH"]  # "user:pass"

def get(path):
    req = urllib.request.Request(SN + path)
    req.add_header("Authorization", "Basic " + base64.b64encode(AUTH.encode()).decode())
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

# 1. distinct types in use
stats = get("/api/now/stats/item_option_new?sysparm_group_by=type&sysparm_count=true")
types = []
for row in stats["result"]:
    t = row["groupby_fields"][0]["value"]
    c = int(row["stats"]["count"])
    types.append((t, c))
types.sort(key=lambda x: -x[1])

# 2. one sample cat_item per type
sample = {}
for t, _ in types:
    r = get(f"/api/now/table/item_option_new?sysparm_query=type={t}^cat_itemISNOTEMPTY&sysparm_fields=cat_item,name,question_text&sysparm_limit=1")
    res = r["result"]
    if res and res[0].get("cat_item"):
        sample[t] = {"item": res[0]["cat_item"]["value"], "var": res[0].get("name"), "q": res[0].get("question_text")}

# 3. fetch each sample item via the catalog API and collect friendly_type per type code
print(f"{'type':>4} {'count':>5}  {'friendly_type(s) from catalog API':<40} sample var")
print("-" * 90)
friendly_by_type = collections.defaultdict(set)
for t, c in types:
    s = sample.get(t)
    ft = "?"
    sample_var = ""
    if s:
        try:
            item = get(f"/api/sn_sc/servicecatalog/items/{s['item']}")
            for v in item["result"].get("variables", []):
                if v.get("name") == s["var"]:
                    ft = v.get("friendly_type") or v.get("display_type") or f"(type {v.get('type')})"
                    friendly_by_type[t].add(ft)
                    sample_var = s["var"] or ""
                    break
            else:
                ft = "(not exposed by catalog API)"
        except Exception as e:
            ft = f"(error: {e})"
    print(f"{t:>4} {c:>5}  {ft:<40} {sample_var}")
