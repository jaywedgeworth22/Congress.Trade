import subprocess
import time

def check_ci(pr):
    result = subprocess.run(['gh', 'pr', 'checks', str(pr)], capture_output=True, text=True)
    if result.returncode == 0:
        return 'pass'
    elif 'pending' in result.stdout or 'in progress' in result.stdout:
        return 'pending'
    else:
        return 'fail'

prs = [959, 958, 925]
for pr in prs:
    print(f"Waiting for PR {pr}...")
    while True:
        status = check_ci(pr)
        if status == 'pass':
            print(f"PR {pr} passed CI, merging...")
            res = subprocess.run(['gh', 'pr', 'merge', str(pr), '--squash', '--delete-branch'], capture_output=True, text=True)
            if res.returncode == 0 or "already merged" in res.stderr:
                print(f"PR {pr} merged.")
            else:
                print(f"Failed to merge PR {pr}: {res.stderr}")
            break
        elif status == 'fail':
            print(f"PR {pr} failed CI!")
            break
        time.sleep(10)

print("Finished checking and merging PRs.")
