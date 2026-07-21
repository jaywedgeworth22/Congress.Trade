const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(function(file) {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else {
      if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.mts')) {
        results.push(file);
      }
    }
  });
  return results;
}

const files = walk('app/src');
files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  let newContent = content.replace(/['"]@jaywedgeworth22\/congress-trading-shared['"]/g, (match, offset) => {
      let depth = file.split('/').length - 2; // app/src is depth 0. file in app/src/admin is depth 1.
      // app/src/admin/routes.ts -> depth 2. Wait: split('/') gives ['app', 'src', 'admin', 'routes.ts'] (length 4).
      // depth = 4 - 2 = 2. So we need '../../vendor'.
      // If length is 3 (app/src/index.ts), depth = 1 -> '../vendor'.
      let dots = Array(depth).fill('..').join('/');
      return `'${dots}/vendor/congress-trading-shared/dist/index.mjs'`;
  });
  if (content !== newContent) {
    fs.writeFileSync(file, newContent);
    console.log(`Updated ${file}`);
  }
});
