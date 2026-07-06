import sys

file_path = "app/src/delivery/webhook.ts"
with open(file_path, "r") as f:
    content = f.read()

target1 = """  const attempt = msg.attempt ?? 1;

  for (const sub of subs) {
    if (!sub.targetUrl) continue;
    if (!matchesFiltersWithContext(tx, sub.filters, ctx)) continue;
    await deliverToSubscription(env, sub, tx, attempt);
  }
}"""

replacement1 = """  const attempt = msg.attempt ?? 1;

  const deliverPromises: Promise<void>[] = [];
  for (const sub of subs) {
    if (!sub.targetUrl) continue;
    if (!matchesFiltersWithContext(tx, sub.filters, ctx)) continue;
    deliverPromises.push(deliverToSubscription(env, sub, tx, attempt));
  }
  await Promise.all(deliverPromises);
}"""

import re
target2_pattern = re.compile(
    r"(try\s*\{\s*await env\.DELIVERY_QUEUE\.send\(retryMsg, \{ delaySeconds \}\);\s*\} catch \(err\) \{\s*console\.error\('dispatchWebhook: failed to enqueue retry', \(err as Error\)\.message\);\s*)(\})(\s*\} else \{\s*console\.warn\([\s\S]*?\);\s*)(\})",
    re.MULTILINE
)

replacement2 = r"\1\n      throw err;\n    \2\3\n    throw new Error(`dispatchWebhook: max attempts reached for sub=${sub.id} tx=${tx.id}: ${lastError}`);\n  \4"

if target1 not in content:
    print("target1 not found")
    sys.exit(1)
if not target2_pattern.search(content):
    print("target2 not found")
    sys.exit(1)

content = content.replace(target1, replacement1)
content = target2_pattern.sub(replacement2, content)

with open(file_path, "w") as f:
    f.write(content)
print("Updated webhook.ts")
