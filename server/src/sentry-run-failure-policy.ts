export type RunFailureReportingMode = "off" | "unexpected" | "all";

export function readRunFailureReportingMode(): RunFailureReportingMode {
  const value = process.env.NEXUS_SENTRY_RUN_FAILURES?.trim();
  return value === "unexpected" || value === "all" ? value : "off";
}
