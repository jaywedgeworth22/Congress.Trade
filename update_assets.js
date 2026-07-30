const fs = require('fs');

const webpBuffer = fs.readFileSync('eagle.webp');
const webpBase64 = webpBuffer.toString('base64');
const formattedBase64 = webpBase64.match(/.{1,120}/g).join('\n  ');

let text = fs.readFileSync('app/src/ui/assets.ts', 'utf8');

const startIndex = text.indexOf('const EAGLE_SPLASH_PNG_B64 =');
const endStr = ';\n';
const semiIndex = text.indexOf(endStr, startIndex);

if (startIndex !== -1 && semiIndex !== -1) {
    const before = text.substring(0, startIndex);
    const after = text.substring(semiIndex);
    const replacement = `const EAGLE_SPLASH_PNG_B64 =\n  \`${formattedBase64}\``;
    fs.writeFileSync('app/src/ui/assets.ts', before + replacement + after);
    console.log("Updated EAGLE_SPLASH_PNG_B64 with WebP");
}
