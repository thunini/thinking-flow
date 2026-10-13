# Privacy

thinking-flow is a Claude Code mod. It runs inside your Claude Code session on your own machine. Its author runs no server and receives no data from it.

## What it reads

While a session runs, the mod reads what the session shows: your messages, the thinking summaries Claude Code displays, the tool calls Claude makes with a short target for each (a file name, a command, a web address or a search), and Claude's answers. Any personal data you type into the session can appear in that record.

## What it sends

When an answer ends, the mod sends at most one request to Anthropic's Haiku model through Claude Code's own model access, on the account your session already uses. The request holds a shortened copy of that record, as the README describes under "What it sends, and what it costs". Anthropic handles it under the same terms as the rest of your Claude Code session. The mod contacts no other service.

To send nothing at all, set **Step wording** to `rules`. The mod then makes no model calls.

## What it keeps

The record lives in the session's memory and ends with the session. The mod writes no files, keeps no logs and stores nothing between sessions.

## People under 18

The mod is not intended for people under 18.

## Contact

For questions about this policy, open an issue at https://github.com/thunini/thinking-flow/issues.

Last updated: 2026-10-13
