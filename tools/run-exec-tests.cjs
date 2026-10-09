'use strict';
// `npm run test:exec` (B2a): the real-Docker execution suite behind the resource preflight. The suite and its
// preflight arrive with B2a Task 12; until then this reports NOT RUN with its reason and the distinct exit code 3,
// never a silent pass.
console.log('[test:exec] NOT RUN: suite not built yet');
process.exit(3);
