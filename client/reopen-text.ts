import type { ReopenSummary } from "../shared/rpc";

export function describeReopen(prefix: string, summary: ReopenSummary): string {
  const parts = [prefix];
  if (summary.continuedIn) parts.push(`continuing in “${summary.continuedIn.title}”`);
  if (summary.reopened.length > 0) parts.push(`${summary.reopened.length} agent(s) switched`);
  if (summary.deferred.length > 0) parts.push(`${summary.deferred.length} will switch after their current turn`);
  if (summary.failed.length > 0) parts.push(`${summary.failed.length} will switch on their next restart`);
  return parts.join(" · ");
}
