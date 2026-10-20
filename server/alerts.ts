/**
 * Posts an alert as a plain-text body with a `Title` header: the shape ntfy expects, and readable
 * by any webhook that takes text. ntfy shows it as a push notification on your phone.
 */
export async function sendAlert(url: string, title: string, message: string): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Title: asciiHeader(`paseo-accounts: ${title}`), Tags: "warning", "Content-Type": "text/plain; charset=utf-8" },
    body: message,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
}

/** HTTP headers must be ASCII; account names may not be. */
function asciiHeader(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?");
}
