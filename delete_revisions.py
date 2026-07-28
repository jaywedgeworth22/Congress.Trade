import urllib.request
import json
import os

token = "***REMOVED***"
app_id = "14ccfb84-7722-4ee3-99d9-c72565b07335"

req = urllib.request.Request(f"https://api.deno.com/v2/apps/{app_id}/revisions?limit=100")
req.add_header("Authorization", f"Bearer {token}")

response = urllib.request.urlopen(req)
revisions = json.loads(response.read())

deleted_count = 0
for rev in revisions:
    rev_id = rev["id"]
    if rev.get("deleted_at") is not None:
        continue
        
    req2 = urllib.request.Request(f"https://api.deno.com/v2/revisions/{rev_id}")
    req2.add_header("Authorization", f"Bearer {token}")
    try:
        rev_details = json.loads(urllib.request.urlopen(req2).read())
    except Exception as e:
        continue

    is_production = False
    if "timelines" in rev_details:
        for t in rev_details["timelines"]:
            if t["name"] == "Production" and len(t["hostnames"]) > 0:
                is_production = True
                break

    if not is_production:
        print(f"Deleting revision {rev_id}")
        del_req = urllib.request.Request(f"https://api.deno.com/v2/revisions/{rev_id}", method="DELETE")
        del_req.add_header("Authorization", f"Bearer {token}")
        try:
            urllib.request.urlopen(del_req)
            deleted_count += 1
        except Exception as e:
            print(f"Failed to delete {rev_id}: {e}")

print(f"Successfully deleted {deleted_count} preview revisions.")
