/**
 * The one error type the platform services throw. `code` is the stable,
 * machine-readable reason; `message` is for logs and must not carry secrets.
 */
import type { PlatformErrorCode } from '../../shared/nexus/platform';

export class PlatformError extends Error {
  constructor(readonly code: PlatformErrorCode, message: string, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = 'PlatformError';
  }
}
