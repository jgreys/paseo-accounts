# Security

## Reporting a problem

Please report security problems privately through GitHub: **Security → Report a vulnerability** on [jgreys/paseo-accounts](https://github.com/jgreys/paseo-accounts/security/advisories/new). Don't open a public issue for them. You'll get an answer within a week.

## What the plugin can reach

Paseo plugins run unsandboxed, with the daemon user's access to files, processes, credentials and the network. Paseo Accounts uses that access for:

- **Sign-ins.** It runs each provider's own CLI to sign in and out (`claude auth login`, `codex login`, `kimi login`, …) and keeps each added account's login in that CLI's usual store, under `$PASEO_HOME/paseo-accounts/homes/`.
- **Usage.** It reads an account's access token only to ask that same provider for the account's usage, and never logs, copies or sends it anywhere else.
- **Banked resets.** It calls the provider's reset endpoint only after you confirm, or when you turned on automatic use.
- **Local state.** Account names, emails, plans, which agent uses which account, usage readings and the switch log, all under `$PASEO_HOME/paseo-accounts/`.
- **Alerts.** Off until you enter a URL. They then POST a short text (which can name an account) to that URL.

It never downloads or installs programs, and never sends prompts or code to a model on its own. The one exception is the optional "continue" message after a switch, which you can turn off.
