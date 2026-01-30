// Headless test runner using skyeyes instead of Puppeteer
// Assumes skyeyes is running on localhost:7777 with foam page loaded

const SKYEYES_URL = 'http://localhost:7777/api/skyeyes';
const PAGE_NAME = 'foam'; // The skyeyes page name for foam

async function execJS(code) {
  const response = await fetch(`${SKYEYES_URL}/${PAGE_NAME}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });

  if (!response.ok) {
    throw new Error(`Skyeyes API error: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

async function waitForCondition(conditionFn, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await execJS(`(${conditionFn.toString()})()`);
    if (result.result === true) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Timeout waiting for condition');
}

async function runTests() {
  console.log('Running Foam tests via skyeyes...\n');

  try {
    // Check if foam page is loaded
    const pageCheck = await execJS('typeof window.__foam !== "undefined"');
    if (!pageCheck.result) {
      console.error('ERROR: Foam not loaded in skyeyes page');
      console.error('Make sure foam is loaded at http://localhost:7777 and registered as "foam" page');
      process.exit(1);
    }

    console.log('✓ Foam page detected');

    // Inject test script
    const testScript = `
      (async function() {
        const results = [];
        function assert(name, condition) {
          results.push({ name, pass: !!condition });
          if (!condition) console.error('FAIL:', name);
        }

        try {
          const foam = window.__foam;
          const { vfs, shell } = foam;

          // 1. VFS is initialized
          assert('VFS initialized', vfs && typeof vfs.readFile === 'function');

          // 2. Default directories exist
          assert('/ exists', await vfs.exists('/'));
          assert('/home/user exists', await vfs.exists('/home/user'));
          assert('/tmp exists', await vfs.exists('/tmp'));

          // 3. File operations work
          await vfs.writeFile('/tmp/test-skyeyes.txt', 'hello skyeyes');
          const content = await vfs.readFile('/tmp/test-skyeyes.txt');
          assert('writeFile + readFile', content === 'hello skyeyes');

          // 4. mkdir + readdir
          await vfs.mkdir('/tmp/testdir-skyeyes', { recursive: true });
          const entries = await vfs.readdir('/tmp');
          assert('mkdir + readdir', entries.some(e => e.name === 'testdir-skyeyes'));

          // 5. Shell exec works
          const lsResult = await shell.exec('ls /tmp');
          assert('shell exec ls', lsResult.exitCode === 0);
          assert('ls output contains test file', lsResult.stdout.includes('test-skyeyes.txt'));

          // 6. Pipes work
          const pipeResult = await shell.exec('echo "hello world" | grep hello');
          assert('pipe works', pipeResult.exitCode === 0 && pipeResult.stdout.includes('hello'));

          // 7. && works
          const andResult = await shell.exec('echo a && echo b');
          assert('&& works', andResult.stdout.includes('a') && andResult.stdout.includes('b'));

          // 8. Variable expansion
          const varResult = await shell.exec('echo $HOME');
          assert('$HOME expands', varResult.stdout.includes('/home/user'));

          // 9. FoamProvider exists and works
          assert('FoamProvider exists', foam.provider && typeof foam.provider.getCwd === 'function');
          assert('provider.getCwd()', foam.provider.getCwd() === vfs.cwd);
          assert('provider.getHostInfo()', foam.provider.getHostInfo().name === 'Foam');

          // 10. Cat command works
          const catResult = await shell.exec('cat /tmp/test-skyeyes.txt');
          assert('cat command', catResult.exitCode === 0 && catResult.stdout.includes('hello skyeyes'));

          // 11. Echo command works
          const echoResult = await shell.exec('echo hello foam');
          assert('echo command', echoResult.stdout.includes('hello foam'));

          // 12. Grep filters correctly
          await vfs.writeFile('/tmp/greptest.txt', 'hello world\\nfoo bar\\nhello again\\n');
          const grepResult = await shell.exec('grep hello /tmp/greptest.txt');
          assert('grep filters matching lines', grepResult.exitCode === 0);
          assert('grep returns only matches',
            grepResult.stdout.includes('hello world') &&
            grepResult.stdout.includes('hello again') &&
            !grepResult.stdout.includes('foo bar')
          );

          // 13. Pipe grep works
          const pipeGrepResult = await shell.exec('cat /tmp/greptest.txt | grep foo');
          assert('pipe grep',
            pipeGrepResult.exitCode === 0 &&
            pipeGrepResult.stdout.includes('foo bar') &&
            !pipeGrepResult.stdout.includes('hello')
          );

          // 14. JS command evaluates code
          const jsResult = await shell.exec('js 1+2');
          assert('js command eval', jsResult.stdout.trim() === '3');

          // 15. DOM command exists
          const domResult = await shell.exec('dom document.title');
          assert('dom command', domResult.exitCode === 0);

          // Cleanup
          await vfs.rmdir('/tmp/testdir-skyeyes', { recursive: true });
          await vfs.unlink('/tmp/test-skyeyes.txt');
          await vfs.unlink('/tmp/greptest.txt');

          // Report
          const passed = results.filter(r => r.pass).length;
          const failed = results.filter(r => !r.pass).length;

          window.__testResults = {
            results,
            passed,
            failed,
            total: results.length,
            allPassed: failed === 0
          };

          return window.__testResults;
        } catch (err) {
          console.error('FATAL:', err.message, err.stack);
          window.__testResults = {
            error: err.message,
            stack: err.stack,
            allPassed: false
          };
          return window.__testResults;
        }
      })();
    `;

    // Execute test script
    console.log('Running tests...\n');
    const result = await execJS(testScript);

    if (!result.result) {
      console.error('ERROR: Test execution failed');
      console.error(result);
      process.exit(1);
    }

    const testResults = result.result;

    if (testResults.error) {
      console.error('FATAL ERROR:', testResults.error);
      console.error(testResults.stack);
      process.exit(1);
    }

    // Print results
    console.log('---RESULTS---');
    for (const r of testResults.results) {
      console.log(`${r.pass ? '✓' : '✗'} ${r.name}`);
    }

    console.log('\n---SUMMARY---');
    console.log(`${testResults.passed} passed, ${testResults.failed} failed, ${testResults.total} total`);

    if (!testResults.allPassed) {
      console.error('\n❌ TESTS FAILED');
      process.exit(1);
    } else {
      console.log('\n✅ ALL TESTS PASSED');
      process.exit(0);
    }

  } catch (err) {
    console.error('Test runner error:', err.message);
    process.exit(1);
  }
}

runTests();
