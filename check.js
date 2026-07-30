const fs = require('fs');
let text = fs.readFileSync('app/src/ui/assets.ts', 'utf8');

const regex = /const ([A-Z0-9_]+) = ['"`](.*?)['"`]/sg;
let match;
while ((match = regex.exec(text)) !== null) {
    if (match[2].length > 1000) {
        console.log(match[1] + ": " + match[2].length);
    }
}
