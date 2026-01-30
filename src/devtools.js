// Dev tools — git (isomorphic-git), npm, node implementations on VFS
import commands from './commands.js';

// ─── GIT (isomorphic-git) ───────────────────────────────────────────────────
// Loaded lazily from esm.sh on first use

let git = null;
let http = null;

async function loadGit() {
  if (git) return;
  const mod = await import('https://esm.sh/isomorphic-git@1.27.1');
  git = mod.default;
  const httpMod = await import('https://esm.sh/isomorphic-git@1.27.1/http/web');
  http = httpMod.default;
}

async function listAllFiles(vfs, dir, base) {
  const entries = await vfs.readdir(dir);
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const fullPath = (dir === '/' ? '' : dir) + '/' + entry.name;
    if (entry.type === 'dir') {
      files.push(...await listAllFiles(vfs, fullPath, base));
    } else {
      files.push(fullPath.slice(base.length + 1));
    }
  }
  return files;
}

commands.git = async (args, { stdout, stderr, vfs }) => {
  if (args.length === 0) {
    stdout('usage: git <command> [<args>]\n\nAvailable commands:\n  init, add, commit, status, log, diff, branch, checkout, clone\n');
    return 0;
  }

  try {
    await loadGit();
  } catch (err) {
    stderr(`git: failed to load isomorphic-git: ${err.message}\n`);
    return 1;
  }

  const sub = args[0];
  const subArgs = args.slice(1);
  const fs = vfs.toIsomorphicGitFS();
  const dir = vfs.cwd;

  try {
    switch (sub) {
      case 'init': {
        // Pre-create .git directory for isomorphic-git compatibility
        const gitDir = vfs.resolvePath('.git', dir);
        try {
          await vfs.mkdir(gitDir, { recursive: true });
        } catch (e) {
          // Ignore if already exists
        }
        await git.init({ fs, dir });
        stdout(`Initialized empty Git repository in ${dir}/.git/\n`);
        break;
      }

      case 'add': {
        const paths = subArgs;
        if (paths.length === 0 || paths.includes('.') || paths.includes('-A')) {
          const allFiles = await listAllFiles(vfs, dir, dir);
          for (const filepath of allFiles) {
            await git.add({ fs, dir, filepath });
          }
        } else {
          for (const filepath of paths) {
            await git.add({ fs, dir, filepath });
          }
        }
        break;
      }

      case 'commit': {
        let message = '';
        for (let i = 0; i < subArgs.length; i++) {
          if ((subArgs[i] === '-m' || subArgs[i] === '--message') && subArgs[i + 1]) {
            message = subArgs[++i];
          }
        }
        if (!message) { stderr('error: must supply commit message with -m\n'); return 1; }
        const sha = await git.commit({
          fs, dir, message,
          author: { name: vfs.env.USER || 'user', email: 'user@foam.local' },
        });
        stdout(`[main ${sha.slice(0, 7)}] ${message}\n`);
        break;
      }

      case 'status': {
        const matrix = await git.statusMatrix({ fs, dir });
        let hasChanges = false;
        const staged = [];
        const unstaged = [];
        const untracked = [];

        for (const [filepath, head, workdir, stage] of matrix) {
          const key = `${head}${workdir}${stage}`;
          if (key === '111') continue; // unmodified
          hasChanges = true;
          if (head === 0 && workdir === 2 && stage === 0) {
            untracked.push(filepath);
          } else if (stage === 3 || (head === 0 && stage === 2)) {
            const status = head === 0 ? 'new file' : 'modified';
            staged.push(`${status}:   ${filepath}`);
          } else if (stage === 0 || workdir !== stage) {
            unstaged.push(`modified:   ${filepath}`);
          }
        }

        const branch = await git.currentBranch({ fs, dir }) || 'main';
        stdout(`On branch ${branch}\n`);
        if (staged.length > 0) {
          stdout('\nChanges to be committed:\n');
          for (const s of staged) stdout(`\t\x1b[32m${s}\x1b[0m\n`);
        }
        if (unstaged.length > 0) {
          stdout('\nChanges not staged for commit:\n');
          for (const s of unstaged) stdout(`\t\x1b[31m${s}\x1b[0m\n`);
        }
        if (untracked.length > 0) {
          stdout('\nUntracked files:\n');
          for (const f of untracked) stdout(`\t\x1b[31m${f}\x1b[0m\n`);
        }
        if (!hasChanges) stdout('\nnothing to commit, working tree clean\n');
        break;
      }

      case 'log': {
        let maxCount = 10;
        const oneline = subArgs.includes('--oneline');
        for (let i = 0; i < subArgs.length; i++) {
          if (subArgs[i] === '-n' && subArgs[i + 1]) maxCount = parseInt(subArgs[++i]);
          if (subArgs[i]?.startsWith('--max-count=')) maxCount = parseInt(subArgs[i].split('=')[1]);
        }
        const commits = await git.log({ fs, dir, depth: maxCount });
        for (const c of commits) {
          if (oneline) {
            stdout(`\x1b[33m${c.oid.slice(0, 7)}\x1b[0m ${c.commit.message.trim()}\n`);
          } else {
            stdout(`\x1b[33mcommit ${c.oid}\x1b[0m\n`);
            stdout(`Author: ${c.commit.author.name} <${c.commit.author.email}>\n`);
            const date = new Date(c.commit.author.timestamp * 1000);
            stdout(`Date:   ${date.toISOString()}\n`);
            stdout(`\n    ${c.commit.message.trim()}\n\n`);
          }
        }
        break;
      }

      case 'diff': {
        const matrix = await git.statusMatrix({ fs, dir });
        for (const [filepath, head, workdir] of matrix) {
          if (head === workdir) continue;
          if (head === 0 && workdir === 2) {
            const content = await vfs.readFile(vfs.resolvePath(filepath));
            stdout(`\x1b[1mdiff --git a/${filepath} b/${filepath}\x1b[0m\n`);
            stdout(`new file\n--- /dev/null\n+++ b/${filepath}\n`);
            const lines = content.split('\n');
            stdout(`@@ -0,0 +1,${lines.length} @@\n`);
            for (const line of lines) stdout(`\x1b[32m+${line}\x1b[0m\n`);
          } else if (workdir === 0) {
            stdout(`\x1b[1mdiff --git a/${filepath} b/${filepath}\x1b[0m\ndeleted file\n`);
          } else {
            stdout(`\x1b[1mdiff --git a/${filepath} b/${filepath}\x1b[0m\n`);
            stdout(`--- a/${filepath}\n+++ b/${filepath}\n(content diff not shown)\n`);
          }
        }
        break;
      }

      case 'branch': {
        if (subArgs.length === 0) {
          const branches = await git.listBranches({ fs, dir });
          const current = await git.currentBranch({ fs, dir });
          for (const b of branches) {
            stdout((b === current ? '* ' : '  ') + b + '\n');
          }
        } else {
          // Create branch
          await git.branch({ fs, dir, ref: subArgs[0] });
          stdout(`Created branch '${subArgs[0]}'\n`);
        }
        break;
      }

      case 'checkout': {
        if (subArgs.length === 0) { stderr('error: no branch specified\n'); return 1; }
        const target = subArgs.filter(a => !a.startsWith('-'))[0];
        const createNew = subArgs.includes('-b');
        if (createNew) {
          await git.branch({ fs, dir, ref: target, checkout: true });
        }
        await git.checkout({ fs, dir, ref: target });
        stdout(`Switched to branch '${target}'\n`);
        break;
      }

      case 'clone': {
        const url = subArgs[0];
        if (!url) { stderr('error: must specify repository URL\n'); return 1; }
        const repoName = url.split('/').pop()?.replace(/\.git$/, '') || 'repo';
        const targetDir = subArgs[1]
          ? vfs.resolvePath(subArgs[1])
          : vfs.resolvePath(repoName);
        await vfs.mkdir(targetDir, { recursive: true });
        // Pre-create .git directory for isomorphic-git compatibility
        const gitDir = vfs.resolvePath('.git', targetDir);
        try {
          await vfs.mkdir(gitDir, { recursive: true });
        } catch (e) {
          // Ignore if already exists
        }
        stdout(`Cloning into '${repoName}'...\n`);
        await git.clone({
          fs, http, dir: targetDir, url,
          corsProxy: 'https://cors.isomorphic-git.org',
          singleBranch: true,
          depth: 1,
        });
        stdout('done.\n');
        break;
      }

      default:
        stderr(`git: '${sub}' is not a git command\n`);
        return 1;
    }
  } catch (err) {
    stderr(`fatal: ${err.message}\n`);
    return 128;
  }

  return 0;
};

// ─── NPM ────────────────────────────────────────────────────────────────────

commands.npm = async (args, { stdout, stderr, vfs, exec }) => {
  if (args.length === 0) {
    stdout('Usage: npm <command>\n\n');
    stdout('Commands:\n');
    stdout('  init              Create package.json\n');
    stdout('  install [pkg]     Install package(s)\n');
    stdout('  run <script>      Run package.json script\n');
    stdout('  list, ls          List installed packages\n');
    stdout('  --version         Show npm version\n');
    return 0;
  }

  const sub = args[0];

  // Version info
  if (sub === '--version' || sub === '-v') {
    stdout('10.2.4 (Foam browser-native)\n');
    return 0;
  }

  // Help
  if (sub === '--help' || sub === 'help') {
    stdout('npm <command>\n\n');
    stdout('Commands:\n');
    stdout('  init              Create package.json\n');
    stdout('  install [pkg]     Install from registry.npmjs.org or esm.sh\n');
    stdout('  run <script>      Execute package.json script\n');
    stdout('  list, ls          List installed packages\n');
    return 0;
  }

  // npm init
  if (sub === 'init') {
    const yFlag = args.includes('-y') || args.includes('--yes');
    const pkg = {
      name: vfs.cwd.split('/').pop() || 'project',
      version: '1.0.0',
      description: '',
      main: 'index.js',
      scripts: {
        start: 'node index.js',
        test: 'echo "Error: no test specified" && exit 1'
      },
      keywords: [],
      author: '',
      license: 'ISC',
      dependencies: {},
    };
    await vfs.writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n');
    stdout('Wrote to package.json\n');
    return 0;
  }

  // npm install
  if (sub === 'install' || sub === 'i') {
    const pkgName = args[1];

    // No package specified - install from package.json
    if (!pkgName) {
      try {
        const pkgJson = JSON.parse(await vfs.readFile('package.json'));
        const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
        if (Object.keys(deps).length === 0) {
          stdout('up to date\n');
          return 0;
        }

        await vfs.mkdir('node_modules', { recursive: true });
        let installed = 0;

        for (const [name, version] of Object.entries(deps)) {
          try {
            stdout(`Installing ${name}@${version}...\n`);
            await installPackage(name, version, vfs, stdout, stderr);
            installed++;
          } catch (err) {
            stderr(`Failed to install ${name}: ${err.message}\n`);
          }
        }

        stdout(`\nadded ${installed} packages\n`);
        return 0;
      } catch (err) {
        stderr(`npm ERR! ${err.message}\n`);
        return 1;
      }
    }

    // Install specific package
    try {
      await vfs.mkdir('node_modules', { recursive: true });
      const version = args[2] || 'latest';

      stdout(`Installing ${pkgName}...\n`);
      await installPackage(pkgName, version, vfs, stdout, stderr);

      // Update package.json if it exists
      try {
        const pkgJson = JSON.parse(await vfs.readFile('package.json'));
        pkgJson.dependencies = pkgJson.dependencies || {};
        pkgJson.dependencies[pkgName] = version === 'latest' ? '^1.0.0' : version;
        await vfs.writeFile('package.json', JSON.stringify(pkgJson, null, 2) + '\n');
      } catch (_) {
        // No package.json, that's ok
      }

      stdout(`\nadded 1 package\n`);
      return 0;
    } catch (err) {
      stderr(`npm ERR! ${err.message}\n`);
      return 1;
    }
  }

  // npm run
  if (sub === 'run' || sub === 'run-script') {
    const script = args[1];
    if (!script) {
      // List available scripts
      try {
        const pkgJson = JSON.parse(await vfs.readFile('package.json'));
        const scripts = pkgJson.scripts || {};
        if (Object.keys(scripts).length === 0) {
          stdout('No scripts available\n');
          return 0;
        }
        stdout('Available scripts:\n');
        for (const [name, cmd] of Object.entries(scripts)) {
          stdout(`  ${name}\n    ${cmd}\n`);
        }
        return 0;
      } catch (err) {
        stderr(`npm ERR! ${err.message}\n`);
        return 1;
      }
    }

    try {
      const pkgJson = JSON.parse(await vfs.readFile('package.json'));
      const cmd = pkgJson.scripts?.[script];
      if (!cmd) {
        stderr(`npm ERR! Missing script: "${script}"\n\n`);
        stderr('Available scripts:\n');
        for (const name of Object.keys(pkgJson.scripts || {})) {
          stderr(`  ${name}\n`);
        }
        return 1;
      }

      stdout(`\n> ${pkgJson.name}@${pkgJson.version} ${script}\n`);
      stdout(`> ${cmd}\n\n`);

      // Execute the script command
      if (exec && typeof exec === 'function') {
        const result = await exec(cmd);
        if (result.stdout) stdout(result.stdout);
        if (result.stderr) stderr(result.stderr);
        return result.exitCode || 0;
      } else {
        // Fallback: just show the command
        stdout(`(Script execution requires exec context)\n`);
        return 0;
      }
    } catch (err) {
      stderr(`npm ERR! ${err.message}\n`);
      return 1;
    }
  }

  // npm list / ls
  if (sub === 'list' || sub === 'ls') {
    try {
      const entries = await vfs.readdir('node_modules');
      if (entries.length === 0) {
        stdout('(empty)\n');
        return 0;
      }

      // Try to read package.json for project name
      let projectName = 'project';
      let projectVersion = '1.0.0';
      try {
        const pkgJson = JSON.parse(await vfs.readFile('package.json'));
        projectName = pkgJson.name || projectName;
        projectVersion = pkgJson.version || projectVersion;
      } catch (_) {}

      stdout(`${projectName}@${projectVersion} ${vfs.cwd}\n`);
      for (const entry of entries) {
        if (entry.type === 'dir' && !entry.name.startsWith('.')) {
          // Try to read package version
          let version = '';
          try {
            const pkgPath = `node_modules/${entry.name}/package.json`;
            const pkgData = JSON.parse(await vfs.readFile(pkgPath));
            version = `@${pkgData.version}`;
          } catch (_) {
            version = '@latest';
          }
          stdout(`├── ${entry.name}${version}\n`);
        }
      }
      return 0;
    } catch (err) {
      stderr(`npm ERR! ${err.message}\n`);
      return 1;
    }
  }

  stderr(`npm ERR! Unknown command: "${sub}"\n`);
  stderr('Run "npm --help" for usage\n');
  return 1;
};

// Helper function to extract tar.gz using DecompressionStream and browser APIs
async function extractTarball(tarballBuffer, vfs, baseDir, stdout) {
  // Step 1: Decompress gzip using DecompressionStream
  const gzipStream = new Blob([tarballBuffer]).stream();
  const decompressedStream = gzipStream.pipeThrough(new DecompressionStream('gzip'));

  // Read decompressed data
  const reader = decompressedStream.getReader();
  const chunks = [];
  let totalSize = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalSize += value.length;
  }

  // Combine chunks into single Uint8Array
  const tarData = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    tarData.set(chunk, offset);
    offset += chunk.length;
  }

  // Step 2: Parse TAR format
  // TAR format: Each file has a 512-byte header followed by file data (rounded to 512 bytes)
  let pos = 0;
  let filesExtracted = 0;

  while (pos < tarData.length) {
    // Read TAR header (512 bytes)
    if (pos + 512 > tarData.length) break;

    const header = tarData.slice(pos, pos + 512);

    // Check if this is a zero block (end of archive)
    if (header.every(b => b === 0)) break;

    // Parse header fields
    const name = readString(header, 0, 100).replace(/^package\//, ''); // Remove "package/" prefix
    const mode = readOctal(header, 100, 8);
    const size = readOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156]);

    pos += 512; // Move past header

    // Skip if no name or size is invalid
    if (!name || size < 0) {
      pos += Math.ceil(size / 512) * 512;
      continue;
    }

    // Handle different file types
    if (typeFlag === '0' || typeFlag === '' || typeFlag === '5') {
      // Regular file or directory
      if (typeFlag === '5' || name.endsWith('/')) {
        // Directory - create it
        const dirPath = `${baseDir}/${name}`.replace(/\/$/, '');
        try {
          await vfs.mkdir(dirPath, { recursive: true });
        } catch (e) {
          // Ignore if already exists
        }
      } else if (size > 0) {
        // Regular file - extract content
        const fileData = tarData.slice(pos, pos + size);
        const filePath = `${baseDir}/${name}`;

        // Ensure parent directory exists
        const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
        if (parentDir && parentDir !== baseDir) {
          try {
            await vfs.mkdir(parentDir, { recursive: true });
          } catch (e) {
            // Ignore if already exists
          }
        }

        // Write file
        const textDecoder = new TextDecoder();
        const content = textDecoder.decode(fileData);
        await vfs.writeFile(filePath, content);
        filesExtracted++;
      }

      // Move to next file (data is padded to 512-byte boundary)
      pos += Math.ceil(size / 512) * 512;
    } else {
      // Unknown type - skip
      pos += Math.ceil(size / 512) * 512;
    }
  }

  return filesExtracted;
}

// Helper to read null-terminated string from buffer
function readString(buffer, offset, length) {
  let str = '';
  for (let i = 0; i < length; i++) {
    const char = buffer[offset + i];
    if (char === 0) break;
    str += String.fromCharCode(char);
  }
  return str.trim();
}

// Helper to read octal number from buffer
function readOctal(buffer, offset, length) {
  const str = readString(buffer, offset, length);
  return str ? parseInt(str, 8) : 0;
}

// Helper function to install a package from npm registry with tarball extraction
async function installPackage(pkgName, version, vfs, stdout, stderr) {
  const pkgDir = `node_modules/${pkgName}`;

  try {
    // Fetch package metadata from npm registry
    stdout(`  Fetching ${pkgName} metadata...\n`);
    const registryUrl = `https://registry.npmjs.org/${pkgName}`;
    const metaRes = await globalThis.fetch(registryUrl);

    if (!metaRes.ok) {
      throw new Error(`Registry returned ${metaRes.status}`);
    }

    const meta = await metaRes.json();
    const versionToInstall = version === 'latest' || version === '^1.0.0'
      ? meta['dist-tags']?.latest
      : version.replace(/^[\^~]/, ''); // Remove semver prefixes

    const versionData = meta.versions?.[versionToInstall];

    if (!versionData) {
      throw new Error(`Version ${version} not found`);
    }

    // Get tarball URL
    const tarballUrl = versionData.dist?.tarball;
    if (!tarballUrl) {
      throw new Error('No tarball URL found in package metadata');
    }

    stdout(`  Downloading ${pkgName}@${versionData.version}...\n`);

    // Download tarball
    const tarballRes = await globalThis.fetch(tarballUrl);
    if (!tarballRes.ok) {
      throw new Error(`Failed to download tarball: ${tarballRes.status}`);
    }

    const tarballBuffer = await tarballRes.arrayBuffer();
    stdout(`  Downloaded ${(tarballBuffer.byteLength / 1024).toFixed(1)}KB\n`);

    // Create package directory
    await vfs.mkdir(pkgDir, { recursive: true });

    // Extract tarball
    stdout(`  Extracting...\n`);
    const filesExtracted = await extractTarball(tarballBuffer, vfs, pkgDir, stdout);
    stdout(`  + ${pkgName}@${versionData.version} (${filesExtracted} files)\n`);

    return versionData.version;

  } catch (err) {
    // Fallback to esm.sh for browser-compatible packages
    stderr(`  npm registry failed: ${err.message}\n`);
    stdout(`  Falling back to esm.sh...\n`);

    try {
      await vfs.mkdir(pkgDir, { recursive: true });

      const esmUrl = version === 'latest' || version.startsWith('^') || version.startsWith('~')
        ? `https://esm.sh/${pkgName}`
        : `https://esm.sh/${pkgName}@${version}`;

      const res = await globalThis.fetch(esmUrl);
      if (!res.ok) {
        throw new Error(`esm.sh returned ${res.status}`);
      }

      const code = await res.text();
      await vfs.writeFile(`${pkgDir}/index.js`, code);

      // Create minimal package.json
      const pkgJson = {
        name: pkgName,
        version: version === 'latest' ? '1.0.0' : version.replace(/^[\^~]/, ''),
        main: 'index.js'
      };
      await vfs.writeFile(`${pkgDir}/package.json`, JSON.stringify(pkgJson, null, 2));

      stdout(`  + ${pkgName}@${pkgJson.version} (esm.sh)\n`);
      return pkgJson.version;

    } catch (fallbackErr) {
      throw new Error(`Both npm registry and esm.sh failed: ${fallbackErr.message}`);
    }
  }
}

// ─── NODE ───────────────────────────────────────────────────────────────────

commands.node = async (args, { stdin, stdout, stderr, vfs }) => {
  // Helper to resolve and load a module
  async function loadModule(modulePath) {
    // Try to resolve the module
    let resolvedPath = modulePath;

    // Check if it's a relative/absolute path
    if (modulePath.startsWith('./') || modulePath.startsWith('../') || modulePath.startsWith('/')) {
      // Resolve relative to current directory
      resolvedPath = vfs.resolvePath(modulePath, vfs.cwd);

      // Add .js extension if missing
      if (!resolvedPath.endsWith('.js') && !resolvedPath.endsWith('.json')) {
        try {
          await vfs.readFile(resolvedPath + '.js');
          resolvedPath += '.js';
        } catch {
          try {
            await vfs.readFile(resolvedPath + '/index.js');
            resolvedPath += '/index.js';
          } catch {
            // Try as-is
          }
        }
      }
    } else {
      // Try to load from node_modules
      const nodeModulesPath = `node_modules/${modulePath}`;

      try {
        // Check if package.json exists
        const pkgJsonPath = `${nodeModulesPath}/package.json`;
        const pkgJson = JSON.parse(await vfs.readFile(pkgJsonPath));
        const mainFile = pkgJson.main || 'index.js';
        resolvedPath = `${nodeModulesPath}/${mainFile}`;
      } catch {
        // Fallback to index.js
        resolvedPath = `${nodeModulesPath}/index.js`;
      }
    }

    // Load the file
    try {
      const content = await vfs.readFile(resolvedPath);

      // Check if it's JSON
      if (resolvedPath.endsWith('.json')) {
        return JSON.parse(content);
      }

      // For .js files, we need to evaluate them
      // For now, return a placeholder that tells users to use dynamic import
      return {
        __foam_module: true,
        __path: resolvedPath,
        __help: `Module loaded from ${resolvedPath}. Use dynamic import() for ES modules.`
      };
    } catch (err) {
      throw new Error(`Cannot find module '${modulePath}': ${err.message}`);
    }
  }

  if (args.length === 0 || args[0] === '-e') {
    const code = args[0] === '-e' ? args.slice(1).join(' ') : (stdin || '');
    if (!code) { stderr('Usage: node -e "code" or node <file>\n'); return 1; }
    try {
      const logs = [];
      const sandbox = {
        console: {
          log: (...a) => logs.push(a.map(String).join(' ')),
          error: (...a) => logs.push(a.map(String).join(' ')),
          warn: (...a) => logs.push(a.map(String).join(' ')),
          info: (...a) => logs.push(a.map(String).join(' ')),
        },
        require: (mod) => {
          // Synchronous require is limited in browser, but we can handle JSON
          try {
            // For node_modules, try to load package.json
            const pkgPath = `node_modules/${mod}/package.json`;
            const pkgJson = vfs.readFileSync?.(pkgPath) || null;
            if (pkgJson) {
              stderr(`Note: require('${mod}') loaded package.json. Use dynamic import() for full module support.\n`);
              return JSON.parse(pkgJson);
            }
          } catch {}
          throw new Error(`Cannot require '${mod}' in browser context. Use: const mod = await import('https://esm.sh/${mod}')`);
        },
        process: {
          env: { ...vfs.env },
          cwd: () => vfs.cwd,
          exit: (code) => { throw { exitCode: code }; },
          argv: ['node', '-e', ...args.slice(1)],
          version: 'v20.0.0 (Foam)',
          platform: 'browser',
        },
        __dirname: vfs.cwd,
        __filename: '<eval>',
        global: globalThis,
        setTimeout, setInterval, clearTimeout, clearInterval,
        JSON, Math, Date, RegExp, Array, Object, String, Number, Boolean,
        Map, Set, Promise, Symbol, Error, parseInt, parseFloat, isNaN, isFinite,
        Buffer: {
          from: (str) => new TextEncoder().encode(str),
          toString: (buf) => new TextDecoder().decode(buf),
        },
      };
      const fn = new Function(...Object.keys(sandbox), code);
      const result = fn(...Object.values(sandbox));
      if (logs.length) stdout(logs.join('\n') + '\n');
      else if (result !== undefined) stdout(String(result) + '\n');
    } catch (err) {
      if (err.exitCode !== undefined) return err.exitCode;
      stderr(err.message + '\n');
      return 1;
    }
    return 0;
  }

  const file = args[0];
  try {
    const code = await vfs.readFile(file);
    return commands.node(['-e', code], { stdin, stdout, stderr, vfs });
  } catch (err) {
    stderr(err.message + '\n');
    return 1;
  }
};

// ─── NPX ────────────────────────────────────────────────────────────────────

commands.npx = async (args, { stdin, stdout, stderr, vfs }) => {
  if (args.length === 0) {
    stderr('Usage: npx <package>[@version] [args...]\n');
    stderr('       npx -e <code>  — execute inline JS with package imports\n');
    return 1;
  }

  // Handle -e flag for inline execution
  if (args[0] === '-e') {
    const code = args.slice(1).join(' ');
    if (!code) {
      stderr('npx -e: missing code to execute\n');
      return 1;
    }
    try {
      const result = await eval(`(async () => { ${code} })()`);
      if (result !== undefined) stdout(String(result) + '\n');
      return 0;
    } catch (err) {
      stderr(`npx: ${err.message}\n`);
      return 1;
    }
  }

  // Parse package name and version
  let pkgSpec = args[0];
  const restArgs = args.slice(1);
  let pkgName = pkgSpec;
  let version = 'latest';

  if (pkgSpec.includes('@') && !pkgSpec.startsWith('@')) {
    const parts = pkgSpec.split('@');
    pkgName = parts[0];
    version = parts[1] || 'latest';
  } else if (pkgSpec.startsWith('@')) {
    // Scoped package like @vitejs/plugin-react
    const parts = pkgSpec.split('@');
    if (parts.length > 2) {
      pkgName = '@' + parts[1];
      version = parts[2];
    } else {
      pkgName = pkgSpec;
    }
  }

  try {
    // Build the esm.sh URL
    const url = version === 'latest'
      ? `https://esm.sh/${pkgName}`
      : `https://esm.sh/${pkgName}@${version}`;

    stdout(`Running ${pkgName}@${version} from esm.sh...\n`);

    try {
      // Try to dynamically import the module
      const module = await import(url);

      // Create output handlers
      const logs = [];
      const outputCtx = {
        stdout: (txt) => logs.push(txt),
        stderr: (txt) => stderr(txt),
        vfs,
        args: restArgs,
      };

      // Try different execution patterns
      let executed = false;
      let result;

      // Pattern 1: default export is a function
      if (typeof module.default === 'function') {
        result = await module.default(...restArgs);
        executed = true;
      }
      // Pattern 2: has a cli/main/run function
      else if (typeof module.cli === 'function') {
        result = await module.cli(restArgs, outputCtx);
        executed = true;
      } else if (typeof module.main === 'function') {
        result = await module.main(restArgs, outputCtx);
        executed = true;
      } else if (typeof module.run === 'function') {
        result = await module.run(restArgs, outputCtx);
        executed = true;
      }

      // Output any captured logs
      if (logs.length) stdout(logs.join(''));

      // If we executed something, output the result
      if (executed) {
        if (result !== undefined && result !== null) {
          const output = typeof result === 'object'
            ? JSON.stringify(result, null, 2)
            : String(result);
          stdout(output + '\n');
        }
        return 0;
      }

      // Pattern 3: Module loaded but no CLI entry point - expose it for use
      stdout(`✓ Loaded ${pkgName}\n`);
      stdout(`Available exports: ${Object.keys(module).join(', ')}\n`);
      stdout(`Use 'npx -e "const {...} = await import(\"${url}\"); ..."' to use it\n`);
      return 0;

    } catch (importErr) {
      stderr(`npx: failed to load ${pkgName}: ${importErr.message}\n`);
      stderr(`Tip: Not all npm packages work in the browser\n`);
      return 1;
    }
  } catch (err) {
    stderr(`npx: ${err.message}\n`);
    return 1;
  }
};

// ─── PYTHON (Pyodide WASM) ──────────────────────────────────────────────────

let pyodide = null;

async function loadPyodide() {
  if (pyodide) return pyodide;

  try {
    // Load Pyodide from CDN
    const pyodideScript = document.createElement('script');
    pyodideScript.src = 'https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js';
    document.head.appendChild(pyodideScript);

    await new Promise((resolve, reject) => {
      pyodideScript.onload = resolve;
      pyodideScript.onerror = reject;
    });

    // Initialize Pyodide
    pyodide = await globalThis.loadPyodide({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.25.0/full/',
    });

    return pyodide;
  } catch (err) {
    throw new Error(`Failed to load Pyodide: ${err.message}`);
  }
}

commands.python = async (args, { stdin, stdout, stderr, vfs }) => {
  // Show help or version
  if (args.includes('--version') || args.includes('-V')) {
    stdout('Python 3.11.3 (Pyodide)\n');
    return 0;
  }

  if (args.includes('--help') || args.includes('-h')) {
    stdout('Usage: python [options] [-c cmd | file]\n');
    stdout('Options:\n');
    stdout('  -c cmd  : Execute Python command\n');
    stdout('  -m mod  : Run library module as script\n');
    stdout('  --version : Show Python version\n');
    return 0;
  }

  try {
    // Load Pyodide (async, first run will be slow)
    stdout('Loading Python (this may take a moment on first run)...\n');
    const py = await loadPyodide();

    // Handle -c flag (execute code)
    if (args[0] === '-c') {
      const code = args.slice(1).join(' ');
      if (!code) {
        stderr('python: -c requires code to execute\n');
        return 1;
      }

      try {
        // Redirect Python stdout/stderr
        py.runPython(`
import sys
from io import StringIO
sys.stdout = StringIO()
sys.stderr = StringIO()
`);

        // Run the code
        py.runPython(code);

        // Get output
        const pyStdout = py.runPython('sys.stdout.getvalue()');
        const pyStderr = py.runPython('sys.stderr.getvalue()');

        if (pyStdout) stdout(pyStdout);
        if (pyStderr) stderr(pyStderr);

        return 0;
      } catch (err) {
        stderr(`Python error: ${err.message}\n`);
        return 1;
      }
    }

    // Handle -m flag (run module)
    if (args[0] === '-m') {
      const module = args[1];
      if (!module) {
        stderr('python: -m requires module name\n');
        return 1;
      }

      // Special handling for common modules
      if (module === 'http.server') {
        stdout('python: http.server not supported in browser environment\n');
        return 1;
      }

      if (module === 'json.tool') {
        // JSON pretty-print from stdin
        if (!stdin) {
          stderr('python: no input provided\n');
          return 1;
        }
        try {
          const formatted = JSON.stringify(JSON.parse(stdin), null, 2);
          stdout(formatted + '\n');
          return 0;
        } catch (err) {
          stderr(`python: invalid JSON: ${err.message}\n`);
          return 1;
        }
      }

      try {
        py.runPython(`
import sys
from io import StringIO
sys.stdout = StringIO()
sys.stderr = StringIO()
`);

        py.runPython(`
import ${module}
${module}.main()
`);

        const pyStdout = py.runPython('sys.stdout.getvalue()');
        const pyStderr = py.runPython('sys.stderr.getvalue()');

        if (pyStdout) stdout(pyStdout);
        if (pyStderr) stderr(pyStderr);

        return 0;
      } catch (err) {
        stderr(`Python error: ${err.message}\n`);
        return 1;
      }
    }

    // Handle file execution
    if (args.length > 0 && !args[0].startsWith('-')) {
      const filename = args[0];
      try {
        const code = await vfs.readFile(filename);

        py.runPython(`
import sys
from io import StringIO
sys.stdout = StringIO()
sys.stderr = StringIO()
`);

        py.runPython(code);

        const pyStdout = py.runPython('sys.stdout.getvalue()');
        const pyStderr = py.runPython('sys.stderr.getvalue()');

        if (pyStdout) stdout(pyStdout);
        if (pyStderr) stderr(pyStderr);

        return 0;
      } catch (err) {
        stderr(`python: ${err.message}\n`);
        return 1;
      }
    }

    // No args - REPL mode (not supported in non-interactive context)
    stderr('python: interactive REPL not yet supported\n');
    stderr('Use: python -c "code" or python file.py\n');
    return 1;

  } catch (err) {
    stderr(`python: ${err.message}\n`);
    return 1;
  }
};

// Alias for python3
commands.python3 = commands.python;

// ─── PIP (Python package manager) ───────────────────────────────────────────

commands.pip = async (args, { stdout, stderr }) => {
  if (args.length === 0 || args[0] === '--help') {
    stdout('Usage: pip <command> [options]\n');
    stdout('\nCommands:\n');
    stdout('  install <package>  — Install a package using micropip\n');
    stdout('  list              — List installed packages\n');
    return 0;
  }

  try {
    const py = await loadPyodide();

    if (args[0] === 'install') {
      const packages = args.slice(1);
      if (packages.length === 0) {
        stderr('pip: install requires package name\n');
        return 1;
      }

      stdout(`Installing ${packages.join(', ')}...\n`);

      try {
        await py.loadPackage('micropip');
        for (const pkg of packages) {
          await py.runPythonAsync(`
import micropip
await micropip.install('${pkg}')
`);
        }
        stdout('Successfully installed packages\n');
        return 0;
      } catch (err) {
        stderr(`pip: installation failed: ${err.message}\n`);
        return 1;
      }
    }

    if (args[0] === 'list') {
      try {
        const result = py.runPython(`
import sys
import json
packages = []
if hasattr(sys, 'modules'):
    for name in sorted(sys.modules.keys()):
        if not name.startswith('_'):
            packages.append(name)
json.dumps(packages[:20])  # Limit to first 20
`);
        const packages = JSON.parse(result);
        stdout('Installed packages:\n');
        for (const pkg of packages) {
          stdout(`  ${pkg}\n`);
        }
        return 0;
      } catch (err) {
        stderr(`pip: ${err.message}\n`);
        return 1;
      }
    }

    stderr(`pip: unknown command '${args[0]}'\n`);
    return 1;

  } catch (err) {
    stderr(`pip: ${err.message}\n`);
    return 1;
  }
};

export default commands;
