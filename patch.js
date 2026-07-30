const fs = require('fs');
let text = fs.readFileSync('.github/workflows/deploy-oracle.yml', 'utf8');
text = text.replace(/actions\/setup-node@v4/, 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4');
fs.writeFileSync('.github/workflows/deploy-oracle.yml', text);
