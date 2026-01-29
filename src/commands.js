// Shell commands — each function has signature:
// async (args, { stdin, stdout, stderr, vfs, env }) => exitCode
// stdout/stderr are functions: stdout(text) appends to output stream

function parseFlags(args, known) {
  const flags = {};
  const positional = [];
  for (const a of args) {
    if (a === '--') { positional.push(...args.slice(args.indexOf(a) + 1)); break; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      flags[key] = true;
    } else if (a.startsWith('-') && a.length > 1 && !/^\d/.test(a[1])) {
      for (const ch of a.slice(1)) flags[ch] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// Parse -n <number> style flags
function parseFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    const val = args[idx + 1];
    const remaining = [...args.slice(0, idx), ...args.slice(idx + 2)];
    return { value: val, args: remaining };
  }
  return { value: null, args };
}

function formatMode(mode) {
  const types = { dir: 'd', file: '-' };
  const t = types['dir'] || '-'; // placeholder
  const perms = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
  const o = (mode >> 6) & 7, g = (mode >> 3) & 7, u = mode & 7;
  return perms[o] + perms[g] + perms[u];
}

function formatSize(size, human) {
  if (!human) return String(size).padStart(6);
  if (size < 1024) return String(size).padStart(6);
  if (size < 1024 * 1024) return (size / 1024).toFixed(1).padStart(5) + 'K';
  return (size / (1024 * 1024)).toFixed(1).padStart(5) + 'M';
}

function formatDate(ts) {
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const commands = {};

commands.ls = async (args, { stdout, stderr, vfs }) => {
  const { flags, positional } = parseFlags(args, 'laRh');
  const paths = positional.length ? positional : ['.'];
  for (const p of paths) {
    try {
      const resolved = vfs.resolvePath(p);
      const stat = await vfs.stat(resolved);
      if (stat.type !== 'dir') {
        if (flags.l) {
          const m = stat.type === 'dir' ? 'd' : '-';
          stdout(`${m}${formatMode(stat.mode)} 1 user user ${formatSize(stat.size, flags.h)} ${formatDate(stat.mtime)} ${p}\n`);
        } else {
          stdout(p + '\n');
        }
        continue;
      }
      const entries = await vfs.readdir(resolved);
      if (paths.length > 1) stdout(`${p}:\n`);
      for (const e of entries) {
        if (!flags.a && e.name.startsWith('.')) continue;
        if (flags.l) {
          const m = e.type === 'dir' ? 'd' : '-';
          stdout(`${m}${formatMode(e.mode)} 1 user user ${formatSize(e.size, flags.h)} ${formatDate(e.mtime)} ${e.name}\n`);
        } else {
          stdout(e.name + (e.type === 'dir' ? '/' : '') + '\n');
        }
      }
      if (flags.R) {
        for (const e of entries) {
          if (e.type === 'dir' && (flags.a || !e.name.startsWith('.'))) {
            const sub = resolved === '/' ? '/' + e.name : resolved + '/' + e.name;
            stdout('\n');
            await commands.ls([flags.l ? '-lR' : '-R', ...(flags.a ? ['-a'] : []), ...(flags.h ? ['-h'] : []), sub], { stdout, stderr, vfs });
          }
        }
      }
    } catch (err) {
      stderr(err.message + '\n');
      return 1;
    }
  }
  return 0;
};

commands.cd = async (args, { stderr, vfs }) => {
  const target = args[0] || '~';
  try {
    vfs.chdir(target);
    return 0;
  } catch (err) {
    stderr(err.message + '\n');
    return 1;
  }
};

commands.pwd = async (args, { stdout, vfs }) => {
  stdout(vfs.cwd + '\n');
  return 0;
};

commands.cat = async (args, { stdin, stdout, stderr, vfs }) => {
  const { flags, positional } = parseFlags(args, 'n');
  if (positional.length === 0) {
    // Read from stdin
    if (stdin) {
      const lines = stdin.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (flags.n) stdout(`${String(i + 1).padStart(6)}\t${lines[i]}\n`);
        else stdout(lines[i] + (i < lines.length - 1 ? '\n' : ''));
      }
    }
    return 0;
  }
  for (const f of positional) {
    try {
      const content = await vfs.readFile(f);
      if (flags.n) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          stdout(`${String(i + 1).padStart(6)}\t${lines[i]}\n`);
        }
      } else {
        stdout(content);
      }
    } catch (err) {
      stderr(err.message + '\n');
      return 1;
    }
  }
  return 0;
};

commands.echo = async (args, { stdout }) => {
  let newline = true;
  let interpret = false;
  const parts = [];
  for (const a of args) {
    if (a === '-n') { newline = false; continue; }
    if (a === '-e') { interpret = true; continue; }
    parts.push(a);
  }
  let out = parts.join(' ');
  if (interpret) {
    out = out.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
  }
  stdout(out + (newline ? '\n' : ''));
  return 0;
};

commands.mkdir = async (args, { stderr, vfs }) => {
  const { flags, positional } = parseFlags(args, 'p');
  for (const p of positional) {
    try {
      await vfs.mkdir(p, { recursive: !!flags.p });
    } catch (err) {
      stderr(err.message + '\n');
      return 1;
    }
  }
  return 0;
};

commands.rm = async (args, { stderr, vfs }) => {
  const { flags, positional } = parseFlags(args, 'rf');
  for (const p of positional) {
    try {
      const resolved = vfs.resolvePath(p);
      const stat = await vfs.stat(resolved).catch(() => null);
      if (!stat) {
        if (!flags.f) { stderr(`rm: cannot remove '${p}': No such file or directory\n`); return 1; }
        continue;
      }
      if (stat.type === 'dir') {
        if (!flags.r) { stderr(`rm: cannot remove '${p}': Is a directory\n`); return 1; }
        await vfs.rmdir(resolved, { recursive: true });
      } else {
        await vfs.unlink(resolved);
      }
    } catch (err) {
      if (!flags.f) { stderr(err.message + '\n'); return 1; }
    }
  }
  return 0;
};

commands.cp = async (args, { stderr, vfs }) => {
  const { flags, positional } = parseFlags(args, 'r');
  if (positional.length < 2) { stderr('cp: missing operand\n'); return 1; }
  const dest = positional.pop();
  for (const src of positional) {
    try {
      await vfs.copy(src, dest, { recursive: !!flags.r });
    } catch (err) {
      stderr(err.message + '\n');
      return 1;
    }
  }
  return 0;
};

commands.mv = async (args, { stderr, vfs }) => {
  if (args.length < 2) { stderr('mv: missing operand\n'); return 1; }
  const dest = args[args.length - 1];
  const sources = args.slice(0, -1);
  for (const src of sources) {
    try {
      const destResolved = vfs.resolvePath(dest);
      const destStat = await vfs.stat(destResolved).catch(() => null);
      let finalDest = dest;
      if (destStat && destStat.type === 'dir') {
        const name = src.split('/').pop();
        finalDest = dest + '/' + name;
      }
      await vfs.rename(src, finalDest);
    } catch (err) {
      stderr(err.message + '\n');
      return 1;
    }
  }
  return 0;
};

commands.touch = async (args, { stderr, vfs }) => {
  for (const p of args) {
    try {
      const resolved = vfs.resolvePath(p);
      if (await vfs.exists(resolved)) {
        const stat = await vfs.stat(resolved);
        stat.mtime = Date.now();
        stat.atime = Date.now();
        await vfs._put(stat);
      } else {
        await vfs.writeFile(p, '');
      }
    } catch (err) {
      stderr(err.message + '\n');
      return 1;
    }
  }
  return 0;
};

commands.head = async (args, { stdin, stdout, stderr, vfs }) => {
  let { value: n, args: rest } = parseFlagValue(args, '-n');
  n = parseInt(n) || 10;
  const { positional } = parseFlags(rest, '');
  let content = '';
  if (positional.length === 0) {
    content = stdin || '';
  } else {
    try { content = await vfs.readFile(positional[0]); }
    catch (err) { stderr(err.message + '\n'); return 1; }
  }
  const lines = content.split('\n').slice(0, n);
  stdout(lines.join('\n') + (content.endsWith('\n') ? '\n' : ''));
  return 0;
};

commands.tail = async (args, { stdin, stdout, stderr, vfs }) => {
  let { value: n, args: rest } = parseFlagValue(args, '-n');
  n = parseInt(n) || 10;
  const { positional } = parseFlags(rest, '');
  let content = '';
  if (positional.length === 0) {
    content = stdin || '';
  } else {
    try { content = await vfs.readFile(positional[0]); }
    catch (err) { stderr(err.message + '\n'); return 1; }
  }
  const lines = content.split('\n');
  const result = lines.slice(-n);
  stdout(result.join('\n'));
  return 0;
};

commands.wc = async (args, { stdin, stdout, stderr, vfs }) => {
  const { flags, positional } = parseFlags(args, 'lwc');
  const showAll = !flags.l && !flags.w && !flags.c;
  const process = (content, name) => {
    const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    const words = content.split(/\s+/).filter(Boolean).length;
    const chars = content.length;
    const parts = [];
    if (showAll || flags.l) parts.push(String(lines).padStart(6));
    if (showAll || flags.w) parts.push(String(words).padStart(6));
    if (showAll || flags.c) parts.push(String(chars).padStart(6));
    if (name) parts.push(' ' + name);
    stdout(parts.join(' ') + '\n');
  };
  if (positional.length === 0) {
    process(stdin || '', '');
  } else {
    for (const f of positional) {
      try {
        const content = await vfs.readFile(f);
        process(content, f);
      } catch (err) { stderr(err.message + '\n'); return 1; }
    }
  }
  return 0;
};

commands.grep = async (args, { stdin, stdout, stderr, vfs }) => {
  const { flags, positional } = parseFlags(args, 'irnlcvE');
  if (positional.length === 0) { stderr('grep: missing pattern\n'); return 1; }
  const pattern = positional[0];
  const files = positional.slice(1);
  const re = new RegExp(pattern, (flags.i ? 'i' : '') + (flags.E ? '' : ''));
  let found = false;

  const grepContent = (content, filename) => {
    const lines = content.split('\n');
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      const match = re.test(lines[i]);
      if (match !== !!flags.v) {
        found = true;
        count++;
        if (flags.l) { stdout(filename + '\n'); return; }
        if (!flags.c) {
          const prefix = (files.length > 1 && filename ? filename + ':' : '') + (flags.n ? (i + 1) + ':' : '');
          stdout(prefix + lines[i] + '\n');
        }
      }
    }
    if (flags.c) {
      stdout((filename ? filename + ':' : '') + count + '\n');
    }
  };

  if (files.length === 0) {
    grepContent(stdin || '', '');
  } else if (flags.r) {
    // Recursive grep
    const grepDir = async (dirPath) => {
      const entries = await vfs.readdir(dirPath);
      for (const e of entries) {
        const full = (dirPath === '/' ? '' : dirPath) + '/' + e.name;
        if (e.type === 'dir') {
          await grepDir(full);
        } else {
          try {
            const content = await vfs.readFile(full);
            grepContent(content, full);
          } catch (_) {}
        }
      }
    };
    for (const f of files) {
      const resolved = vfs.resolvePath(f);
      const stat = await vfs.stat(resolved).catch(() => null);
      if (stat && stat.type === 'dir') await grepDir(resolved);
      else if (stat) {
        const content = await vfs.readFile(resolved);
        grepContent(content, f);
      }
    }
  } else {
    for (const f of files) {
      try {
        const content = await vfs.readFile(f);
        grepContent(content, f);
      } catch (err) { stderr(err.message + '\n'); return 1; }
    }
  }
  return found ? 0 : 1;
};

commands.find = async (args, { stdout, stderr, vfs }) => {
  let basePath = '.';
  let namePattern = null;
  let typeFilter = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-name' && i + 1 < args.length) { namePattern = args[++i]; }
    else if (args[i] === '-type' && i + 1 < args.length) { typeFilter = args[++i]; }
    else if (!args[i].startsWith('-')) { basePath = args[i]; }
  }
  const resolved = vfs.resolvePath(basePath);
  const walk = async (dir) => {
    const entries = await vfs.readdir(dir).catch(() => []);
    for (const e of entries) {
      const full = (dir === '/' ? '' : dir) + '/' + e.name;
      let show = true;
      if (namePattern) {
        const re = new RegExp('^' + namePattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        if (!re.test(e.name)) show = false;
      }
      if (typeFilter) {
        if (typeFilter === 'f' && e.type !== 'file') show = false;
        if (typeFilter === 'd' && e.type !== 'dir') show = false;
      }
      if (show) stdout(full + '\n');
      if (e.type === 'dir') await walk(full);
    }
  };
  try {
    stdout(resolved + '\n');
    await walk(resolved);
  } catch (err) { stderr(err.message + '\n'); return 1; }
  return 0;
};

commands.sort = async (args, { stdin, stdout, stderr, vfs }) => {
  const { flags, positional } = parseFlags(args, 'rnu');
  let content = '';
  if (positional.length) {
    try { content = await vfs.readFile(positional[0]); }
    catch (err) { stderr(err.message + '\n'); return 1; }
  } else {
    content = stdin || '';
  }
  let lines = content.split('\n').filter(Boolean);
  if (flags.n) lines.sort((a, b) => parseFloat(a) - parseFloat(b));
  else lines.sort();
  if (flags.r) lines.reverse();
  if (flags.u) lines = [...new Set(lines)];
  stdout(lines.join('\n') + '\n');
  return 0;
};

commands.uniq = async (args, { stdin, stdout, stderr, vfs }) => {
  const { flags, positional } = parseFlags(args, 'cd');
  let content = '';
  if (positional.length) {
    try { content = await vfs.readFile(positional[0]); }
    catch (err) { stderr(err.message + '\n'); return 1; }
  } else {
    content = stdin || '';
  }
  const lines = content.split('\n');
  const result = [];
  let prev = null;
  let count = 0;
  for (const line of lines) {
    if (line === prev) { count++; continue; }
    if (prev !== null) {
      if (flags.d) { if (count > 0) result.push((flags.c ? `${String(count + 1).padStart(7)} ` : '') + prev); }
      else result.push((flags.c ? `${String(count + 1).padStart(7)} ` : '') + prev);
    }
    prev = line;
    count = 0;
  }
  if (prev !== null) {
    if (flags.d) { if (count > 0) result.push((flags.c ? `${String(count + 1).padStart(7)} ` : '') + prev); }
    else result.push((flags.c ? `${String(count + 1).padStart(7)} ` : '') + prev);
  }
  stdout(result.join('\n') + '\n');
  return 0;
};

commands.tee = async (args, { stdin, stdout, stderr, vfs }) => {
  const { flags, positional } = parseFlags(args, 'a');
  const content = stdin || '';
  stdout(content);
  for (const f of positional) {
    try {
      await vfs.writeFile(f, content, { append: !!flags.a });
    } catch (err) { stderr(err.message + '\n'); return 1; }
  }
  return 0;
};

commands.chmod = async (args, { stderr, vfs }) => {
  if (args.length < 2) { stderr('chmod: missing operand\n'); return 1; }
  const mode = parseInt(args[0], 8);
  if (isNaN(mode)) { stderr(`chmod: invalid mode: '${args[0]}'\n`); return 1; }
  for (const f of args.slice(1)) {
    try {
      const resolved = vfs.resolvePath(f);
      const stat = await vfs.stat(resolved);
      stat.mode = mode;
      await vfs._put(stat);
    } catch (err) { stderr(err.message + '\n'); return 1; }
  }
  return 0;
};

commands.env = async (args, { stdout, vfs }) => {
  for (const [k, v] of Object.entries(vfs.env)) {
    stdout(`${k}=${v}\n`);
  }
  return 0;
};

commands.export = async (args, { stderr, vfs }) => {
  for (const a of args) {
    const eq = a.indexOf('=');
    if (eq === -1) { stderr(`export: '${a}': not a valid identifier\n`); return 1; }
    vfs.env[a.slice(0, eq)] = a.slice(eq + 1);
  }
  return 0;
};

commands.which = async (args, { stdout, stderr }) => {
  for (const a of args) {
    if (commands[a]) stdout(`/usr/bin/${a}\n`);
    else { stderr(`which: no ${a} in PATH\n`); return 1; }
  }
  return 0;
};

commands.clear = async (args, { terminal }) => {
  if (terminal && terminal.clear) terminal.clear();
  return 0;
};

commands.sed = async (args, { stdin, stdout, stderr, vfs }) => {
  const { flags, positional } = parseFlags(args, 'i');
  if (positional.length === 0) { stderr('sed: no expression\n'); return 1; }
  const expr = positional[0];
  const files = positional.slice(1);
  // Parse s/pattern/replacement/flags
  const m = expr.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
  if (!m) { stderr(`sed: invalid expression: ${expr}\n`); return 1; }
  const [, , pat, rep, sflags] = m;
  const re = new RegExp(pat, sflags);

  const transform = (content) => {
    return content.split('\n').map(line => line.replace(re, rep)).join('\n');
  };

  if (files.length === 0) {
    stdout(transform(stdin || ''));
  } else {
    for (const f of files) {
      try {
        const content = await vfs.readFile(f);
        const result = transform(content);
        if (flags.i) {
          await vfs.writeFile(f, result);
        } else {
          stdout(result);
        }
      } catch (err) { stderr(err.message + '\n'); return 1; }
    }
  }
  return 0;
};

commands.diff = async (args, { stdout, stderr, vfs }) => {
  if (args.length < 2) { stderr('diff: missing operand\n'); return 1; }
  try {
    const a = (await vfs.readFile(args[0])).split('\n');
    const b = (await vfs.readFile(args[1])).split('\n');
    let hasDiff = false;
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      if (a[i] !== b[i]) {
        hasDiff = true;
        if (i < a.length && (i >= b.length || a[i] !== b[i])) stdout(`< ${a[i] || ''}\n`);
        if (i < b.length && (i >= a.length || a[i] !== b[i])) stdout(`> ${b[i] || ''}\n`);
      }
    }
    return hasDiff ? 1 : 0;
  } catch (err) { stderr(err.message + '\n'); return 2; }
};

commands.xargs = async (args, { stdin, stdout, stderr, vfs, env, terminal, exec }) => {
  if (args.length === 0) args = ['echo'];
  const cmd = args[0];
  const cmdArgs = args.slice(1);
  const items = (stdin || '').split(/\s+/).filter(Boolean);
  if (commands[cmd] && exec) {
    return await exec(`${cmd} ${cmdArgs.join(' ')} ${items.join(' ')}`);
  }
  return 1;
};

commands.true = async () => 0;
commands.false = async () => 1;

commands.printf = async (args, { stdout }) => {
  if (args.length === 0) return 0;
  let fmt = args[0];
  let i = 1;
  let out = fmt.replace(/%s/g, () => args[i++] || '');
  out = out.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  stdout(out);
  return 0;
};

commands.basename = async (args, { stdout }) => {
  if (args.length === 0) return 1;
  const name = args[0].split('/').pop();
  stdout(name + '\n');
  return 0;
};

commands.dirname = async (args, { stdout }) => {
  if (args.length === 0) return 1;
  const dir = args[0].substring(0, args[0].lastIndexOf('/')) || '/';
  stdout(dir + '\n');
  return 0;
};

commands.realpath = async (args, { stdout, stderr, vfs }) => {
  for (const a of args) {
    try {
      stdout(vfs.resolvePath(a) + '\n');
    } catch (err) { stderr(err.message + '\n'); return 1; }
  }
  return 0;
};

commands.date = async (args, { stdout }) => {
  stdout(new Date().toString() + '\n');
  return 0;
};

commands.whoami = async (args, { stdout, vfs }) => {
  stdout((vfs.env.USER || 'user') + '\n');
  return 0;
};

commands.hostname = async (args, { stdout }) => {
  stdout('foam\n');
  return 0;
};

commands.uname = async (args, { stdout }) => {
  const { flags } = parseFlags(args, 'a');
  if (flags.a) stdout('Foam 1.0.0 browser JavaScript virtual-os\n');
  else stdout('Foam\n');
  return 0;
};

commands.sleep = async (args) => {
  const secs = parseFloat(args[0]) || 1;
  await new Promise(r => setTimeout(r, secs * 1000));
  return 0;
};

commands.test = async (args, { vfs }) => {
  if (args.length === 0) return 1;
  // [ -f file ], [ -d file ], [ -e file ], [ str = str ], [ str != str ]
  if (args[0] === '-f') {
    try { const s = await vfs.stat(args[1]); return s.type === 'file' ? 0 : 1; } catch { return 1; }
  }
  if (args[0] === '-d') {
    try { const s = await vfs.stat(args[1]); return s.type === 'dir' ? 0 : 1; } catch { return 1; }
  }
  if (args[0] === '-e') {
    return (await vfs.exists(args[1])) ? 0 : 1;
  }
  if (args[0] === '-z') return (!args[1] || args[1].length === 0) ? 0 : 1;
  if (args[0] === '-n') return (args[1] && args[1].length > 0) ? 0 : 1;
  if (args.length >= 3 && args[1] === '=') return args[0] === args[2] ? 0 : 1;
  if (args.length >= 3 && args[1] === '!=') return args[0] !== args[2] ? 0 : 1;
  return args[0] ? 0 : 1;
};
commands['['] = async (args, ctx) => {
  // Remove trailing ]
  if (args[args.length - 1] === ']') args = args.slice(0, -1);
  return commands.test(args, ctx);
};

commands.seq = async (args, { stdout }) => {
  const nums = args.map(Number);
  let start = 1, step = 1, end = 1;
  if (nums.length === 1) { end = nums[0]; }
  else if (nums.length === 2) { start = nums[0]; end = nums[1]; }
  else if (nums.length >= 3) { start = nums[0]; step = nums[1]; end = nums[2]; }
  for (let i = start; step > 0 ? i <= end : i >= end; i += step) {
    stdout(i + '\n');
  }
  return 0;
};

commands.tr = async (args, { stdin, stdout }) => {
  if (args.length < 2) { stdout(stdin || ''); return 0; }
  const from = args[0], to = args[1];
  let result = stdin || '';
  for (let i = 0; i < from.length; i++) {
    const replacement = i < to.length ? to[i] : to[to.length - 1];
    result = result.split(from[i]).join(replacement);
  }
  stdout(result);
  return 0;
};

commands.cut = async (args, { stdin, stdout }) => {
  const { flags } = parseFlags(args, '');
  let delimiter = '\t';
  let fields = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-d' && i + 1 < args.length) delimiter = args[++i];
    if (args[i] === '-f' && i + 1 < args.length) fields = args[++i];
  }
  if (!fields) { stdout(stdin || ''); return 0; }
  const fieldNums = fields.split(',').map(Number);
  const lines = (stdin || '').split('\n');
  for (const line of lines) {
    const parts = line.split(delimiter);
    stdout(fieldNums.map(f => parts[f - 1] || '').join(delimiter) + '\n');
  }
  return 0;
};

export default commands;
