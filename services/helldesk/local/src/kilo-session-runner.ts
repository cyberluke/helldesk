import type { ReviewPrompt, RunResult } from './inference';

/**
 * Kilo SDK session runner.
 *
 * Ported from the historical helldesk `process-manager.ts` SDK lifecycle but
 * with every hardcoded `providerID: 'kilo'`, `KILOCODE_TOKEN`, and Kilo
 * Gateway assumption removed. Reviewer sessions are distinct sessions with
 * their own role instructions, explicit `{providerID, modelID}` and a
 * restricted tool allowlist. The active developer session is never touched.
 *
 * Two delivery paths:
 *  - The VS Code plugin runs *inside* the running Kilo server and uses its
 *    in-process `client` (the most faithful "real Kilo SDK" integration).
 *  - The standalone daemon / CLI path boots a headless `createKilo()` server
 *    (or an OpenAI-compatible endpoint) to run a reviewer without VS Code.
 */

export interface SessionFactory {
  /** Run a single-turn reviewer prompt in a NEW distinct session. */
  runReview(prompt: ReviewPrompt): Promise<RunResult>;
  readonly kind: 'kilo';
}