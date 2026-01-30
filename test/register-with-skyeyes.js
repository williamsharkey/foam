// Auto-registration script for foam with skyeyes
// Inject this into the foam page to automatically register with skyeyes

(function() {
  const SKYEYES_WS = 'ws://localhost:7777';
  const PAGE_NAME = 'foam';

  // Wait for foam to be ready
  function waitForFoam() {
    return new Promise((resolve) => {
      if (window.__foam) {
        resolve();
      } else {
        window.addEventListener('foam:ready', () => resolve());
      }
    });
  }

  async function registerWithSkyeyes() {
    await waitForFoam();

    console.log('[Skyeyes] Attempting to register foam...');

    const ws = new WebSocket(SKYEYES_WS);

    ws.onopen = () => {
      console.log('[Skyeyes] WebSocket connected');
      ws.send(JSON.stringify({
        type: 'register',
        page: PAGE_NAME,
        url: window.location.href,
        metadata: {
          version: '0.1.0',
          vfsReady: !!window.__foam.vfs,
          shellReady: !!window.__foam.shell,
          providerReady: !!window.__foam.provider,
        }
      }));
      console.log(`[Skyeyes] Registered as "${PAGE_NAME}" page`);
    };

    ws.onerror = (err) => {
      console.warn('[Skyeyes] Failed to connect:', err.message);
      console.warn('[Skyeyes] Make sure skyeyes server is running on port 7777');
    };

    ws.onclose = () => {
      console.log('[Skyeyes] WebSocket closed');
    };

    // Keep reference for debugging
    window.__skyeyesWs = ws;
  }

  // Auto-register when foam loads
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerWithSkyeyes);
  } else {
    registerWithSkyeyes();
  }
})();
