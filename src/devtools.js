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

function parseGitRemoteArgs(args, vfs) {
  let remote = 'origin';
  let ref = '';
  const positional = [];
  for (let i = 1; i < args.length; i++) {
    if (!args[i].startsWith('-')) positional.push(args[i]);
  }
  if (positional.length >= 1) remote = positional[0];
  if (positional.length >= 2) ref = positional[1];

  const token = vfs.env['GITHUB_TOKEN']
    || (typeof localStorage !== 'undefined' ? localStorage.getItem('foam_github_token') || '' : '');
  const corsProxy = vfs.env['GIT_CORS_PROXY'] || 'https://cors.isomorphic-git.org';

  return { remote, ref, token, corsProxy };
}

commands.git = async (args, { stdout, stderr, vfs }) => {
  if (args.length === 0) {
    stdout('usage: git <command> [<args>]\n\nAvailable commands:\n  init, add, commit, status, log, diff, branch, checkout, clone\n  push, pull, fetch, remote, merge\n');
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
        await git.init({ fs, dir, defaultBranch: 'main' });
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
        let cloneUrl = subArgs[0];
        if (!cloneUrl) { stderr('error: must specify repository URL\n'); return 1; }
        // Normalize URL: add https:// if no protocol
        if (!cloneUrl.startsWith('http://') && !cloneUrl.startsWith('https://') && !cloneUrl.startsWith('git://')) {
          cloneUrl = 'https://' + cloneUrl;
        }
        const repoName = cloneUrl.split('/').pop()?.replace(/\.git$/, '') || 'repo';
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

        // For GitHub repos, use tarball API (CORS-friendly) as primary strategy
        const ghMatch = cloneUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
        let cloned = false;
        if (ghMatch) {
          const [, ghOwner, ghRepo] = ghMatch;
          try {
            stdout('Downloading via GitHub API...\n');
            const tarResp = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/tarball`, {
              headers: { 'Accept': 'application/vnd.github+json' },
              redirect: 'follow',
            });
            if (!tarResp.ok) throw new Error(`GitHub API: ${tarResp.status}`);
            const tarBuf = await tarResp.arrayBuffer();
            const ds = new DecompressionStream('gzip');
            const dsWriter = ds.writable.getWriter();
            dsWriter.write(new Uint8Array(tarBuf));
            dsWriter.close();
            const decompressed = new Uint8Array(await new Response(ds.readable).arrayBuffer());
            // Extract tar entries
            let tOff = 0;
            while (tOff + 512 <= decompressed.length) {
              const hdr = decompressed.slice(tOff, tOff + 512);
              if (hdr.every(b => b === 0)) break;
              let tName = '';
              for (let i = 0; i < 100 && hdr[i] !== 0; i++) tName += String.fromCharCode(hdr[i]);
              let tPrefix = '';
              for (let i = 345; i < 500 && hdr[i] !== 0; i++) tPrefix += String.fromCharCode(hdr[i]);
              if (tPrefix) tName = tPrefix + '/' + tName;
              let tSizeStr = '';
              for (let i = 124; i < 136 && hdr[i] !== 0; i++) tSizeStr += String.fromCharCode(hdr[i]);
              const tSize = parseInt(tSizeStr.trim(), 8) || 0;
              const tType = String.fromCharCode(hdr[156]);
              tOff += 512;
              const tParts = tName.split('/');
              const tRel = tParts.slice(1).join('/');
              if (tRel && (tType === '0' || (tType === '\0' && tSize > 0))) {
                const fPath = vfs.resolvePath(tRel, targetDir);
                const fDir = fPath.substring(0, fPath.lastIndexOf('/'));
                if (fDir) await vfs.mkdir(fDir, { recursive: true });
                await vfs.writeFile(fPath, new TextDecoder().decode(decompressed.slice(tOff, tOff + tSize)));
              } else if (tRel && tType === '5') {
                await vfs.mkdir(vfs.resolvePath(tRel, targetDir), { recursive: true });
              }
              tOff += Math.ceil(tSize / 512) * 512;
            }
            await git.init({ fs, dir: targetDir, defaultBranch: 'main' });
            const clFiles = await listAllFiles(vfs, targetDir, targetDir);
            for (const cf of clFiles) await git.add({ fs, dir: targetDir, filepath: cf });
            await git.commit({
              fs, dir: targetDir,
              message: `Clone of ${ghOwner}/${ghRepo}`,
              author: { name: vfs.env.USER || 'user', email: 'user@foam.local' },
            });
            cloned = true;
          } catch (ghErr) {
            stdout(`GitHub API failed (${ghErr.message}), trying git protocol...\n`);
          }
        }

        if (!cloned) {
          const corsProxy = vfs.env.GIT_CORS_PROXY || 'https://cors.isomorphic-git.org';
          const cloneWithTimeout = (proxy) => {
            return Promise.race([
              git.clone({
                fs, http, dir: targetDir, url: cloneUrl,
                corsProxy: proxy,
                singleBranch: true,
                depth: 1,
              }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('clone timed out')), 30000)
              ),
            ]);
          };
          await cloneWithTimeout(corsProxy);
        }

        stdout('done.\n');
        break;
      }

      case 'remote': {
        const remoteSub = args[1];
        if (!remoteSub || remoteSub === '-v') {
          const remotes = await git.listRemotes({ fs: fs, dir });
          for (const r of remotes) {
            if (remoteSub === '-v') {
              stdout(`${r.remote}\t${r.url} (fetch)\n`);
              stdout(`${r.remote}\t${r.url} (push)\n`);
            } else {
              stdout(`${r.remote}\n`);
            }
          }
        } else if (remoteSub === 'add') {
          const name = args[2], url = args[3];
          if (!name || !url) { stderr('usage: git remote add <name> <url>\n'); return 1; }
          await git.addRemote({ fs: fs, dir, remote: name, url });
        } else if (remoteSub === 'remove' || remoteSub === 'rm') {
          const name = args[2];
          if (!name) { stderr('usage: git remote remove <name>\n'); return 1; }
          await git.deleteRemote({ fs: fs, dir, remote: name });
        } else {
          stderr(`git remote: '${remoteSub}' is not a valid subcommand\n`);
          return 1;
        }
        break;
      }

      case 'push': {
        const { remote, ref, token, corsProxy } = parseGitRemoteArgs(args, vfs);
        if (!token) {
          stderr('error: authentication required\nSet GITHUB_TOKEN or run: export GITHUB_TOKEN=ghp_...\n');
          return 1;
        }
        const currentBranch = ref || await git.currentBranch({ fs: fs, dir }) || 'main';
        stdout(`Pushing to ${remote}/${currentBranch}...\n`);
        await git.push({
          fs: fs, http, dir,
          remote,
          ref: currentBranch,
          corsProxy,
          onAuth: () => ({ username: token }),
        });
        stdout('done.\n');
        break;
      }

      case 'fetch': {
        const { remote, token, corsProxy } = parseGitRemoteArgs(args, vfs);
        if (!token) {
          stderr('error: authentication required\nSet GITHUB_TOKEN or run: export GITHUB_TOKEN=ghp_...\n');
          return 1;
        }
        stdout(`Fetching from ${remote}...\n`);
        await git.fetch({
          fs: fs, http, dir,
          remote,
          corsProxy,
          onAuth: () => ({ username: token }),
        });
        stdout('done.\n');
        break;
      }

      case 'pull': {
        const { remote, ref, token, corsProxy } = parseGitRemoteArgs(args, vfs);
        if (!token) {
          stderr('error: authentication required\nSet GITHUB_TOKEN or run: export GITHUB_TOKEN=ghp_...\n');
          return 1;
        }
        const currentBranch = ref || await git.currentBranch({ fs: fs, dir }) || 'main';
        stdout(`Pulling from ${remote}/${currentBranch}...\n`);
        await git.pull({
          fs: fs, http, dir,
          remote,
          ref: currentBranch,
          corsProxy,
          singleBranch: true,
          author: { name: vfs.env.USER || 'user', email: 'user@foam.local' },
          onAuth: () => ({ username: token }),
        });
        stdout('done.\n');
        break;
      }

      case 'merge': {
        const theirs = args[1];
        if (!theirs) { stderr('usage: git merge <branch>\n'); return 1; }
        const mergeResult = await git.merge({
          fs: fs, dir,
          ours: await git.currentBranch({ fs: fs, dir }) || 'main',
          theirs,
          author: { name: vfs.env.USER || 'user', email: 'user@foam.local' },
        });
        if (mergeResult.alreadyMerged) {
          stdout('Already up to date.\n');
        } else if (mergeResult.fastForward) {
          stdout(`Fast-forward merge to ${mergeResult.oid?.slice(0, 7)}\n`);
        } else {
          stdout(`Merge made by the 'recursive' strategy. ${mergeResult.oid?.slice(0, 7)}\n`);
        }
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

  // npm lifecycle aliases: test, start, stop, restart → npm run <name>
  if (sub === 'test' || sub === 't' || sub === 'start' || sub === 'stop' || sub === 'restart') {
    return commands.npm(['run', sub, ...args.slice(1)], { stdout, stderr, vfs, exec });
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
  // File content cache for synchronous access (pre-loaded from VFS)
  const fileCache = new Map();

  // Module cache to prevent circular dependencies and duplicate loading
  const moduleCache = new Map();

  // Helper to pre-load file into cache
  async function cacheFile(path) {
    try {
      const content = await vfs.readFile(path);
      fileCache.set(path, content);
      return content;
    } catch {
      return null;
    }
  }

  // Helper to resolve module path
  async function resolveModulePath(modulePath, fromDir) {
    let resolvedPath = modulePath;

    // Check if it's a relative/absolute path
    if (modulePath.startsWith('./') || modulePath.startsWith('../') || modulePath.startsWith('/')) {
      // Resolve relative to fromDir
      resolvedPath = vfs.resolvePath(modulePath, fromDir);
    } else {
      // Try to load from node_modules (use absolute path)
      const nmBase = fromDir && fromDir.startsWith('/') ? fromDir : vfs.cwd;
      const nodeModulesPath = `${nmBase}/node_modules/${modulePath}`;

      // Check if package.json exists
      try {
        const pkgJsonPath = `${nodeModulesPath}/package.json`;
        let pkgJson = fileCache.get(pkgJsonPath);
        if (!pkgJson) {
          pkgJson = await cacheFile(pkgJsonPath);
        }
        if (pkgJson) {
          const pkg = JSON.parse(pkgJson);
          const mainFile = pkg.main || 'index.js';
          resolvedPath = `${nodeModulesPath}/${mainFile}`;
        } else {
          resolvedPath = `${nodeModulesPath}/index.js`;
        }
      } catch {
        // Fallback to index.js
        resolvedPath = `${nodeModulesPath}/index.js`;
      }
    }

    // Add .js extension if missing
    if (!resolvedPath.endsWith('.js') && !resolvedPath.endsWith('.json')) {
      // Try with .js extension
      if (await cacheFile(resolvedPath + '.js')) {
        resolvedPath += '.js';
      } else if (await cacheFile(resolvedPath + '/index.js')) {
        // Try as directory with index.js
        resolvedPath += '/index.js';
      }
    }

    // Ensure file is cached
    if (!fileCache.has(resolvedPath)) {
      await cacheFile(resolvedPath);
    }

    return resolvedPath;
  }

  // Helper to load and execute a CommonJS module (synchronous after pre-caching)
  // Built-in Node.js module shims
  function getBuiltinModule(name) {
    switch (name) {
      case 'path':
      case 'node:path': return {
        join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
        resolve: (...parts) => {
          let p = parts.reduce((a, b) => b.startsWith('/') ? b : a + '/' + b);
          return vfs.resolvePath(p);
        },
        dirname: (p) => p.substring(0, p.lastIndexOf('/')) || '/',
        basename: (p, ext) => { const base = p.split('/').pop() || ''; return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base; },
        extname: (p) => { const m = p.match(/\.[^./]+$/); return m ? m[0] : ''; },
        isAbsolute: (p) => p.startsWith('/'),
        normalize: (p) => vfs.resolvePath(p),
        relative: (from, to) => {
          const f = from.split('/').filter(Boolean), t = to.split('/').filter(Boolean);
          let i = 0; while (i < f.length && i < t.length && f[i] === t[i]) i++;
          return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/') || '.';
        },
        sep: '/', delimiter: ':',
        parse: (p) => ({ root: p.startsWith('/') ? '/' : '', dir: p.substring(0, p.lastIndexOf('/')), base: p.split('/').pop() || '', ext: (p.match(/\.[^./]+$/) || [''])[0], name: (p.split('/').pop() || '').replace(/\.[^.]+$/, '') }),
        format: (obj) => (obj.dir ? obj.dir + '/' : '') + (obj.base || obj.name + (obj.ext || '')),
      };
      case 'fs':
      case 'node:fs': {
        const _r = (p) => vfs.resolvePath(typeof p === 'string' ? p : String(p));
        const _readSync = (p, opts) => {
          const resolved = _r(p);
          const cached = fileCache.get(resolved) ?? fileCache.get(resolved + '.js');
          if (cached !== undefined) return cached;
          throw new Error(`ENOENT: no such file or directory, open '${p}'`);
        };
        const _existsSync = (p) => {
          const resolved = _r(p);
          return fileCache.has(resolved) || fileCache.has(resolved + '.js') || fileCache.has(resolved + '/index.js');
        };
        const _statSync = (p) => {
          const resolved = _r(p);
          const isFile = fileCache.has(resolved);
          const isDir = [...fileCache.keys()].some(k => k.startsWith(resolved + '/'));
          if (!isFile && !isDir) throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
          return { isFile: () => isFile, isDirectory: () => isDir && !isFile, isSymbolicLink: () => false, size: isFile ? (fileCache.get(resolved) || '').length : 0, mtime: new Date(), mode: 0o644 };
        };
        const _readdirSync = (p, opts) => {
          const resolved = _r(p);
          const prefix = resolved === '/' ? '/' : resolved + '/';
          const entries = new Set();
          for (const key of fileCache.keys()) { if (key.startsWith(prefix)) { const first = key.slice(prefix.length).split('/')[0]; if (first) entries.add(first); } }
          const names = [...entries].sort();
          if (opts && opts.withFileTypes) {
            return names.map(name => {
              const full = resolved + '/' + name;
              const isDir = [...fileCache.keys()].some(k => k.startsWith(full + '/'));
              return { name, isFile: () => !isDir, isDirectory: () => isDir, isSymbolicLink: () => false };
            });
          }
          return names;
        };
        const _writeSync = (p, data) => {
          const resolved = _r(p);
          const content = typeof data === 'string' ? data : String(data);
          fileCache.set(resolved, content);
          vfs.writeFile(resolved, content); // fire-and-forget async
        };
        const _mkdirSync = (p, opts) => { vfs.mkdir(_r(p), opts); };
        const _unlinkSync = (p) => { fileCache.delete(_r(p)); vfs.unlink(_r(p)); };
        const _appendSync = (p, data) => {
          const resolved = _r(p);
          const content = (fileCache.get(resolved) || '') + (typeof data === 'string' ? data : String(data));
          fileCache.set(resolved, content);
          vfs.writeFile(resolved, content);
        };
        const fsShim = {
          readFileSync: _readSync,
          writeFileSync: _writeSync,
          existsSync: _existsSync,
          statSync: _statSync,
          lstatSync: _statSync,
          readdirSync: _readdirSync,
          mkdirSync: _mkdirSync,
          unlinkSync: _unlinkSync,
          appendFileSync: _appendSync,
          copyFileSync: (src, dest) => _writeSync(dest, _readSync(src, 'utf8')),
          renameSync: (o, n) => { vfs.rename(_r(o), _r(n)); },
          rmdirSync: (p) => { vfs.rmdir(_r(p), { recursive: true }); },
          rmSync: (p, opts) => { if (opts && opts.recursive) vfs.rmdir(_r(p), { recursive: true }); else _unlinkSync(p); },
          chmodSync: () => {},
          accessSync: (p) => { if (!_existsSync(p)) throw new Error(`ENOENT: no such file or directory, access '${p}'`); },
          constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
          // Callback-style methods
          readFile: (p, opts, cb) => { if (typeof opts === 'function') { cb = opts; opts = undefined; } try { cb(null, _readSync(p, opts)); } catch (e) { cb(e); } },
          writeFile: (p, data, opts, cb) => { if (typeof opts === 'function') { cb = opts; } try { _writeSync(p, data); if (cb) cb(null); } catch (e) { if (cb) cb(e); } },
          stat: (p, cb) => { try { cb(null, _statSync(p)); } catch (e) { cb(e); } },
          lstat: (p, cb) => { try { cb(null, _statSync(p)); } catch (e) { cb(e); } },
          readdir: (p, opts, cb) => { if (typeof opts === 'function') { cb = opts; opts = undefined; } try { cb(null, _readdirSync(p, opts)); } catch (e) { cb(e); } },
          exists: (p, cb) => { cb(_existsSync(p)); },
          mkdir: (p, opts, cb) => { if (typeof opts === 'function') { cb = opts; opts = undefined; } vfs.mkdir(_r(p), opts).then(() => cb && cb(null)).catch(e => cb && cb(e)); },
          unlink: (p, cb) => { vfs.unlink(_r(p)).then(() => cb && cb(null)).catch(e => cb && cb(e)); },
          createReadStream: (p) => {
            const content = _readSync(p, 'utf8');
            const handlers = {};
            const stream = { on: (ev, fn) => { handlers[ev] = fn; return stream; }, pipe: (d) => d };
            setTimeout(() => { if (handlers.data) handlers.data(content); if (handlers.end) handlers.end(); }, 0);
            return stream;
          },
          createWriteStream: (p) => {
            let buf = '';
            return { write: (d) => { buf += d; return true; }, end: (d) => { if (d) buf += d; _writeSync(p, buf); }, on: () => ({}) };
          },
          promises: {
            readFile: async (p, opts) => await vfs.readFile(_r(p)),
            writeFile: async (p, data) => await vfs.writeFile(_r(p), typeof data === 'string' ? data : String(data)),
            readdir: async (p, opts) => {
              const entries = await vfs.readdir(_r(p));
              if (opts && opts.withFileTypes) return entries.map(e => ({ name: e.name, isFile: () => e.type === 'file', isDirectory: () => e.type === 'dir', isSymbolicLink: () => false }));
              return entries.map(e => e.name);
            },
            stat: async (p) => { const s = await vfs.stat(_r(p)); return { isFile: () => s.type === 'file', isDirectory: () => s.type === 'dir', isSymbolicLink: () => false, size: s.size, mtime: new Date(s.mtime) }; },
            lstat: async (p) => { const s = await vfs.stat(_r(p)); return { isFile: () => s.type === 'file', isDirectory: () => s.type === 'dir', isSymbolicLink: () => false, size: s.size, mtime: new Date(s.mtime) }; },
            mkdir: async (p, opts) => await vfs.mkdir(_r(p), opts),
            unlink: async (p) => await vfs.unlink(_r(p)),
            rm: async (p, opts) => { if (opts && opts.recursive) await vfs.rmdir(_r(p), { recursive: true }); else await vfs.unlink(_r(p)); },
            access: async (p) => { if (!(await vfs.exists(_r(p)))) throw new Error(`ENOENT: ${p}`); },
            rename: async (o, n) => await vfs.rename(_r(o), _r(n)),
            copyFile: async (s, d) => { const c = await vfs.readFile(_r(s)); await vfs.writeFile(_r(d), c); },
            appendFile: async (p, data) => { const old = await vfs.readFile(_r(p)).catch(() => ''); await vfs.writeFile(_r(p), old + data); },
          },
        };
        return fsShim;
      }
      case 'child_process':
      case 'node:child_process': {
        const _shell = globalThis.__foam && globalThis.__foam.shell;
        return {
          execSync: (cmd, opts) => {
            // Browser can't truly block. Use cached result pattern for simple cases.
            if (!_shell) throw new Error('child_process: shell not available');
            // Return empty string synchronously, queue the real exec
            // Most Node.js test runners use async exec() instead
            let result = '';
            _shell.exec(typeof cmd === 'string' ? cmd : cmd.join(' ')).then(r => { result = r.stdout; });
            return result;
          },
          exec: (cmd, opts, cb) => {
            if (typeof opts === 'function') { cb = opts; opts = {}; }
            if (!_shell) { if (cb) cb(new Error('child_process: shell not available')); return; }
            _shell.exec(typeof cmd === 'string' ? cmd : cmd.join(' ')).then(r => {
              if (r.exitCode !== 0) {
                const err = new Error(`Command failed: ${cmd}`);
                err.code = r.exitCode; err.stderr = r.stderr;
                if (cb) cb(err, r.stdout, r.stderr);
              } else {
                if (cb) cb(null, r.stdout, r.stderr);
              }
            }).catch(e => { if (cb) cb(e); });
          },
          spawnSync: (cmd, spawnArgs) => {
            return { stdout: '', stderr: '', status: 0, error: null };
          },
          spawn: (cmd, spawnArgs, opts) => {
            const fullCmd = [cmd, ...(spawnArgs || [])].join(' ');
            const handlers = {};
            const child = {
              on: (ev, fn) => { handlers[ev] = fn; return child; },
              stdout: { on: (ev, fn) => { if (ev === 'data') handlers._stdoutData = fn; return child.stdout; }, pipe: () => child.stdout },
              stderr: { on: (ev, fn) => { if (ev === 'data') handlers._stderrData = fn; return child.stderr; }, pipe: () => child.stderr },
              stdin: { write: () => {}, end: () => {} },
              pid: Math.floor(Math.random() * 10000),
              kill: () => {},
            };
            if (_shell) {
              _shell.exec(fullCmd).then(r => {
                if (handlers._stdoutData && r.stdout) handlers._stdoutData(r.stdout);
                if (handlers._stderrData && r.stderr) handlers._stderrData(r.stderr);
                if (handlers.close) handlers.close(r.exitCode);
                if (handlers.exit) handlers.exit(r.exitCode);
              }).catch(e => { if (handlers.error) handlers.error(e); });
            }
            return child;
          },
        };
      }
      case 'os':
      case 'node:os': return {
        platform: () => 'linux', arch: () => 'x64', homedir: () => vfs.env.HOME || '/home/user',
        tmpdir: () => '/tmp', hostname: () => 'foam', type: () => 'Linux', release: () => '5.15.0-foam',
        cpus: () => [{ model: 'Virtual CPU', speed: 2400 }], totalmem: () => 1073741824, freemem: () => 536870912, EOL: '\n',
        endianness: () => 'LE',
        userInfo: () => ({ username: vfs.env.USER || 'user', homedir: vfs.env.HOME || '/home/user', shell: '/bin/sh', uid: 1000, gid: 1000 }),
        networkInterfaces: () => ({}),
      };
      case 'util':
      case 'node:util': return {
        promisify: (fn) => (...args) => new Promise((res, rej) => fn(...args, (err, r) => err ? rej(err) : res(r))),
        inspect: (obj) => JSON.stringify(obj, null, 2),
        format: (...args) => args.map(String).join(' '),
        types: { isDate: (v) => v instanceof Date, isRegExp: (v) => v instanceof RegExp },
      };
      case 'events':
      case 'node:events': {
        class EventEmitter {
          constructor() { this._events = {}; this._maxListeners = 10; }
          on(e, fn) { (this._events[e] ??= []).push(fn); return this; }
          off(e, fn) { this._events[e] = (this._events[e] || []).filter(f => f !== fn); return this; }
          emit(e, ...args) { (this._events[e] || []).forEach(fn => fn(...args)); return !!(this._events[e] && this._events[e].length); }
          once(e, fn) { const w = (...a) => { this.off(e, w); fn(...a); }; return this.on(e, w); }
          addListener(e, fn) { return this.on(e, fn); }
          removeListener(e, fn) { return this.off(e, fn); }
          removeAllListeners(e) { if (e) delete this._events[e]; else this._events = {}; return this; }
          listeners(e) { return [...(this._events[e] || [])]; }
          listenerCount(e) { return (this._events[e] || []).length; }
          eventNames() { return Object.keys(this._events); }
          setMaxListeners(n) { this._maxListeners = n; return this; }
          getMaxListeners() { return this._maxListeners; }
          prependListener(e, fn) { (this._events[e] ??= []).unshift(fn); return this; }
        }
        EventEmitter.EventEmitter = EventEmitter;
        return EventEmitter;
      }
      case 'url':
      case 'node:url': return { URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams, parse: (s) => new URL(s), format: (o) => String(o) };
      case 'assert':
      case 'node:assert': {
        const assert = (val, msg) => { if (!val) throw new Error(msg || `AssertionError: ${val}`); };
        assert.ok = assert;
        assert.equal = (a, b, msg) => { if (a != b) throw new Error(msg || `AssertionError: ${a} != ${b}`); };
        assert.strictEqual = (a, b, msg) => { if (a !== b) throw new Error(msg || `AssertionError: ${a} !== ${b}`); };
        assert.deepEqual = assert.deepStrictEqual = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || 'AssertionError: deep equal failed'); };
        assert.notStrictEqual = (a, b, msg) => { if (a === b) throw new Error(msg || `AssertionError: ${a} === ${b}`); };
        assert.notEqual = (a, b, msg) => { if (a == b) throw new Error(msg || `AssertionError: ${a} == ${b}`); };
        assert.throws = (fn, expected, msg) => {
          if (typeof expected === 'string') { msg = expected; expected = undefined; }
          let threw = false;
          try { fn(); } catch (e) {
            threw = true;
            if (expected instanceof RegExp && !expected.test(e.message)) throw new Error(msg || `Expected error matching ${expected}`);
            if (typeof expected === 'function' && !(e instanceof expected)) throw new Error(msg || 'Wrong error type');
          }
          if (!threw) throw new Error(msg || 'Expected function to throw');
        };
        assert.doesNotThrow = (fn, msg) => { try { fn(); } catch (e) { throw new Error(msg || `Got unexpected error: ${e.message}`); } };
        assert.fail = (msg) => { throw new Error(typeof msg === 'string' ? msg : 'AssertionError: assert.fail()'); };
        assert.ifError = (val) => { if (val) throw val; };
        assert.match = (str, re, msg) => { if (!re.test(str)) throw new Error(msg || `AssertionError: ${str} does not match ${re}`); };
        assert.rejects = async (fn, expected, msg) => { try { await (typeof fn === 'function' ? fn() : fn); throw new Error(msg || 'Expected rejection'); } catch (e) { if (e.message === (msg || 'Expected rejection')) throw e; } };
        return assert;
      }
      case 'stream':
      case 'node:stream': {
        class Stream { pipe(dest) { return dest; } on() { return this; } once() { return this; } emit() { return this; } }
        class Readable extends Stream { read() { return null; } push() {} setEncoding() { return this; } resume() { return this; } pause() { return this; } }
        class Writable extends Stream { write() { return true; } end() {} cork() {} uncork() {} }
        class Transform extends Stream { write() { return true; } end() {} push() {} _transform() {} }
        class Duplex extends Stream { write() { return true; } end() {} read() { return null; } push() {} }
        class PassThrough extends Transform {}
        Stream.Readable = Readable; Stream.Writable = Writable; Stream.Transform = Transform;
        Stream.Duplex = Duplex; Stream.PassThrough = PassThrough; Stream.Stream = Stream;
        return Stream;
      }
      case 'buffer':
      case 'node:buffer': {
        const B = {
          from: (data, encoding) => {
            if (typeof data === 'string') return new TextEncoder().encode(data);
            if (data instanceof Uint8Array) return data;
            return new Uint8Array(data || []);
          },
          alloc: (size, fill) => { const b = new Uint8Array(size); if (fill) b.fill(typeof fill === 'number' ? fill : 0); return b; },
          allocUnsafe: (size) => new Uint8Array(size),
          isBuffer: (obj) => obj instanceof Uint8Array,
          concat: (list, totalLength) => {
            const total = totalLength || list.reduce((s, b) => s + b.length, 0);
            const result = new Uint8Array(total);
            let offset = 0;
            for (const b of list) { result.set(b, offset); offset += b.length; }
            return result;
          },
          byteLength: (str) => new TextEncoder().encode(str).length,
        };
        return { Buffer: B };
      }
      case 'crypto':
      case 'node:crypto': return {
        randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
        randomUUID: () => globalThis.crypto.randomUUID(),
        createHash: (alg) => {
          let data = '';
          const h = {
            update: (d) => { data += (typeof d === 'string' ? d : String(d)); return h; },
            digest: (enc) => {
              let hash = 0;
              for (let i = 0; i < data.length; i++) { hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0; }
              return (hash >>> 0).toString(16).padStart(8, '0');
            },
          };
          return h;
        },
        createHmac: (alg, key) => {
          let data = '';
          const h = {
            update: (d) => { data += d; return h; },
            digest: (enc) => { let hash = 0; for (let i = 0; i < (key + data).length; i++) { hash = ((hash << 5) - hash + (key + data).charCodeAt(i)) | 0; } return (hash >>> 0).toString(16).padStart(8, '0'); },
          };
          return h;
        },
      };
      case 'querystring':
      case 'node:querystring': return {
        parse: (str) => Object.fromEntries(new URLSearchParams(str)),
        stringify: (obj) => new URLSearchParams(obj).toString(),
        escape: (str) => encodeURIComponent(str),
        unescape: (str) => decodeURIComponent(str),
      };
      case 'string_decoder':
      case 'node:string_decoder': {
        class StringDecoder {
          constructor(encoding) { this.encoding = encoding || 'utf8'; this.decoder = new TextDecoder(this.encoding); }
          write(buf) { return this.decoder.decode(buf, { stream: true }); }
          end(buf) { return buf ? this.decoder.decode(buf) : ''; }
        }
        return { StringDecoder };
      }
      case 'http':
      case 'node:http':
      case 'https':
      case 'node:https':
        return {
          request: () => { throw new Error(`${name}: use fetch() instead in Foam`); },
          get: () => { throw new Error(`${name}: use fetch() instead in Foam`); },
          createServer: () => { throw new Error(`${name}: servers not supported in Foam`); },
          Agent: class {},
          STATUS_CODES: { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved', 302: 'Found', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' },
        };
      case 'zlib':
      case 'node:zlib':
        return {
          gzipSync: (data) => data,
          gunzipSync: (data) => data,
          deflateSync: (data) => data,
          inflateSync: (data) => data,
          createGzip: () => ({ on: () => ({}), pipe: (d) => d }),
          createGunzip: () => ({ on: () => ({}), pipe: (d) => d }),
        };
      case 'tty':
      case 'node:tty':
        return {
          isatty: () => true,
          ReadStream: class { constructor() { this.isTTY = true; this.columns = 80; this.rows = 24; } on() { return this; } },
          WriteStream: class { constructor() { this.isTTY = true; this.columns = 80; this.rows = 24; } on() { return this; } write() {} },
        };
      default: return null;
    }
  }

  function requireModule(modulePath, fromDir = vfs.cwd) {
    // Check built-in modules first
    const builtin = getBuiltinModule(modulePath);
    if (builtin !== null) return builtin;

    // For synchronous operation, we do simpler resolution
    let resolvedPath = modulePath;

    if (modulePath.startsWith('./') || modulePath.startsWith('../') || modulePath.startsWith('/')) {
      resolvedPath = vfs.resolvePath(modulePath, fromDir);
      if (!resolvedPath.endsWith('.js') && !resolvedPath.endsWith('.json')) {
        if (fileCache.has(resolvedPath + '.js')) {
          resolvedPath += '.js';
        } else if (fileCache.has(resolvedPath + '/index.js')) {
          resolvedPath += '/index.js';
        }
      }
    } else {
      // Build absolute node_modules path from fromDir
      const nmBase = fromDir.startsWith('/') ? fromDir : vfs.resolvePath(fromDir);
      const nodeModulesPath = `${nmBase}/node_modules/${modulePath}`;
      const pkgJsonPath = `${nodeModulesPath}/package.json`;

      if (fileCache.has(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(fileCache.get(pkgJsonPath));
          let mainFile = pkg.main || 'index.js';
          // Normalize: strip leading ./, ensure .js extension
          mainFile = mainFile.replace(/^\.\//, '');
          if (!mainFile.endsWith('.js') && !mainFile.endsWith('.json')) {
            mainFile += '.js';
          }
          resolvedPath = `${nodeModulesPath}/${mainFile}`;
        } catch {
          resolvedPath = `${nodeModulesPath}/index.js`;
        }
      } else {
        resolvedPath = `${nodeModulesPath}/index.js`;
      }
    }

    // Check cache first
    if (moduleCache.has(resolvedPath)) {
      return moduleCache.get(resolvedPath).exports;
    }

    // Load the file content from cache
    const content = fileCache.get(resolvedPath);
    if (!content && content !== '') {
      throw new Error(`Cannot find module '${modulePath}' (resolved to '${resolvedPath}')`);
    }

    // Handle JSON files
    if (resolvedPath.endsWith('.json')) {
      const jsonExports = JSON.parse(content);
      moduleCache.set(resolvedPath, { exports: jsonExports });
      return jsonExports;
    }

    // Create module object
    const module = { exports: {} };
    const exports = module.exports;

    // Add to cache before execution (to handle circular dependencies)
    moduleCache.set(resolvedPath, module);

    // Get module directory for nested requires
    const moduleDir = resolvedPath.substring(0, resolvedPath.lastIndexOf('/')) || vfs.cwd;

    // Create nested require function
    const nestedRequire = (nestedPath) => requireModule(nestedPath, moduleDir);

    // Wrap code in CommonJS wrapper (like Node.js does)
    try {
      const wrappedCode = `(function(module, exports, require, __filename, __dirname, console, process, global, setTimeout, setInterval, clearTimeout, clearInterval, JSON, Math, Date, RegExp, Array, Object, String, Number, Boolean, Map, Set, Promise, Symbol, Error, parseInt, parseFloat, isNaN, isFinite, Buffer) {
${content}
})`;

      const moduleFunction = eval(wrappedCode);
      moduleFunction(
        module, exports, nestedRequire, resolvedPath, moduleDir,
        console, // Use real console for modules
        {
          env: { ...vfs.env },
          cwd: () => vfs.cwd,
          exit: (code) => { throw { exitCode: code }; },
          argv: ['node', resolvedPath],
          version: 'v20.0.0 (Foam)',
          platform: 'browser',
        },
        globalThis,
        setTimeout, setInterval, clearTimeout, clearInterval,
        JSON, Math, Date, RegExp, Array, Object, String, Number, Boolean,
        Map, Set, Promise, Symbol, Error, parseInt, parseFloat, isNaN, isFinite,
        {
          from: (str) => new TextEncoder().encode(str),
          toString: (buf) => new TextDecoder().decode(buf),
        }
      );
    } catch (err) {
      // Remove from cache on error
      moduleCache.delete(resolvedPath);
      throw err;
    }

    return module.exports;
  }

  // Pre-load node_modules into fileCache so synchronous require() works
  async function preloadNodeModules(dir) {
    const nmPath = dir + '/node_modules';
    try {
      const entries = await vfs.readdir(nmPath);
      for (const entry of entries) {
        if (entry.type === 'dir') {
          await preloadPackage(nmPath + '/' + entry.name);
        }
      }
    } catch { /* no node_modules */ }
  }

  async function preloadPackage(pkgDir) {
    // Load package.json first
    try {
      await cacheFile(pkgDir + '/package.json');
    } catch { /* ok */ }
    // Load all .js and .json files recursively
    try {
      const entries = await vfs.readdir(pkgDir);
      for (const entry of entries) {
        const fullPath = pkgDir + '/' + entry.name;
        if (entry.type === 'dir' && entry.name !== 'node_modules') {
          await preloadPackage(fullPath);
        } else if (entry.name.endsWith('.js') || entry.name.endsWith('.json')) {
          await cacheFile(fullPath);
        }
      }
    } catch { /* ok */ }
  }

  if (args.length === 0 || args[0] === '-e') {
    const code = args[0] === '-e' ? args.slice(1).join(' ') : (stdin || '');
    if (!code) { stderr('Usage: node -e "code" or node <file>\n'); return 1; }
    // Pre-load project files and node_modules so require() works synchronously
    await preloadPackage(vfs.cwd);
    await preloadNodeModules(vfs.cwd);
    try {
      const logs = [];
      const sandbox = {
        console: {
          log: (...a) => logs.push(a.map(String).join(' ')),
          error: (...a) => logs.push(a.map(String).join(' ')),
          warn: (...a) => logs.push(a.map(String).join(' ')),
          info: (...a) => logs.push(a.map(String).join(' ')),
        },
        require: (mod) => requireModule(mod, vfs.cwd),
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

// ─── BUILD (esbuild-wasm) ───────────────────────────────────────────────────

let esbuildInitialized = false;
let esbuildInitPromise = null;
let esbuildModule = null;

async function ensureEsbuild() {
  if (esbuildInitialized) return esbuildModule;
  if (esbuildInitPromise) { await esbuildInitPromise; return esbuildModule; }

  esbuildInitPromise = (async () => {
    try {
      const mod = await import('https://esm.sh/esbuild-wasm@0.27.2');
      // esm.sh may put exports on .default or as named exports
      esbuildModule = (mod.default && typeof mod.default.initialize === 'function') ? mod.default : mod;
      if (typeof esbuildModule.initialize !== 'function') {
        throw new Error('esbuild module does not expose initialize()');
      }
      await esbuildModule.initialize({
        wasmURL: 'https://unpkg.com/esbuild-wasm@0.27.2/esbuild.wasm',
        worker: false,
      });
      esbuildInitialized = true;
    } catch (e) {
      esbuildInitPromise = null;
      throw new Error(`Failed to initialize esbuild: ${e.message}`);
    }
  })();

  await esbuildInitPromise;
  return esbuildModule;
}

function createFoamFSPlugin(vfs) {
  return {
    name: 'foam-virtual-fs',
    setup(build) {
      // Resolve imports
      build.onResolve({ filter: /.*/ }, async (args) => {
        // Bare specifiers -> node_modules
        if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
          const candidates = [
            `node_modules/${args.path}/package.json`,
            `node_modules/${args.path}/index.js`,
            `node_modules/${args.path}/index.ts`,
            `node_modules/${args.path}.js`,
            `node_modules/${args.path}.ts`,
          ];
          // Also check from cwd
          const cwdCandidates = candidates.map(c => vfs.resolvePath(c));

          for (const p of [...cwdCandidates, ...candidates]) {
            try {
              if (p.endsWith('package.json')) {
                const pkgContent = await vfs.readFile(p);
                const pkg = JSON.parse(pkgContent);
                const main = pkg.main || 'index.js';
                const pkgDir = p.replace('/package.json', '');
                return { path: vfs.resolvePath(main, pkgDir), namespace: 'foam-fs' };
              } else {
                await vfs.readFile(p);
                return { path: p, namespace: 'foam-fs' };
              }
            } catch { continue; }
          }
          // Not found -> external
          return { path: args.path, external: true };
        }

        // Relative/absolute paths
        const baseDir = args.importer
          ? args.importer.substring(0, args.importer.lastIndexOf('/')) || '/'
          : vfs.cwd;
        const resolved = args.path.startsWith('/')
          ? args.path
          : vfs.resolvePath(args.path, baseDir);

        // Try with various extensions
        for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.json']) {
          try {
            await vfs.readFile(resolved + ext);
            return { path: resolved + ext, namespace: 'foam-fs' };
          } catch { continue; }
        }

        return { path: resolved, namespace: 'foam-fs' };
      });

      // Load from VFS
      build.onLoad({ filter: /.*/, namespace: 'foam-fs' }, async (args) => {
        try {
          const contents = await vfs.readFile(args.path);
          let loader = 'js';
          if (args.path.endsWith('.ts')) loader = 'ts';
          else if (args.path.endsWith('.tsx')) loader = 'tsx';
          else if (args.path.endsWith('.jsx')) loader = 'jsx';
          else if (args.path.endsWith('.json')) loader = 'json';
          else if (args.path.endsWith('.css')) loader = 'css';
          return { contents, loader };
        } catch (e) {
          return { errors: [{ text: `Failed to load ${args.path}: ${e.message}`, location: null }] };
        }
      });
    },
  };
}

commands.build = async (args, { stdout, stderr, vfs }) => {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    stdout('Usage: build <entry-point> [options]\n\n');
    stdout('Options:\n');
    stdout('  --outfile=FILE    Output file path (default: out.js)\n');
    stdout('  --bundle          Bundle all dependencies\n');
    stdout('  --minify          Minify the output\n');
    stdout('  --sourcemap       Generate source maps\n');
    stdout('  --format=FORMAT   Output format (iife, cjs, esm)\n');
    stdout('  --target=TARGET   Target environment (es2015, es2020, etc.)\n');
    stdout('\nExample:\n');
    stdout('  build src/index.ts --outfile=dist/bundle.js --bundle --minify\n');
    return 0;
  }

  try {
    stdout('Initializing esbuild-wasm...\n');
    const esbuild = await ensureEsbuild();

    // Parse arguments
    const entryPoint = args[0];
    let outfile = 'out.js';
    let bundle = false;
    let minify = false;
    let sourcemap = false;
    let format = 'esm';
    let target = 'es2020';

    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('--outfile=')) outfile = arg.slice('--outfile='.length);
      else if (arg === '--bundle') bundle = true;
      else if (arg === '--minify') minify = true;
      else if (arg === '--sourcemap') sourcemap = true;
      else if (arg.startsWith('--format=')) format = arg.slice('--format='.length);
      else if (arg.startsWith('--target=')) target = arg.slice('--target='.length);
    }

    const entryPath = vfs.resolvePath(entryPoint);
    stdout(`Building ${entryPath}...\n`);

    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle,
      minify,
      sourcemap,
      format,
      target,
      write: false,
      plugins: [createFoamFSPlugin(vfs)],
      logLevel: 'silent',
    });

    if (result.errors.length > 0) {
      for (const error of result.errors) {
        stderr(`Error: ${error.text}\n`);
        if (error.location) {
          stderr(`  at ${error.location.file}:${error.location.line}:${error.location.column}\n`);
        }
      }
      return 1;
    }

    for (const warning of result.warnings) {
      stdout(`Warning: ${warning.text}\n`);
    }

    if (result.outputFiles && result.outputFiles.length > 0) {
      const output = result.outputFiles[0];
      const outputPath = vfs.resolvePath(outfile);

      // Ensure output directory exists
      const outputDir = outputPath.substring(0, outputPath.lastIndexOf('/'));
      if (outputDir) {
        try { await vfs.mkdir(outputDir, { recursive: true }); } catch {}
      }

      // esbuild-wasm returns Uint8Array contents, decode to string for VFS
      const content = typeof output.contents === 'string'
        ? output.contents
        : new TextDecoder().decode(output.contents);
      await vfs.writeFile(outputPath, content);

      const sizeKB = (content.length / 1024).toFixed(2);
      stdout(`✓ Built: ${outputPath} (${sizeKB} KB)\n`);

      // Write sourcemap if generated
      if (sourcemap && result.outputFiles.length > 1) {
        const mapOutput = result.outputFiles[1];
        const mapContent = typeof mapOutput.contents === 'string'
          ? mapOutput.contents
          : new TextDecoder().decode(mapOutput.contents);
        const mapPath = outputPath + '.map';
        await vfs.writeFile(mapPath, mapContent);
        stdout(`✓ Sourcemap: ${mapPath}\n`);
      }
    }

    return 0;
  } catch (err) {
    stderr(`build: ${err.message}\n`);
    return 1;
  }
};

// Alias: tsc -> build (for TypeScript compilation)
commands.tsc = async (args, ctx) => {
  // Map tsc-style args to build args
  const buildArgs = [];
  let entryFile = null;
  let outFile = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--outFile' || args[i] === '--outfile') {
      outFile = args[++i];
    } else if (!args[i].startsWith('-')) {
      entryFile = args[i];
    }
  }

  if (!entryFile) {
    ctx.stderr('Usage: tsc <file.ts> [--outFile output.js]\n');
    return 1;
  }

  buildArgs.push(entryFile);
  if (outFile) buildArgs.push(`--outfile=${outFile}`);
  else buildArgs.push(`--outfile=${entryFile.replace(/\.tsx?$/, '.js')}`);

  return commands.build(buildArgs, ctx);
};

// ─── BUNDLE ─────────────────────────────────────────────────────────────────

commands.bundle = async (args, { stdin, stdout, stderr, vfs }) => {
  if (args.length === 0) {
    stderr('Usage: bundle <entry.js> [output.js]\n');
    stderr('       bundle --help\n');
    stderr('\n');
    stderr('Simple bundler that resolves require() calls and concatenates modules.\n');
    return 1;
  }

  if (args[0] === '--help') {
    stdout('Foam Simple Bundler\n');
    stdout('\n');
    stdout('Usage: bundle <entry.js> [output.js]\n');
    stdout('\n');
    stdout('Bundles a JavaScript file and its dependencies into a single file.\n');
    stdout('Resolves require() calls recursively and concatenates all modules.\n');
    stdout('\n');
    stdout('Options:\n');
    stdout('  --help    Show this help message\n');
    stdout('\n');
    stdout('Example:\n');
    stdout('  bundle app.js bundle.js\n');
    stdout('  node bundle.js\n');
    return 0;
  }

  const entryFile = args[0];
  const outputFile = args[1] || 'bundle.js';

  try {
    // Track bundled modules to avoid duplicates
    const bundled = new Set();
    const moduleContents = [];

    // Recursive function to resolve and bundle a module
    async function bundleModule(modulePath, fromDir = vfs.cwd) {
      // Resolve the module path
      let resolvedPath = modulePath;

      if (modulePath.startsWith('./') || modulePath.startsWith('../') || modulePath.startsWith('/')) {
        resolvedPath = vfs.resolvePath(modulePath, fromDir);
      } else {
        const nodeModulesPath = `node_modules/${modulePath}`;
        try {
          const pkgJsonPath = `${nodeModulesPath}/package.json`;
          const pkgJson = JSON.parse(await vfs.readFile(pkgJsonPath));
          const mainFile = pkgJson.main || 'index.js';
          resolvedPath = `${nodeModulesPath}/${mainFile}`;
        } catch {
          resolvedPath = `${nodeModulesPath}/index.js`;
        }
      }

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
            // Use as-is
          }
        }
      }

      // Skip if already bundled
      if (bundled.has(resolvedPath)) {
        return;
      }
      bundled.add(resolvedPath);

      // Read file content
      let content;
      try {
        content = await vfs.readFile(resolvedPath);
      } catch (err) {
        throw new Error(`Cannot read module '${modulePath}' (${resolvedPath}): ${err.message}`);
      }

      // Handle JSON files
      if (resolvedPath.endsWith('.json')) {
        moduleContents.push(`// Module: ${resolvedPath}`);
        moduleContents.push(`__modules['${resolvedPath}'] = ${content};`);
        return;
      }

      // Parse require() calls to find dependencies
      const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      const dependencies = [];
      let match;
      while ((match = requirePattern.exec(content)) !== null) {
        dependencies.push(match[1]);
      }

      // Get module directory for nested requires
      const moduleDir = resolvedPath.substring(0, resolvedPath.lastIndexOf('/')) || vfs.cwd;

      // Recursively bundle dependencies first
      for (const dep of dependencies) {
        try {
          await bundleModule(dep, moduleDir);
        } catch (err) {
          stderr(`Warning: Could not bundle dependency '${dep}' from '${resolvedPath}': ${err.message}\n`);
        }
      }

      // Add this module to the bundle
      moduleContents.push(`\n// Module: ${resolvedPath}`);
      moduleContents.push(`__modules['${resolvedPath}'] = function(module, exports, require, __filename, __dirname) {`);
      moduleContents.push(content);
      moduleContents.push(`};\n`);
    }

    // Start bundling from entry point
    stdout(`Bundling ${entryFile}...\n`);
    await bundleModule(entryFile);

    // Create the bundle header with module loader
    const bundleHeader = `// Foam Bundle
// Entry: ${entryFile}
// Generated: ${new Date().toISOString()}

(function() {
  // Module cache
  const __cache = {};
  const __modules = {};

  // require() implementation
  function require(modulePath) {
    if (__cache[modulePath]) {
      return __cache[modulePath].exports;
    }

    const module = { exports: {} };
    const exports = module.exports;
    __cache[modulePath] = module;

    const moduleFunc = __modules[modulePath];
    if (!moduleFunc) {
      throw new Error('Cannot find module: ' + modulePath);
    }

    if (typeof moduleFunc === 'function') {
      const moduleDir = modulePath.substring(0, modulePath.lastIndexOf('/')) || '.';
      moduleFunc(module, exports, require, modulePath, moduleDir);
    } else {
      // JSON module
      module.exports = moduleFunc;
    }

    return module.exports;
  }

  // Module definitions
`;

    const bundleFooter = `
  // Execute entry point
  require('${vfs.resolvePath(entryFile, vfs.cwd)}');
})();
`;

    // Combine everything
    const bundle = bundleHeader + moduleContents.join('\n') + bundleFooter;

    // Write the bundle
    await vfs.writeFile(outputFile, bundle);

    stdout(`✓ Bundled ${bundled.size} module(s) to ${outputFile}\n`);
    stdout(`  Entry: ${entryFile}\n`);
    stdout(`  Output: ${outputFile} (${bundle.length} bytes)\n`);

    return 0;
  } catch (err) {
    stderr(`bundle: ${err.message}\n`);
    return 1;
  }
};

export default commands;
