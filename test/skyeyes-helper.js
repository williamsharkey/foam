// Helper script to register/interact with Foam in skyeyes
// This provides utilities for managing the foam page in skyeyes

const SKYEYES_URL = 'http://localhost:7777/api/skyeyes';
const PAGE_NAME = 'foam';
const FOAM_URL = 'http://localhost:5173'; // Default Vite dev server

async function execJS(code) {
  const response = await fetch(`${SKYEYES_URL}/${PAGE_NAME}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });

  if (!response.ok) {
    throw new Error(`Skyeyes API error: ${response.status}`);
  }

  return await response.json();
}

// Check if foam page is registered and loaded
async function checkPage() {
  try {
    const result = await execJS('typeof window.__foam !== "undefined"');
    return result.result === true;
  } catch (err) {
    return false;
  }
}

// Get foam version info
async function getInfo() {
  try {
    const result = await execJS(`({
      url: window.location.href,
      title: document.title,
      foamLoaded: typeof window.__foam !== 'undefined',
      vfsReady: window.__foam?.vfs ? true : false,
      shellReady: window.__foam?.shell ? true : false,
      providerReady: window.__foam?.provider ? true : false,
      cwd: window.__foam?.vfs?.cwd || 'unknown'
    })`);
    return result.result;
  } catch (err) {
    return { error: err.message };
  }
}

// Execute a shell command in foam
async function execShell(command) {
  try {
    const result = await execJS(`
      (async () => {
        const result = await window.__foam.shell.exec(${JSON.stringify(command)});
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr
        };
      })()
    `);
    return result.result;
  } catch (err) {
    return { error: err.message };
  }
}

// Main CLI
const command = process.argv[2];

(async () => {
  switch (command) {
    case 'check':
      const isReady = await checkPage();
      console.log(isReady ? '✓ Foam is loaded in skyeyes' : '✗ Foam not loaded');
      process.exit(isReady ? 0 : 1);
      break;

    case 'info':
      const info = await getInfo();
      console.log(JSON.stringify(info, null, 2));
      break;

    case 'exec':
      const shellCmd = process.argv.slice(3).join(' ');
      if (!shellCmd) {
        console.error('Usage: node skyeyes-helper.js exec <command>');
        process.exit(1);
      }
      const output = await execShell(shellCmd);
      if (output.error) {
        console.error('Error:', output.error);
        process.exit(1);
      }
      console.log(output.stdout);
      if (output.stderr) console.error(output.stderr);
      process.exit(output.exitCode || 0);
      break;

    default:
      console.log(`
Skyeyes Helper for Foam

Usage:
  node skyeyes-helper.js check          Check if foam is loaded
  node skyeyes-helper.js info           Get foam page info
  node skyeyes-helper.js exec <cmd>     Execute shell command in foam

Prerequisites:
  1. Skyeyes running on http://localhost:7777
  2. Foam loaded in browser
  3. Foam registered as "${PAGE_NAME}" page in skyeyes

To register foam in skyeyes:
  1. Open ${FOAM_URL} in browser
  2. Open browser console and run:
     const ws = new WebSocket('ws://localhost:7777');
     ws.onopen = () => ws.send(JSON.stringify({
       type: 'register',
       page: '${PAGE_NAME}',
       url: window.location.href
     }));
      `);
      break;
  }
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
