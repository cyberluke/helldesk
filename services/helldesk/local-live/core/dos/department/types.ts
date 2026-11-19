/**
 * Shared types for Department DO operations.
 */

export type FailureReason = {
  /** Machine-readable failure code. */
  code: string;
  /** Human-readable summary of what went wrong. */
  message: string;
  /** Optional detail: stack trace, error output, container logs, etc. */
  details?: string;
  /** What triggered the failure: 'scheduler' | 'attendance' | 'qualityAssurance' | 'triage' | 'admin' | 'container' */
  source: string;
};
