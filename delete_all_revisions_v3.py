import urllib.request
import urllib.parse
import json
import re

token = "ddo_6NiSHTuvWxj9sbqfIVBjbPa0SHxVtN2anc3l"
app_id = "14ccfb84-7722-4ee3-99d9-c72565b07335"

url = f"https://api.deno.com/v2/apps/{app_id}/revisions?limit=100"
total_deleted = 0

while url:
    print(f"Fetching {url}")
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {token}")
    try:
        response = urllib.request.urlopen(req)
        data = json.loads(response.read())
        
        # Parse Link header for next page
        link_header = response.headers.get("Link", "")
        next_url = None
        if link_header:
            match = re.search(r'<([^>]+)>;\s*rel="next"', link_header)
            if match:
                next_url = match.group(1)
                # Ensure the url uses api.deno.com instead of console.deno.com if it's mixed up
                next_url = next_url.replace("console.deno.com/api/v2", "api.deno.com/v2")
                
        url = next_url
        
    except Exception as e:
        print(f"Failed to fetch revisions: {e}")
        break

    for rev in data:
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

print(f"Successfully deleted a total of {total_deleted} preview revisions.")
