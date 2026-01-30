#!/usr/bin/env node
// Linkedom-based test runner for Foam
// Runs tests directly in Node.js without browser overhead
// Equivalent to smoke.test.html but ~100x faster

import 'fake-indexeddb/auto';
import { DOMParser } from 'linkedom';

// Set up globals for modules that expect browser environment
global.window = global.window || {};
global.window.DOMParser = DOMParser;
global.DOMParser = DOMParser;

const results = [];
function assert(name, condition) {
  results.push({ name, pass: !!condition });
  if (!condition) console.error('FAIL:', name);
  else console.log('PASS:', name);
}

async function runTests() {
  console.log('Foam Smoke Tests (Linkedom Mode)\n');

  try {
    // 1. VFS loads and initializes
    const { default: VFS } = await import('../src/vfs.js');
    const vfs = new VFS();
    await vfs.init();
    assert('VFS initializes', true);

    // 2. Default directories exist
    assert('/ exists', await vfs.exists('/'));
    assert('/home/user exists', await vfs.exists('/home/user'));
    assert('/tmp exists', await vfs.exists('/tmp'));

    // 3. File operations work
    await vfs.writeFile('/tmp/test.txt', 'hello foam');
    const content = await vfs.readFile('/tmp/test.txt');
    assert('writeFile + readFile', content === 'hello foam');

    // 4. mkdir + readdir
    await vfs.mkdir('/tmp/testdir', { recursive: true });
    const entries = await vfs.readdir('/tmp');
    assert('mkdir + readdir', entries.some(e => e.name === 'testdir'));

    // 5. Commands module loads
    const { default: commands } = await import('../src/commands.js');
    assert('commands module loads', typeof commands.cd === 'function');

    // 5b. Register fluffycoreutils
    const { registerFluffyCommands } = await import('../src/fluffy-bridge.js');
    registerFluffyCommands();
    assert('fluffy commands registered', typeof commands.ls === 'function');
    assert('commands.grep exists', typeof commands.grep === 'function');
    assert('commands.cat exists', typeof commands.cat === 'function');

    // 6. Shell module loads
    const { default: Shell } = await import('../src/shell.js');
    const shell = new Shell(vfs);
    assert('Shell initializes', true);

    // 7. Shell exec works
    const lsResult = await shell.exec('ls /tmp');
    assert('shell exec ls', lsResult.exitCode === 0);
    assert('ls output contains test.txt', lsResult.stdout.includes('test.txt'));

    // 8. Pipes work
    const pipeResult = await shell.exec('echo "hello world" | grep hello');
    assert('pipe works', pipeResult.exitCode === 0 && pipeResult.stdout.includes('hello'));

    // 9. && works
    const andResult = await shell.exec('echo a && echo b');
    assert('&& works', andResult.stdout.includes('a') && andResult.stdout.includes('b'));

    // 10. Variable expansion
    const varResult = await shell.exec('echo $HOME');
    assert('$HOME expands', varResult.stdout.includes('/home/user'));

    // 11. Devtools load (registers git/npm/node into commands)
    // Pre-load isomorphic-git for Node.js environment
    const git = await import('isomorphic-git');
    globalThis.__isomorphicGit = git.default;

    await import('../src/devtools.js');
    assert('devtools loads', typeof commands.git === 'function');
    assert('npm command exists', typeof commands.npm === 'function');
    assert('node command exists', typeof commands.node === 'function');

    // 12. Git command works (local operations)
    vfs.chdir('/tmp/testdir');
    assert('git command registered', typeof commands.git === 'function');

    // Test actual git init
    const gitInitResult = await shell.exec('git init');
    assert('git init works', gitInitResult.exitCode === 0 || gitInitResult.stdout.includes('Initialized'));

    // 13. Claude module loads
    const { default: ClaudeClient } = await import('../src/claude.js');
    assert('claude module loads', typeof ClaudeClient === 'function');

    // 14. FoamProvider loads
    const { default: FoamProvider } = await import('../src/foam-provider.js');
    const provider = new FoamProvider(vfs, shell, null);
    assert('FoamProvider initializes', true);
    assert('provider.getCwd()', provider.getCwd() === '/tmp/testdir');
    assert('provider.getHostInfo()', provider.getHostInfo().name === 'Foam');

    // 15. Fluffy cat command works through shell
    const catResult = await shell.exec('cat /tmp/test.txt');
    assert('fluffy cat via shell', catResult.exitCode === 0 && catResult.stdout.includes('hello foam'));

    // 15b. Fluffy echo command works
    const echoResult = await shell.exec('echo hello fluffy');
    assert('fluffy echo via shell', echoResult.stdout.includes('hello fluffy'));

    // 15c. Fluffy grep filters correctly
    await vfs.writeFile('/tmp/greptest.txt', 'hello world\nfoo bar\nhello again\n');
    vfs.chdir('/tmp');
    const grepResult = await shell.exec('grep hello /tmp/greptest.txt');
    assert('grep filters matching lines', grepResult.exitCode === 0);
    assert('grep returns only matches', grepResult.stdout.includes('hello world') && grepResult.stdout.includes('hello again') && !grepResult.stdout.includes('foo bar'));

    // 15d. Pipe grep works
    const pipeGrepResult = await shell.exec('cat /tmp/greptest.txt | grep foo');
    assert('pipe grep', pipeGrepResult.exitCode === 0 && pipeGrepResult.stdout.includes('foo bar') && !pipeGrepResult.stdout.includes('hello'));

    // 15e. Multi-command pipe
    const multiPipe = await shell.exec('echo "aaa\nbbb\nccc" | grep -v bbb | wc -l');
    assert('multi-command pipe', multiPipe.exitCode === 0);

    await vfs.unlink('/tmp/greptest.txt');
    vfs.chdir('/tmp/testdir');

    // 16. Glob command works
    await vfs.writeFile('/tmp/testdir/foo.js', 'a');
    await vfs.writeFile('/tmp/testdir/bar.js', 'b');
    const globResult = await shell.exec('glob "*.js" /tmp/testdir');
    assert('glob command', globResult.exitCode === 0 && globResult.stdout.includes('foo.js'));

    // 17. js command evaluates code
    const jsResult = await shell.exec('js 1+2');
    assert('js command eval', jsResult.stdout.trim() === '3');

    // 18. Streaming: ClaudeClient has _callApiStream
    const claudeProto = ClaudeClient.prototype;
    assert('streaming _callApiStream exists', typeof claudeProto._callApiStream === 'function');

    // 19. Hypercompact (hc) command
    assert('hc command exists', typeof commands.hc === 'function');

    // Cleanup
    await vfs.rmdir('/tmp/testdir', { recursive: true });
    await vfs.unlink('/tmp/test.txt');

  } catch (err) {
    console.error('FATAL:', err.message);
    console.error(err.stack);
    results.push({ name: 'FATAL ERROR', pass: false });
  }

  // Report
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${passed} passed, ${failed} failed, ${results.length} total`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
