const fs = require('fs');
const child_process = require('child_process');

let content = fs.readFileSync('app/src/ui/assets.ts', 'utf8');

// Find EAGLE_SPLASH_PNG_B64
const regex = /const EAGLE_SPLASH_PNG_B64 = '(.*?)';/s;
const match = content.match(regex);
if (!match) {
    console.log("Could not find EAGLE_SPLASH_PNG_B64");
    process.exit(1);
}

const base64Str = match[1];
const buffer = Buffer.from(base64Str, 'base64');
fs.writeFileSync('eagle.png', buffer);

console.log("Extracted eagle.png");
