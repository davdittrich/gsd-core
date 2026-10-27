'use strict';
/**
 * Preload fixture for #5328 F5: count the loadConfig calls cmdResolveExecution makes for its model
 * baseline: a call made directly from cmdResolveExecution, or from resolveModelInternal called
 * directly from cmdResolveExecution. Calls inside effort, fast-mode, resolveModelForTier and
 * provider-escalation resolution are not counted. Writes the count to GSD_LOAD_COUNT_FILE on exit.
 * Loaded via `node --require <this file> gsd-tools.cjs ...`. One-shot subprocess: no restore.
 */
const fs = require('node:fs');
const loader = require('../../gsd-core/bin/lib/config-loader.cjs');

const real = loader.loadConfig;
let count = 0;
const frameName = (line) => (/^\s*at (?:Object\.)?([\w$]+) /.exec(line || '') || [])[1];
loader.loadConfig = function countingLoadConfig(...args) {
  const frames = new Error().stack.split('\n').slice(2).map(frameName);
  if (frames[0] === 'cmdResolveExecution' || (frames[0] === 'resolveModelInternal' && frames[1] === 'cmdResolveExecution')) count++;
  return real.apply(this, args);
};
process.on('exit', () => fs.writeFileSync(process.env.GSD_LOAD_COUNT_FILE, String(count)));
