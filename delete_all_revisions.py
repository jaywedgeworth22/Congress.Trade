import urllib.request
import json
import os

token = "***REMOVED***"
app_id = "14ccfb84-7722-4ee3-99d9-c72565b07335"

cursor = ""
total_deleted = 0

while True:
    url = f"https://api.deno.com/v2/apps/{app_id}/revisions?limit=100"
    if cursor:
        url += f"&cursor={urllib.parse.quote(cursor)}"
        
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {token}")
    try:
        response = urllib.request.urlopen(req)
        data = json.loads(response.read())
        revisions = data if isinstance(data, list) else data.get("items", data)
        # Note: older api responses might just return a list. If it returns an object with items, we need to extract cursor.
        if isinstance(data, list):
            # Try to grab cursor from response headers or if list, we might not have a cursor.
            next_cursor = None
        else:
            next_cursor = data.get("nextCursor") or data.get("next_cursor")
            
    except Exception as e:
        print(f"Failed to fetch revisions: {e}")
        break

    if not revisions:
        break

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
                total_deleted += 1
            except Exception as e:
                pass
                
    if next_cursor:
        cursor = next_cursor
    else:
        break

print(f"Successfully deleted a total of {total_deleted} preview revisions.")
