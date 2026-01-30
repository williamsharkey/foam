# CLAUDE.md - Guide for AI Assistants Working on Foam

## Project Vision — READ THIS FIRST

The goal is a **fully functional browser-native Linux system where Claude Code (Spirit) runs with no external server**. The nimbus dashboard is just tooling — it could be thrown away. What matters is foam becoming a real development environment: git, npm, node, editors, compilers, and Spirit all working in-browser. **There is always work to do** — if your task is done, find the next missing Linux capability and implement it.

## What is Foam?

Foam is a browser-native cloud OS — a virtual Linux-like terminal powered by Claude, running entirely in the browser with no backend. It's the plain JavaScript sister project to Shiro (which uses TypeScript/Vite). Both share the same shell semantics and can run Spirit (the Claude Code agent).

## Project Structure

```
index.html              # Entry point — loads all modules via ES module imports
style.css               # Terminal styling
src/
├── vfs.js              # Virtual filesystem (IndexedDB-backed, POSIX-like API)
├── terminal.js         # xterm.js integration, line editing, key handling
├── shell.js            # Command parser: pipes, redirects, env vars, quoting
├── commands.js         # All built-in commands (ls, cat, mkdir, grep, git, etc.)
├── claude.js           # Claude/Spirit AI agent integration
├── devtools.js         # Browser devtools integration
├── fluffy-bridge.js    # Bridge to fluffycoreutils shared library
└── foam-provider.js    # OSProvider adapter for Spirit
test/
├── run-tests-skyeyes.js    # Test runner using skyeyes bridge
├── skyeyes-helper.js       # Skyeyes test helper utilities
├── run-tests.js            # Test runner using Puppeteer
└── smoke.test.html         # Browser-based smoke tests
```

## Common Tasks

```bash
npm test                # Run tests via skyeyes
npm run test:puppeteer  # Run tests via Puppeteer
```

There is no build step — Foam uses plain ES modules served directly. Deploy by pushing to main (GitHub Pages auto-deploys via GitHub Actions with `workflow_dispatch` for manual trigger).

## Key Design Decisions

- **Plain JavaScript, no build step** — ES modules loaded directly by the browser
- **No TypeScript** — simpler toolchain, faster iteration, but no type checking
- **IndexedDB virtual filesystem** — same approach as Shiro
- **Compatible shell semantics** with Shiro — pipes, redirects, env vars, quoting
- **Submodules** — `spirit/` and `fluffycoreutils/` are git submodules

## Deployment

Foam auto-deploys to GitHub Pages on push to `main`. Also supports manual deploy via `workflow_dispatch` in the GitHub Actions UI.

Live at: https://williamsharkey.github.io/foam/

## Skyeyes MCP Tools

You have skyeyes MCP tools for browser interaction (see `~/.claude/CLAUDE.md` for full tool list). Your dedicated page IDs:
- `shiro-foam` — your shiro iframe
- `foam-foam` — your foam iframe

## Cross-Project Integration

- **Spirit** (williamsharkey/spirit): Claude Code agent loop. Foam provides `FoamProvider` (OSProvider interface) in `src/foam-provider.js`
- **Shiro** (williamsharkey/shiro): Sister browser OS in TypeScript. Compatible shell semantics
- **FluffyCoreutils** (williamsharkey/fluffycoreutils): Shared Unix commands, bridged via `src/fluffy-bridge.js`
- **Windwalker** (williamsharkey/windwalker): Test automation suite
- **Nimbus** (williamsharkey/nimbus): Orchestrator with live dashboard preview and skyeyes integration
- **Skyeyes** (williamsharkey/skyeyes): Browser-side bridge used for testing and remote JS execution
