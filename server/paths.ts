import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function paseoHome(): string {
  const configured = process.env.PASEO_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), ".paseo");
}

/** Everything the plugin writes lives here: its registry and the per-account credential homes. */
export function dataDir(): string {
  return join(paseoHome(), "paseo-accounts");
}

export function statePath(): string {
  return join(dataDir(), "state.json");
}

export function homesDir(): string {
  return join(dataDir(), "homes");
}

/** The config directory the Claude CLI uses when `CLAUDE_CONFIG_DIR` is not set. */
export function mainClaudeDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), ".claude");
}

/** Claude keeps its global config beside the config directory unless `CLAUDE_CONFIG_DIR` is set. */
export function mainClaudeGlobalConfig(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? join(resolve(configured), ".claude.json") : join(homedir(), ".claude.json");
}

export function mainKimiHome(): string {
  const configured = process.env.KIMI_CODE_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), ".kimi-code");
}

/** OpenCode's data folder (`auth.json`, `opencode.db`), under `XDG_DATA_HOME` when set. */
export function mainOpenCodeData(): string {
  const configured = process.env.XDG_DATA_HOME?.trim();
  return join(configured ? resolve(configured) : join(homedir(), ".local", "share"), "opencode");
}

/** Copilot CLI's config and state folder. */
export function mainCopilotHome(): string {
  const configured = process.env.COPILOT_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), ".copilot");
}

/** Pi's agent folder (`auth.json`, settings, sessions). */
export function mainPiDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), ".pi", "agent");
}

export function mainCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), ".codex");
}
