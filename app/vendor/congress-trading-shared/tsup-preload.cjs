const Module = require('module');
const path = require('path');

// Ensure that child processes and worker threads spawned by tsup also preload this file
const preloadPath = path.resolve(__dirname, 'tsup-preload.cjs');
if (!process.env.NODE_OPTIONS || !process.env.NODE_OPTIONS.includes(preloadPath)) {
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '') + ` --require "${preloadPath}"`;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'typescript') {
    try {
      return origResolve.call(this, 'typescript-v5', parent, isMain, options);
    } catch (e) {
      // Fallback
    }
  }
  return origResolve.call(this, request, parent, isMain, options);
};
