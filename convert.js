const fs = require('fs');
let text = fs.readFileSync('app/src/ui/assets.ts', 'utf8');

// Find EAGLE_SPLASH_PNG_B64
const startIndex = text.indexOf('const EAGLE_SPLASH_PNG_B64 =');
if (startIndex !== -1) {
    const endStr = ';\n';
    const semiIndex = text.indexOf(endStr, startIndex);
    if (semiIndex !== -1) {
        let block = text.substring(startIndex, semiIndex);
        // Extract content between quotes (single, double, or backticks)
        const match = block.match(/['"`](.*?)['"`]/s);
        if (match) {
            fs.writeFileSync('eagle.png', Buffer.from(match[1].replace(/\s/g, ''), 'base64'));
            console.log("Wrote eagle.png");
        }
    }
}
