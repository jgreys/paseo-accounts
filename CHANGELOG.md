# Changelog

## 1.1.0 - 2026-11-01

- **Select** in the Agents tab moves several agents to another account at once. Agents that can't move are listed with the reason.
- Claude Max 20x accounts show as **Ultra**, Anthropic's new name for the plan. Verified Ultra accounts have no 5-hour limit in Claude Code, so only their weekly limits show.
- The Accounts screen refreshes when you open it, switch host or tab, and when the app comes back to the foreground.
- Your accounts show up in Paseo's own Usage view (Paseo 0.12 and later), from the last reading, so opening it costs no provider request. Agents of Kimi Code and the other providers show the account they really run on.
- `paseo run --env PASEO_ACCOUNT=Work …` starts an agent on a named account (name or id, any case). An unknown name is logged and the agent is routed as usual.
- Claude's paid extra usage shows on the account card ("Extra usage · $38.00 of $50.00 left"). A new setting, **Use Claude's paid extra usage when every account is out** (off by default), keeps such an account usable after the others are full, until its budget runs out.
- Tests run on every push (GitHub Actions). Added `SECURITY.md` and `TESTING.md`, which says what was tested on real accounts and what wasn't. The npm package is `@jgreys/paseo-accounts`.

## 1.0.4 - 2026-10-21

- Every Claude and ChatGPT account can be signed out (**Sign out**) without removing it; **Sign in** brings it back. Added accounts can still be removed.

## 1.0.3 - 2026-10-21

- The Claude and ChatGPT CLI logins can be signed out from their account card (**Sign out**), then signed in again with the same or another account.

## 1.0.2 - 2026-10-21

- The sidebar's Accounts item shows a badge with the number of signed-out accounts on the Accounts screen (Paseo 0.12 and later).
- The overview explains how ChatGPT conversations continue on another account.

## 1.0.1 - 2026-10-20

- Expanded the overview: required CLIs, first-account setup, what the plugin accesses and what it sends.

## 1.0.0 - 2026-10-20

First public release.

- Accounts for Claude, ChatGPT (Codex), GitHub Copilot, Kimi Code, OpenCode Go, Pi and Oh My Pi, added from the app on any device.
- Automatic failover at the limit, early switching before it, and pacing across accounts.
- Live usage, 7-day history and run-out forecast for every account.
- Account per agent, per project folder, with priorities.
- Fork a stopped chat to another provider when every account is out.
- Banked limit resets, alerts by ntfy or webhook, and an activity log of every switch.
- Works on the Paseo desktop, web and mobile apps.
