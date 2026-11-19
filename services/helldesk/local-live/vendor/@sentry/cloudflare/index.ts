/**
 * Local `@sentry/cloudflare` — NO-OP for the local stack.
 *
 * CTO directive: no Sentry locally. `withSentry(config, handlers)` must return
 * the handlers unmodified (shape-compatible with the real SDK) so the federated
 * domain + worker mount compile and run. All capture methods are no-ops.
 */
export interface SentryConfig {
  dsn?: string;
  release?: string;
  tracesSampleRate?: number;
  enabled?: boolean;
  environment?: string;
  appDir?: string;
  runWith?: boolean;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type FetchHandler<E> = {
  fetch(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>;
};

/** Shape-compatible: returns the handler unchanged (Sentry disabled locally). */
export function withSentry<E>(
  _config: SentryConfig | ((env: E) => SentryConfig),
  handlers: FetchHandler<E> & Record<string, unknown>,
): FetchHandler<E> & Record<string, unknown> {
  return handlers;
}

function noop(..._args: unknown[]): void {}

export const captureException: (...args: unknown[]) => void = noop;
export const captureMessage: (...args: unknown[]) => void = noop;
export const captureRequest: (...args: unknown[]) => void = noop;
export const addBreadcrumb: (...args: unknown[]) => void = noop;
export const startSpan: (o: never) => { end: (r?: never) => void } = () => ({ end: () => {} });
export const flush = async (): Promise<boolean> => true;

/** A no-op span returning its input (span-context passthrough). */
export const wrap = <T>(v: T): T => v;

/** Sentry error type used by some call sites. */
export class SentryError extends Error {}

export default {
  withSentry,
  captureException,
  captureMessage,
  captureRequest,
  addBreadcrumb,
  startSpan,
  flush,
  wrap,
  SentryError,
};