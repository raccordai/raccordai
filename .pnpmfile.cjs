// typescript-eslint consumes the TypeScript JS compiler API, which the
// native TypeScript 7 package no longer ships (the stable programmatic API
// lands in 7.1). Give the lint toolchain its own TypeScript 5.x, isolated by
// pnpm — the project's `tsc` (typecheck) stays on TypeScript 7.
function readPackage(pkg) {
  const needsJsApi =
    pkg.name === 'typescript-eslint' || (pkg.name || '').startsWith('@typescript-eslint/')
  if (needsJsApi && pkg.peerDependencies && pkg.peerDependencies.typescript) {
    delete pkg.peerDependencies.typescript
    pkg.dependencies = { ...pkg.dependencies, typescript: '~5.9.0' }
  }
  return pkg
}

module.exports = { hooks: { readPackage } }
