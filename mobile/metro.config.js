const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// @supabase/supabase-js ESM build (index.mjs) contains:
//   import(/* webpackIgnore */ OTEL_PKG)
// — a dynamic import with a variable that Hermes cannot compile.
// Disabling package exports forces Metro to use the CJS build (index.cjs)
// which uses require() instead, avoiding the Hermes parse error.
config.resolver.unstable_enablePackageExports = false;

module.exports = config;
