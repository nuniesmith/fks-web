// Test-only stand-in for SvelteKit's `$env/dynamic/private` (aliased in
// vitest.config.ts). At runtime SvelteKit backs that module with the live
// process environment; unit tests do the same so a test can set the relevant
// vars (e.g. INTERNAL_TOKEN) before dynamically importing the module under test.
export const env: Record<string, string | undefined> = process.env;
