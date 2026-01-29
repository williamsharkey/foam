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

commands.npm = async (args, { stdout, stderr, vfs }) => {
  if (args.length === 0) { stderr('Usage: npm <command>\n'); return 1; }
  const sub = args[0];

  if (sub === 'init') {
    const pkg = {
      name: vfs.cwd.split('/').pop() || 'project',
      version: '1.0.0',
      description: '',
      main: 'index.js',
      scripts: { start: 'node index.js', test: 'echo "no test specified"' },
      dependencies: {},
    };
    await vfs.writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n');
    stdout('Wrote to package.json\n');
    return 0;
  }

  if (sub === 'install' || sub === 'i') {
    const pkgName = args[1];
    if (!pkgName) {
      stdout('npm install: nothing to install\n');
      return 0;
    }
    await vfs.mkdir('node_modules', { recursive: true });
    await vfs.mkdir(`node_modules/${pkgName}`, { recursive: true });

    try {
      stdout(`Fetching ${pkgName} from esm.sh...\n`);
      const res = await globalThis.fetch(`https://esm.sh/${pkgName}`);
      if (res.ok) {
        const code = await res.text();
        await vfs.writeFile(`node_modules/${pkgName}/index.js`, code);
        stdout(`+ ${pkgName}\n`);

        try {
          const pkgJson = JSON.parse(await vfs.readFile('package.json'));
          pkgJson.dependencies = pkgJson.dependencies || {};
          pkgJson.dependencies[pkgName] = 'latest';
          await vfs.writeFile('package.json', JSON.stringify(pkgJson, null, 2) + '\n');
        } catch (_) {}
      } else {
        stderr(`npm ERR! 404 Not Found: ${pkgName}\n`);
        return 1;
      }
    } catch (err) {
      stderr(`npm ERR! network error: ${err.message}\n`);
      return 1;
    }
    return 0;
  }

  if (sub === 'run') {
    const script = args[1];
    if (!script) { stderr('Usage: npm run <script>\n'); return 1; }
    try {
      const pkgJson = JSON.parse(await vfs.readFile('package.json'));
      const cmd = pkgJson.scripts?.[script];
      if (!cmd) { stderr(`npm ERR! Missing script: "${script}"\n`); return 1; }
      stdout(`> ${cmd}\n`);
      return 0;
    } catch (err) {
      stderr(`npm ERR! ${err.message}\n`);
      return 1;
    }
  }

  stderr(`npm: unknown command '${sub}'\n`);
  return 1;
};

// ─── NODE ───────────────────────────────────────────────────────────────────

commands.node = async (args, { stdin, stdout, stderr, vfs }) => {
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
        },
        require: (mod) => { throw new Error(`Cannot require '${mod}' in Foam`); },
        process: {
          env: { ...vfs.env },
          cwd: () => vfs.cwd,
          exit: (code) => { throw { exitCode: code }; },
          argv: ['node', '-e'],
        },
        setTimeout, setInterval, clearTimeout, clearInterval,
        JSON, Math, Date, RegExp, Array, Object, String, Number, Boolean,
        Map, Set, Promise, Symbol, Error, parseInt, parseFloat, isNaN, isFinite,
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

export default commands;
