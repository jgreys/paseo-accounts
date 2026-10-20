import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { paseoHome } from "./paths";

/**
 * Reopens an agent's provider session so it picks up a new account.
 *
 * The plugin SDK has no session reopen (`agents.ref(id).refresh()` only refetches data), so this
 * uses the bundled CLI's `paseo agent reload`, which the daemon implements as close + reopen with
 * the current configuration. The CLI connects on its own; on a password-protected daemon it cannot,
 * and the switch then applies the next time the session opens.
 */
type ReopenResult = { ok: true } | { ok: false; error: string; timedOut: boolean };
type RunReload = (cli: string, agentId: string) => Promise<ReopenResult>;

/** Paseo gives up waiting for the old Claude process to exit; a moment later the same reload works. */
const CLOSE_TIMEOUT = /Timed out closing previous session/i;
const RETRY_DELAYS_MS = [3_000, 10_000];

export class Reopener {
  private cli: { at: number; path: Promise<string | null> } | null = null;

  constructor(
    private readonly run: RunReload = runReload,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Path to the CLI, or null when none can be found (looked for again every few minutes). */
  async locate(): Promise<string | null> {
    if (this.cli && (Date.now() - this.cli.at < 5 * 60_000 || (await this.cli.path) !== null)) return this.cli.path;
    this.cli = { at: Date.now(), path: findCli() };
    return this.cli.path;
  }

  /** `timedOut`: the command was stopped before the daemon answered, so the reload may still finish. */
  async reopen(agentId: string): Promise<ReopenResult> {
    const cli = await this.locate();
    if (!cli) return { ok: false, error: "The paseo command-line tool was not found on the daemon machine.", timedOut: false };
    let result = await this.run(cli, agentId);
    for (const ms of RETRY_DELAYS_MS) {
      if (result.ok || !CLOSE_TIMEOUT.test(result.error)) break;
      console.warn(`[paseo-accounts] reload of ${agentId} timed out closing the old session; retrying in ${ms / 1000}s`);
      await this.wait(ms);
      result = await this.run(cli, agentId);
    }
    return result;
  }
}

function runReload(cli: string, agentId: string): Promise<ReopenResult> {
  return new Promise((resolve) => {
    execFile(
      cli,
      ["agent", "reload", agentId, "--json", "--home", paseoHome()],
      { timeout: 90_000, maxBuffer: 1024 * 1024, env: process.env },
      (error, _stdout, stderr) => {
        if (!error) return resolve({ ok: true });
        const detail = `${stderr || error.message}`.trim().split("\n").slice(-3).join(" ");
        resolve({ ok: false, error: explainFailure(detail), timedOut: error.killed === true });
      },
    );
  });
}

function explainFailure(detail: string): string {
  if (/transport closed|cannot connect|cannot reach|password|unauthori[sz]ed|DAEMON_NOT_RUNNING/i.test(detail)) {
    return "Paseo's CLI could not connect to this daemon (it may require a password). The agent switches accounts the next time its session starts.";
  }
  return detail || "Reload failed.";
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findCli(exec: string = process.execPath): Promise<string | null> {
  const candidates: string[] = [];
  const executable = process.platform === "win32" ? "paseo.cmd" : "paseo";

  // The daemon (and this subprocess) usually run inside the desktop app bundle, which ships the CLI.
  const appContents = exec.match(/^(.*?\.app\/Contents)\//)?.[1];
  if (appContents) candidates.push(join(appContents, "Resources", "bin", "paseo"));
  const resources = findAncestor(exec, "resources");
  if (resources) candidates.push(join(resources, "bin", executable));
  // The Windows desktop app keeps `resources/` beside Paseo.exe, not above it.
  candidates.push(join(dirname(exec), "resources", "bin", executable));

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory) candidates.push(join(directory, executable));
  }

  if (process.platform === "darwin") {
    candidates.push("/Applications/Paseo.app/Contents/Resources/bin/paseo");
    candidates.push(join(homedir(), "Applications", "Paseo.app", "Contents", "Resources", "bin", "paseo"));
  }
  candidates.push(join(homedir(), ".local", "bin", executable));

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function findAncestor(path: string, name: string): string | null {
  let current = dirname(path);
  for (let depth = 0; depth < 6; depth += 1) {
    if (current.toLowerCase().endsWith(`/${name}`) || current.toLowerCase().endsWith(`\\${name}`)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
