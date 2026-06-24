---
name: playwright
description: Browser automation via Playwright MCP. Navigate, click, fill forms, take screenshots, and inspect pages. Use when user wants to test UI flows, scrape content, reproduce browser bugs, or automate web interactions. Playwright MCP is already wired in this project via .mcp.json.
trigger: /playwright
allowed-tools: mcp__playwright__browser_navigate mcp__playwright__browser_snapshot mcp__playwright__browser_click mcp__playwright__browser_fill_form mcp__playwright__browser_take_screenshot mcp__playwright__browser_type mcp__playwright__browser_press_key mcp__playwright__browser_select_option mcp__playwright__browser_evaluate mcp__playwright__browser_console_messages mcp__playwright__browser_network_requests mcp__playwright__browser_wait_for mcp__playwright__browser_hover mcp__playwright__browser_tabs mcp__playwright__browser_close Bash Read Write
---

# /playwright

Automate browsers via Playwright MCP. Uses accessibility tree (no vision model needed).

## Usage

```
/playwright <url>                    # open URL, snapshot, report what's on page
/playwright test <url> <flow>        # walk through a user flow and report issues
/playwright screenshot <url>         # navigate and take screenshot
/playwright fill <url> <form-desc>   # fill and submit a form
/playwright debug <url> <issue>      # reproduce a reported UI bug
/playwright scrape <url> <data>      # extract structured data from page
```

## Steps

1. Navigate to URL via `mcp__playwright__browser_navigate`
2. Snapshot page via `mcp__playwright__browser_snapshot` to understand structure
3. Interact using `browser_click`, `browser_fill_form`, `browser_type`, `browser_select_option`
4. Verify with `browser_snapshot` after each action
5. Take screenshot with `browser_take_screenshot` if user needs visual confirmation
6. Check console errors via `browser_console_messages`
7. Check network calls via `browser_network_requests`

## When to invoke

- User asks to test a UI flow or golden path
- User wants to reproduce a browser bug
- User wants to scrape/extract data from a page
- User wants to verify a feature works in the browser after deploying
- Waahyu apps run on ports 3000–3003 (use `localhost:<port>`)

## Notes

- MCP server wired via `.mcp.json` in this repo — no setup needed
- Uses accessibility snapshots, not screenshots, for interaction (token efficient)
- NOT for CI batch runs — use Playwright CLI for that
- For Waahyu app ports: admin=3000, consumer=3001, merchant=3002, driver=3003
