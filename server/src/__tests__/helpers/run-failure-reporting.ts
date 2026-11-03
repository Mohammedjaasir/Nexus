import { afterEach, beforeEach } from "vitest";

export function enableRunFailureReporting(): void {
  let previousMode: string | undefined;
  beforeEach(() => {
    previousMode = process.env.NEXUS_SENTRY_RUN_FAILURES;
    process.env.NEXUS_SENTRY_RUN_FAILURES = "unexpected";
  });
  afterEach(() => {
    if (previousMode === undefined) delete process.env.NEXUS_SENTRY_RUN_FAILURES;
    else process.env.NEXUS_SENTRY_RUN_FAILURES = previousMode;
  });
}
