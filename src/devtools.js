// Dev tools — git, npm, node implementations on VFS
import commands from './commands.js';

// ─── GIT ────────────────────────────────────────────────────────────────────

async function gitInit(args, { stdout, stderr, vfs }) {
  const gitDir = vfs.resolvePath('.git');
  if (await vfs.exists(gitDir)) {
    stdout(`Reinitialized existing Git repository in ${gitDir}/\n`);
    return 0;
  }
  await vfs.mkdir('.git', { recursive: true });
  await vfs.mkdir('.git/objects', { recursive: true });
  await vfs.mkdir('.git/refs', { recursive: true });
  await vfs.mkdir('.git/refs/heads', { recursive: true });
  await vfs.writeFile('.git/HEAD', 'ref: refs/heads/main\n');
  await vfs.writeFile('.git/config', JSON.stringify({
    core: { repositoryformatversion: 0 },
    user: { name: 'user', email: 'user@foam' },
  }, null, 2));
  // Index = staged files: { path: { content, hash } }
  await vfs.writeFile('.git/index', '{}');
  // Commits: array of { hash, tree, parent, message, author, timestamp }
  await vfs.writeFile('.git/commits', '[]');
  stdout(`Initialized empty Git repository in ${gitDir}/\n`);
  return 0;
}

async function readGitData(vfs) {
  const indexRaw = await vfs.readFile('.git/index').catch(() => '{}');
  const commitsRaw = await vfs.readFile('.git/commits').catch(() => '[]');
  const headRef = (await vfs.readFile('.git/HEAD').catch(() => 'ref: refs/heads/main\n')).trim();
  let branch = 'main';
  if (headRef.startsWith('ref: refs/heads/')) branch = headRef.slice(16);
  return {
    index: JSON.parse(indexRaw),
    commits: JSON.parse(commitsRaw),
    branch,
  };
}

async function writeGitData(vfs, { index, commits }) {
  await vfs.writeFile('.git/index', JSON.stringify(index, null, 2));
  await vfs.writeFile('.git/commits', JSON.stringify(commits, null, 2));
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// Collect all tracked files (non-.git, non-node_modules)
async function collectFiles(vfs, dir) {
  const files = {};
  const entries = await vfs.readdir(dir).catch(() => []);
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = (dir === '/' ? '' : dir) + '/' + e.name;
    if (e.type === 'dir') {
      Object.assign(files, await collectFiles(vfs, full));
    } else {
      const content = await vfs.readFile(full).catch(() => '');
      files[full] = content;
    }
  }
  return files;
}

async function gitAdd(args, { stdout, stderr, vfs }) {
  if (args.length === 0) { stderr('Nothing specified, nothing added.\n'); return 1; }
  const { index, commits, branch } = await readGitData(vfs);
  const cwd = vfs.cwd;

  for (const pattern of args) {
    if (pattern === '.' || pattern === '-A') {
      const files = await collectFiles(vfs, cwd);
      for (const [path, content] of Object.entries(files)) {
        index[path] = { content, hash: simpleHash(content) };
      }
    } else {
      const resolved = vfs.resolvePath(pattern);
      const stat = await vfs.stat(resolved).catch(() => null);
      if (!stat) { stderr(`fatal: pathspec '${pattern}' did not match any files\n`); return 1; }
      if (stat.type === 'dir') {
        const files = await collectFiles(vfs, resolved);
        for (const [path, content] of Object.entries(files)) {
          index[path] = { content, hash: simpleHash(content) };
        }
      } else {
        const content = await vfs.readFile(resolved);
        index[resolved] = { content, hash: simpleHash(content) };
      }
    }
  }

  await writeGitData(vfs, { index, commits });
  return 0;
}

async function gitStatus(args, { stdout, stderr, vfs }) {
  const { index, commits, branch } = await readGitData(vfs);
  stdout(`On branch ${branch}\n`);

  const lastCommit = commits.length > 0 ? commits[commits.length - 1] : null;
  const lastTree = lastCommit ? lastCommit.tree : {};
  const workingFiles = await collectFiles(vfs, vfs.cwd);

  // Staged changes (in index but different from last commit)
  const staged = [];
  for (const [path, data] of Object.entries(index)) {
    if (!lastTree[path]) staged.push({ path, status: 'new file' });
    else if (lastTree[path].hash !== data.hash) staged.push({ path, status: 'modified' });
  }
  for (const path of Object.keys(lastTree)) {
    if (!index[path]) staged.push({ path, status: 'deleted' });
  }

  // Unstaged changes (working tree vs index)
  const unstaged = [];
  const untracked = [];
  for (const [path, content] of Object.entries(workingFiles)) {
    if (index[path]) {
      if (index[path].hash !== simpleHash(content)) unstaged.push(path);
    } else if (!lastTree[path]) {
      untracked.push(path);
    }
  }

  if (staged.length > 0) {
    stdout('\nChanges to be committed:\n');
    for (const s of staged) stdout(`\t\x1b[32m${s.status}:   ${s.path}\x1b[0m\n`);
  }
  if (unstaged.length > 0) {
    stdout('\nChanges not staged for commit:\n');
    for (const u of unstaged) stdout(`\t\x1b[31mmodified:   ${u}\x1b[0m\n`);
  }
  if (untracked.length > 0) {
    stdout('\nUntracked files:\n');
    for (const u of untracked) stdout(`\t\x1b[31m${u}\x1b[0m\n`);
  }
  if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
    stdout('nothing to commit, working tree clean\n');
  }
  return 0;
}

async function gitCommit(args, { stdout, stderr, vfs }) {
  let message = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m' && i + 1 < args.length) { message = args[++i]; break; }
  }
  if (!message) { stderr('error: switch `m\' requires a value\n'); return 1; }

  const { index, commits, branch } = await readGitData(vfs);
  if (Object.keys(index).length === 0) { stderr('nothing to commit\n'); return 1; }

  const tree = {};
  for (const [path, data] of Object.entries(index)) {
    tree[path] = { content: data.content, hash: data.hash };
  }

  const parent = commits.length > 0 ? commits[commits.length - 1].hash : null;
  const timestamp = Date.now();
  const commitData = { message, author: 'user <user@foam>', timestamp };
  const hash = simpleHash(JSON.stringify(commitData) + timestamp);

  commits.push({ hash, tree, parent, message, author: commitData.author, timestamp, branch });
  await writeGitData(vfs, { index, commits });

  const fileCount = Object.keys(tree).length;
  stdout(`[${branch} ${hash.slice(0, 7)}] ${message}\n`);
  stdout(` ${fileCount} file${fileCount !== 1 ? 's' : ''} changed\n`);
  return 0;
}

async function gitLog(args, { stdout, stderr, vfs }) {
  const { commits, branch } = await readGitData(vfs);
  if (commits.length === 0) { stderr('fatal: no commits yet\n'); return 1; }

  const oneline = args.includes('--oneline');
  const reversed = [...commits].reverse();

  for (const c of reversed) {
    if (oneline) {
      stdout(`\x1b[33m${c.hash.slice(0, 7)}\x1b[0m ${c.message}\n`);
    } else {
      stdout(`\x1b[33mcommit ${c.hash}\x1b[0m\n`);
      stdout(`Author: ${c.author}\n`);
      stdout(`Date:   ${new Date(c.timestamp).toISOString()}\n`);
      stdout(`\n    ${c.message}\n\n`);
    }
  }
  return 0;
}

async function gitDiff(args, { stdout, stderr, vfs }) {
  const { index, commits } = await readGitData(vfs);
  const lastCommit = commits.length > 0 ? commits[commits.length - 1] : null;
  const lastTree = lastCommit ? lastCommit.tree : {};
  const workingFiles = await collectFiles(vfs, vfs.cwd);

  for (const [path, content] of Object.entries(workingFiles)) {
    const committed = lastTree[path]?.content || '';
    if (content !== committed) {
      stdout(`\x1b[1mdiff --git a${path} b${path}\x1b[0m\n`);
      const aLines = committed.split('\n');
      const bLines = content.split('\n');
      const max = Math.max(aLines.length, bLines.length);
      for (let i = 0; i < max; i++) {
        if (aLines[i] !== bLines[i]) {
          if (i < aLines.length) stdout(`\x1b[31m-${aLines[i]}\x1b[0m\n`);
          if (i < bLines.length) stdout(`\x1b[32m+${bLines[i]}\x1b[0m\n`);
        }
      }
    }
  }
  return 0;
}

async function gitBranch(args, { stdout, stderr, vfs }) {
  const { commits, branch } = await readGitData(vfs);
  const branches = new Set(['main']);
  for (const c of commits) if (c.branch) branches.add(c.branch);

  if (args.length === 0) {
    for (const b of branches) {
      stdout((b === branch ? '* ' : '  ') + b + '\n');
    }
  } else {
    // Create new branch — just store the name
    const newBranch = args[0];
    await vfs.writeFile('.git/refs/heads/' + newBranch, commits.length ? commits[commits.length - 1].hash : '');
    stdout(`Created branch '${newBranch}'\n`);
  }
  return 0;
}

async function gitCheckout(args, { stdout, stderr, vfs }) {
  if (args.length === 0) { stderr('error: no branch specified\n'); return 1; }
  const target = args[0];
  const branchFile = vfs.resolvePath('.git/refs/heads/' + target);
  if (!(await vfs.exists(branchFile))) {
    if (args.includes('-b')) {
      await vfs.writeFile('.git/refs/heads/' + target, '');
    } else {
      stderr(`error: pathspec '${target}' did not match any branch\n`);
      return 1;
    }
  }
  await vfs.writeFile('.git/HEAD', `ref: refs/heads/${target}\n`);
  stdout(`Switched to branch '${target}'\n`);
  return 0;
}

commands.git = async (args, ctx) => {
  if (args.length === 0) { ctx.stderr('usage: git <command>\n'); return 1; }
  const sub = args[0];
  const subArgs = args.slice(1);
  const gitCmds = {
    init: gitInit, add: gitAdd, status: gitStatus, commit: gitCommit,
    log: gitLog, diff: gitDiff, branch: gitBranch, checkout: gitCheckout,
  };
  if (!gitCmds[sub]) { ctx.stderr(`git: '${sub}' is not a git command\n`); return 1; }
  // Check .git exists (except for init)
  if (sub !== 'init' && !(await ctx.vfs.exists(ctx.vfs.resolvePath('.git')))) {
    ctx.stderr('fatal: not a git repository\n');
    return 128;
  }
  return gitCmds[sub](subArgs, ctx);
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

    // Try to fetch from esm.sh
    try {
      stdout(`Fetching ${pkgName} from esm.sh...\n`);
      const res = await fetch(`https://esm.sh/${pkgName}`);
      if (res.ok) {
        const code = await res.text();
        await vfs.writeFile(`node_modules/${pkgName}/index.js`, code);
        stdout(`+ ${pkgName}\n`);

        // Update package.json
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
      // Would exec through shell — for now just print
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
    // Eval mode
    const code = args[0] === '-e' ? args.slice(1).join(' ') : (stdin || '');
    if (!code) { stderr('Usage: node -e "code" or node <file>\n'); return 1; }
    try {
      // Create a sandboxed scope with console.log -> stdout
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

  // File mode
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
