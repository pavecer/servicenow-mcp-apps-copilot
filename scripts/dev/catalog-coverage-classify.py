#!/usr/bin/env python3
"""Catalog coverage classification — runs the SAME field-type logic the MCP
server uses (toWidgetFieldType / normalizeVariableType) against every variable
the catalog API actually returns for a sample of real items, and reports how
each friendly_type is classified + flags likely gaps.

Usage: SN_AUTH='admin:pwd' python3 scripts/dev/catalog-coverage-classify.py [num_items]
"""
import os, sys, json, urllib.request, base64, collections

SN = os.environ.get("SN_URL", "https://dev310193.service-now.com")
AUTH = os.environ["SN_AUTH"]
N = int(sys.argv[1]) if len(sys.argv) > 1 else 60

def get(path):
    req = urllib.request.Request(SN + path)
    req.add_header("Authorization", "Basic " + base64.b64encode(AUTH.encode()).decode())
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

LABEL = {"0","11","label","label_only","container_start","checkbox_container",
         "begin_split","split","formatted_text","html","rich_text_label","macro_with_label"}
SKIP = {"macro","ui_macro","custom","break","container_end","end_split","split_end"}
BOOL = {"1","5","7","boolean","checkbox","check_box","yesno","true_false"}
NUM = {"3","4","integer","decimal","numeric","number"}
DATE = {"8","9","date","glide_date"}
DT = {"6","10","datetime","glide_date_time","date_time"}
LONG = {"2","textarea","multi_line","multiline","multi_line_text","longtext"}

def classify(raw):
    raw = (raw or "").lower()
    if raw in LABEL: return "label"
    if raw in SKIP: return "skip"
    if raw in BOOL: return "boolean"
    if raw in NUM: return "number"
    if raw == "email": return "email"
    if raw in DATE: return "date"
    if raw in DT: return "datetime"
    if raw in LONG: return "longtext"
    return "string"

items = get(f"/api/now/table/sc_cat_item?sysparm_query=active=true&sysparm_fields=sys_id,name&sysparm_limit={N}")["result"]

ft_counter = collections.Counter()
ft_to_widget = {}
ft_has_choices = collections.defaultdict(lambda: {"with": 0, "without": 0})
errors = 0
items_ok = 0
for it in items:
    try:
        full = get(f"/api/sn_sc/servicecatalog/items/{it['sys_id']}")
    except Exception:
        errors += 1
        continue
    items_ok += 1
    for v in full["result"].get("variables", []):
        ft = (v.get("friendly_type") or v.get("display_type") or f"type_{v.get('type')}")
        ft_counter[ft] += 1
        ft_to_widget[ft] = classify(ft)
        # does the var carry selectable options?
        has = bool(v.get("choices")) or bool(v.get("lookup")) or v.get("type") in (5,8,18,21,24)
        ft_has_choices[ft]["with" if has else "without"] += 1

print(f"Surveyed {items_ok}/{len(items)} items ({errors} fetch errors)\n")
print(f"{'friendly_type':<26}{'count':>6}  {'-> widget':<10} {'choices(with/without)':<22} flag")
print("-"*92)
GAP_NOTE = {
    "list_collector": "MULTI-SELECT REFERENCE -> falls to plain string (no multi-pick)",
    "attachment": "FILE UPLOAD -> falls to string (cannot attach)",
    "masked": "PASSWORD -> renders as plaintext string",
}
for ft, c in ft_counter.most_common():
    w = ft_to_widget[ft]
    ch = ft_has_choices[ft]
    flag = ""
    if ft in GAP_NOTE:
        flag = "** " + GAP_NOTE[ft]
    elif w == "string" and ch["with"] > 0:
        flag = "ok (string+choices = dropdown)"
    elif w == "string":
        flag = "string text box"
    print(f"{ft:<26}{c:>6}  {w:<10} {str(ch['with'])+'/'+str(ch['without']):<22} {flag}")
