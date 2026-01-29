// Headless test runner using Puppeteer
// Serves the project, opens smoke.test.html, checks console output for pass/fail
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { launch } from 'puppeteer';

const PORT = 9123;
const ROOT = new URL('..', import.meta.url).pathname;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

// Simple static file server
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let filePath = join(ROOT, url.pathname);
  if (filePath.endsWith('/')) filePath += 'index.html';

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
});

async function run() {
  await new Promise(resolve => server.listen(PORT, resolve));
  console.log(`Server listening on http://localhost:${PORT}`);

  const browser = await launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    timeout: 60000,
    protocolTimeout: 60000,
  });

  const page = await browser.newPage();
  const logs = [];
  const errors = [];

  page.on('console', msg => {
    const text = msg.text();
    logs.push(text);
    console.log(text);
  });

  page.on('pageerror', err => {
    errors.push(err.message);
    console.error('PAGE ERROR:', err.message);
  });

  try {
    await page.goto(`http://localhost:${PORT}/test/smoke.test.html`, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Wait for tests to complete (title changes to PASS or FAIL)
    await page.waitForFunction(
      () => document.title === 'PASS' || document.title === 'FAIL',
      { timeout: 30000 }
    );

    const title = await page.title();
    const passed = title === 'PASS' && errors.length === 0;

    if (!passed) {
      console.error('\n--- TEST FAILURE ---');
      if (errors.length) console.error('Page errors:', errors);
      process.exitCode = 1;
    } else {
      console.log('\n--- ALL TESTS PASSED ---');
    }
  } catch (err) {
    console.error('Test runner error:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
}

run();
