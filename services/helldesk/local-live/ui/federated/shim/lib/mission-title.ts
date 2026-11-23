/**
 * Shared mission-title helper for the federated pages.
 *
 * The canonical implementation lives in the local operator console
 * (`ui/src/lib/mission-title.ts`) so the local header and the federated pages
 * name a mission the same way. This shim makes it available under the
 * `@/lib/mission-title` alias used by verbatim federated code.
 */
export * from '../../../src/lib/mission-title';
