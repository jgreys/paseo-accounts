# Paseo Accounts

Run Claude Code, Codex and other agents on several of your own subscriptions at once, and keep working when one hits its usage limit.

- **Add accounts in the app.** Sign in from any device, your phone included. No terminal, environment variables or config files.
- **Automatic failover.** When an account hits its 5-hour or weekly limit, the agent moves to the account with the most room left and carries on where it stopped.
- **Switch before the limit.** Agents move off a nearly full account between turns, so long tasks don't get cut in the middle.
- **Live usage and forecasts.** See every account's 5-hour, weekly and monthly usage, when it resets, and when it will run out at the current pace.
- **One account per agent or per project.** Pick an account from the composer, or dedicate an account to a folder.
- **Seven providers.** Claude, ChatGPT (Codex), GitHub Copilot, Kimi Code, OpenCode Go, Pi and Oh My Pi.
- **Fork to another provider (optional).** When every account of a provider is out, the chat can carry on with another provider, with the conversation so far.
- **Alerts (optional).** Get an ntfy or webhook message when accounts run out or need attention.

## Requirements

- Paseo 0.11.0 or later, with plugins enabled.
- The CLI of each provider you want accounts for, installed on the daemon host: `claude` for Claude, `codex` for ChatGPT, and `copilot`, `kimi`, `opencode`, `pi` or `omp` for the others. These are the same CLIs Paseo already uses to run agents. The plugin never downloads or installs them.

## First account

1. Open **Accounts** in the sidebar. The logins your CLIs already have show up as your first accounts, so nothing changes until you add another one.
2. Click **Add account**, pick the provider and sign in with the other account. The plugin runs the provider's own login (for example `claude auth login` or `codex login`) and shows the link and code, so you can finish on any device.
3. Choose a default account, or pick one per agent from the account button in the message box.

## What it accesses

- **Sign-ins stay where the CLIs keep them.** Each added account gets its own CLI config folder under `$PASEO_HOME/paseo-accounts/homes/`, and its login lives in that CLI's usual store (the macOS keychain or the CLI's own credentials file). Your settings, skills, MCP servers and conversation history are shared with your main login through links.
- **Usage readings.** To show usage, the plugin reads each account's sign-in and asks that provider only: Claude through Anthropic's usage endpoint, Kimi through its usage API, Codex through the installed Codex CLI. Tokens are never logged, stored elsewhere or sent anywhere else.
- **Local files.** The plugin keeps a small registry (account names, emails, plans and which agent uses which account), 8 days of usage readings and a switch log in `$PASEO_HOME/paseo-accounts/`.
- **Removing an account** signs it out with the provider's CLI and deletes its folder, after you confirm. Shared files are unlinked first and never deleted.

## What it sends, and when

- **Switching accounts** within a provider sends nothing new: the agent reopens on the other account with its own history. A short follow-up ("continue") is sent so the interrupted task carries on; you can turn that off.
- **Fork to another provider** is off by default. When on (or when you pick it from an agent's account button), the new agent receives the conversation so far and a summary of recent tool activity. It never gets more permissions than the original agent.
- **Banked resets** are spent only after you confirm, or automatically if you turn that on (off by default).
- **Alerts** are off until you enter an ntfy topic or webhook URL. They send a short plain-text message, which can include an account's name, when every account of a provider is out, an account is signed out, or an agent didn't come back after a switch.
