/** Local HELLDESK — analytics util shim. No ANA transport locally. */
export interface HelldeskEventData {
  [key: string]: unknown;
}
export async function writeEvent(_pipeline: unknown, _event: Record<string, unknown>): Promise<void> {
  // No-op: no analytics ingest locally.
}