# Driving the desktop: computer-use setup per agent

Principle: **accessibility tree (UIA) first, vision second.** UIA selectors are fast,
precise and reproducible (and give the exact element rectangle for Recordly AI zooms);
screenshots + vision are the fallback for canvas UIs, games, some Electron apps.

| Need | Best tool |
|---|---|
| Deterministic replay of a demo script | `scripts/demo_runner.py` (pywinauto UIA backend) |
| Exploring an unknown UI, recovering from surprises | Windows-MCP or cua-driver (MCP) |
| Browser parts | Playwright on a **headed** Chrome/Edge (so the recorder sees it) |
| Pixel fallback | the agent's own vision on `recordly_ai.py screenshot` or MCP snapshots |

## Claude Code (Windows)
Claude Code's built-in computer use is macOS-only; on Windows add an MCP server:
```
claude mcp add windows-mcp -- uvx windows-mcp serve        # UIA tree, click/type/shortcut, WaitFor (Python 3.13+)
# or background control that does not steal your cursor:
irm https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1 | iex
claude mcp add --transport stdio cua-driver -- cua-driver mcp
claude mcp add playwright -- npx @playwright/mcp@latest    # browser steps
```
For demos prefer **visible** cursor movement (Windows-MCP / pywinauto `click_input`): viewers
must see what is clicked. cua-driver's background input does not move the real cursor.

## Hermes Agent (Nous Research)
Built-in `computer_use` toolset (cua-driver, UIA on Windows): enable with
`hermes -t computer_use chat` or add it to `toolsets` in `~/.hermes/config.yaml`; check with
`hermes computer-use doctor`. Actions: `capture` (som/ax), `click` (element index or x,y),
`type`, `key`, `scroll`, `drag`. Browser tools: `browser_navigate`, `browser_snapshot`, … .
Run the scripts of this skill through the `terminal` tool.

## OpenAI Codex CLI
Use Windows-MCP or cua-driver as MCP servers (`[mcp_servers.windows-mcp]` in
`~/.codex/config.toml`, command `uvx`, args `["windows-mcp", "serve"]`), Playwright MCP for
browsers. Codex desktop's Computer Use plugin takes over the foreground — fine for demos.

## Gemini CLI
Add MCP servers in `~/.gemini/settings.json` (`"mcpServers": {"windows-mcp": {"command":
"uvx", "args": ["windows-mcp", "serve"]}}`); scripts run via `run_shell_command`.

## pywinauto cheat sheet (used by demo_runner)
```python
from pywinauto import Desktop
win = Desktop(backend="uia").window(title_re="MyApp")
win.print_control_identifiers(depth=4)          # discover names / control types / automation ids
btn = win.child_window(title="Genera", control_type="Button")
btn.rectangle()                                  # physical pixels → recordly_ai.py zoom --screen-rect
btn.click_input()
```

## Pitfalls
- **Integrity levels**: a non-elevated agent cannot drive an elevated window (UIPI). Run the
  target app, Recordly AI and the agent at the same level.
- **DPI**: UIA rectangles are physical pixels (Recordly AI default). With `--dip` pass DIPs.
- **Session 0 / RDP minimized**: needs a real interactive desktop.
- **Notifications** pop over the recording: enable Focus Assist / Do Not Disturb.
- **Secrets**: log in before recording; blur any token or email still visible
  (`recordly_ai.py blur --screen-rect …`).
