# Foam Testing with Skyeyes

This directory contains a **skyeyes-based test runner** that replaces Puppeteer for faster, more efficient testing.

## Why Skyeyes Instead of Puppeteer?

**Puppeteer Problems:**
- 🐌 Slow startup (launches entire Chromium instance)
- 💾 Resource-heavy (hundreds of MB RAM per test run)
- 🔄 Painful to keep running in background
- 🐛 Complex debugging (headless browser issues)

**Skyeyes Benefits:**
- ⚡ Instant execution (uses already-open browser)
- 🪶 Lightweight (just HTTP requests to running page)
- 🔧 Easy debugging (test in actual browser DevTools)
- 🎯 Reuses existing dev environment
- 🔄 No browser startup/teardown overhead

## Setup

### 1. Start Skyeyes Server

```bash
# From nimbus directory
npm run dev
# or
node server.js
```

Skyeyes should be running on `http://localhost:7777`

### 2. Open Foam in Browser

```bash
# Start foam dev server
npm run dev
```

Open `http://localhost:5173` in your browser

### 3. Register Foam with Skyeyes

In the browser console on the foam page, run:

```javascript
const ws = new WebSocket('ws://localhost:7777');
ws.onopen = () => ws.send(JSON.stringify({
  type: 'register',
  page: 'foam',
  url: window.location.href
}));
```

Or use the nimbus dashboard to add the page.

## Running Tests

### Quick Test

```bash
node test/skyeyes-helper.js check
```

### Full Test Suite

```bash
node test/run-tests-skyeyes.js
```

### Execute Single Command

```bash
node test/skyeyes-helper.js exec "ls /tmp"
node test/skyeyes-helper.js exec "echo hello | grep hello"
```

### Get Page Info

```bash
node test/skyeyes-helper.js info
```

## Test Files

- **`run-tests-skyeyes.js`** - Main test runner using skyeyes API
- **`skyeyes-helper.js`** - CLI utility for interacting with foam page
- **`run-tests.js`** - Old Puppeteer-based runner (deprecated)
- **`smoke.test.html`** - Standalone HTML test page (can still be used)

## How It Works

1. **Skyeyes** provides a REST API at `http://localhost:7777/api/skyeyes/<page>/exec`
2. Tests send JavaScript code via POST requests
3. Code executes in the live foam page via `window.__foam`
4. Results are returned as JSON

Example API call:

```bash
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H "Content-Type: application/json" \
  -d '{"code": "window.__foam.vfs.cwd"}'
```

## CI/CD Integration

For CI/CD pipelines where you can't use a live browser:

1. Keep using `run-tests.js` (Puppeteer) for headless CI
2. Use `run-tests-skyeyes.js` for local development

Or set up a headless browser with skyeyes in CI (advanced).

## Debugging Tests

Since tests run in a real browser:

1. Open foam in browser
2. Open DevTools console
3. Run individual test commands manually:
   ```javascript
   await window.__foam.shell.exec('ls /tmp')
   ```
4. Inspect `window.__foam` object directly

## Writing New Tests

Add tests to `run-tests-skyeyes.js` by extending the `testScript` string:

```javascript
// Add to the test script
assert('my new test', await shell.exec('my-command').exitCode === 0);
```

Tests run sequentially in the same foam instance, so:
- ✓ Shared state persists between tests
- ✓ Fast execution (no page reloads)
- ⚠️ Clean up after yourself (use unique file names)

## Comparison

| Feature | Puppeteer | Skyeyes |
|---------|-----------|---------|
| Startup time | ~3-5 seconds | Instant |
| Memory usage | ~200MB | <1MB |
| Test execution | 5-10s | 1-2s |
| Debugging | Headless logs | Live DevTools |
| Background friendly | ❌ | ✅ |
| CI/CD ready | ✅ | ⚠️ (needs setup) |

## Troubleshooting

**"Foam not loaded in skyeyes page"**
- Make sure foam is open in browser
- Check registration in skyeyes dashboard
- Run `node test/skyeyes-helper.js check`

**"Skyeyes API error: 404"**
- Skyeyes server not running
- Page name mismatch (must be "foam")
- Wrong port (should be 7777)

**Tests fail locally but pass in Puppeteer**
- Check browser console for errors
- VFS might be in different state
- Try refreshing foam page

## Migration from Puppeteer

To completely replace Puppeteer:

1. Update `package.json` scripts:
   ```json
   {
     "test": "node test/run-tests-skyeyes.js",
     "test:ci": "node test/run-tests.js"
   }
   ```

2. Remove puppeteer dependency (optional):
   ```bash
   npm uninstall puppeteer
   ```

3. Document skyeyes requirement in main README
