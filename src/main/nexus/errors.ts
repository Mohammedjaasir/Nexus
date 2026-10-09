/**
 * The one error type the platform services throw. `code` is the stable,
 * machine-readable reason; `message` is for logs and must not carry secrets.
 *
 * `unavailable` (B2a Task 9) is a main-side code: an action that cannot run on this machine now, with a `setup:*`
 * or product reason in `detail.reason` (image preparation below the disk gate, a dev deployment that needs secrets).
 * It is not a PlatformErrorCode of the shared IPC contract yet: the IPC layer (B2a Task 13) adds it with its copy.
 */
import type { PlatformErrorCode } from '../../shared/nexus/platform';

export type MainErrorCode = PlatformErrorCode | 'unavailable';

export class PlatformError extends Error {
  constructor(readonly code: MainErrorCode, message: string, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = 'PlatformError';
  }
}
