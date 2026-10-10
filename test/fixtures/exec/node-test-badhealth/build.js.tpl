'use strict';
// A deterministic build: dist/index.html and dist/app.js.
const fs = require('node:fs');
const path = require('node:path');
const { route } = require('./src/handler');
const out = path.join(__dirname, 'dist');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), route('/').body + '\n');
fs.writeFileSync(path.join(out, 'app.js'), "'use strict';\nconsole.log('node-test-app build');\n");
console.log('built dist/index.html and dist/app.js');
