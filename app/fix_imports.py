import os, glob

files = glob.glob('src/**/*.ts', recursive=True)

for file in files:
    with open(file, 'r') as f:
        content = f.read()
    
    if 'fmpDisclosureLatency' in content:
        content = content.replace('fmpDisclosureLatency', 'tradeLatency')
        # We also need to fix recordDisclosureLatencyCandidate to recordTradeLatencyCandidates
        # However, the signature is different now. It accepts transactions instead of DiscoveredFiling.
        # Let's just fix the import string first.
        
    with open(file, 'w') as f:
        f.write(content)
