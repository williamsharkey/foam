// Shell commands — each function has signature:
// async (args, { stdin, stdout, stderr, vfs, env }) => exitCode
// stdout/stderr are functions: stdout(text) appends to output stream
//
// Standard coreutils (cat, ls, grep, etc.) are provided by fluffycoreutils
// and registered via src/fluffy-bridge.js. This file defines only
// Foam-specific commands that need direct access to VFS internals,
// the browser DOM, or other Foam-specific features.

const commands = {};

// ─── SHELL BUILTINS (need direct VFS/shell access) ──────────────────────────

commands.exit = async (args, { terminal }) => {
  const code = parseInt(args[0]) || 0;
  if (terminal) {
    terminal.write(`\nExiting with code ${code}\n`);
  }
  // In a real shell, this would exit the process
  // In browser context, we just return the exit code
  return code;
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

commands.realpath = async (args, { stdout, stderr, vfs }) => {
  for (const a of args) {
    try {
      stdout(vfs.resolvePath(a) + '\n');
    } catch (err) { stderr(err.message + '\n'); return 1; }
  }
  return 0;
};

commands.sleep = async (args) => {
  const secs = parseFloat(args[0]) || 1;
  await new Promise(r => setTimeout(r, secs * 1000));
  return 0;
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

// Bracket alias for test — fluffycoreutils provides 'test', we alias '['
commands['['] = async (args, ctx) => {
  if (args[args.length - 1] === ']') args = args.slice(0, -1);
  return commands.test(args, ctx);
};

commands.help = async (args, { stdout }) => {
  const names = Object.keys(commands).filter(n => n !== '[').sort();
  stdout('Available commands:\n');
  const cols = 6;
  for (let i = 0; i < names.length; i += cols) {
    const row = names.slice(i, i + cols).map(n => n.padEnd(14)).join('');
    stdout('  ' + row + '\n');
  }
  stdout('\nFoam-specific: dom, js, glob, fetch, curl, sleep, seq\n');
  stdout('Dev tools:     git, npm, npx, node, python, pip, ed\n');
  stdout('Job control:   jobs, fg, bg (use & for background)\n');
  stdout('Environment:   env, export, printenv, unset\n');
  stdout('AI assistant:  spirit "your message" (Claude Code agent)\n');
  stdout('Legacy AI:     claude "your message" (direct API)\n');
  stdout('File transfer: upload [dir], download <file>\n');
  stdout('Config:        foam config set api_key <key>\n');
  return 0;
};

commands.history = async (args, { stdout, terminal }) => {
  if (!terminal || !terminal.history) {
    stdout('(no history available)\n');
    return 0;
  }
  for (let i = 0; i < terminal.history.length; i++) {
    stdout(`${String(i + 1).padStart(5)}  ${terminal.history[i]}\n`);
  }
  return 0;
};

commands.alias = async (args, { stdout, stderr, exec }) => {
  // exec is a reference to shell.exec, we need shell for aliases
  // For now, just list/set aliases via env-like syntax
  stdout('alias: not yet implemented\n');
  return 0;
};

commands.source = async (args, { stdout, stderr, vfs, exec }) => {
  if (args.length === 0) { stderr('source: missing filename\n'); return 1; }
  try {
    const content = await vfs.readFile(args[0]);
    const lines = content.split('\n');
    let lastExit = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (exec) {
        const r = await exec(trimmed);
        if (typeof r === 'object') {
          if (r.stdout) stdout(r.stdout);
          if (r.stderr) stderr(r.stderr);
          lastExit = r.exitCode;
        } else {
          lastExit = r;
        }
      }
    }
    return lastExit;
  } catch (err) {
    stderr(`source: ${err.message}\n`);
    return 1;
  }
};
commands['.'] = commands.source;

commands.type = async (args, { stdout, stderr }) => {
  for (const a of args) {
    if (commands[a]) {
      stdout(`${a} is a shell builtin\n`);
    } else {
      stderr(`type: ${a}: not found\n`);
      return 1;
    }
  }
  return 0;
};

// ─── GLOB ───────────────────────────────────────────────────────────────────

commands.glob = async (args, { stdout, stderr, vfs }) => {
  if (args.length === 0) { stderr('Usage: glob <pattern> [base_dir]\n'); return 1; }
  const pattern = args[0];
  const base = args[1] || '.';
  try {
    const results = await vfs.glob(pattern, base);
    for (const r of results) stdout(r + '\n');
    return 0;
  } catch (err) {
    stderr(`glob: ${err.message}\n`);
    return 1;
  }
};

// ─── DOM ACCESS ─────────────────────────────────────────────────────────────

commands.js = async (args, { stdout, stderr }) => {
  const code = args.join(' ');
  if (!code) { stderr('Usage: js <code>\n'); return 1; }
  try {
    const result = eval(code);
    const str = result === undefined ? 'undefined'
      : typeof result === 'object' ? JSON.stringify(result, null, 2)
      : String(result);
    stdout(str + '\n');
    return 0;
  } catch (err) {
    stderr(`${err.name}: ${err.message}\n`);
    return 1;
  }
};

commands.dom = async (args, { stdout, stderr }) => {
  const sub = args[0];
  if (!sub) {
    stdout('Usage: dom <command> [args]\n\nCommands:\n  query <selector>      — query elements, show tag/id/class/text\n  count <selector>      — count matching elements\n  text <selector>       — get text content\n  html <selector>       — get innerHTML\n  attr <selector> <attr> — get attribute value\n  set-text <selector> <text> — set text content\n  set-html <selector> <html> — set innerHTML\n  set-attr <selector> <attr> <value> — set attribute\n  add-class <selector> <class> — add CSS class\n  rm-class <selector> <class> — remove CSS class\n  create <tag> [parent-selector] — create element\n  remove <selector>     — remove elements\n  style <selector> <prop> <value> — set CSS style\n');
    return 0;
  }

  try {
    switch (sub) {
      case 'query': {
        const sel = args.slice(1).join(' ');
        if (!sel) { stderr('dom query: missing selector\n'); return 1; }
        const els = document.querySelectorAll(sel);
        if (els.length === 0) { stdout('(no matches)\n'); return 0; }
        els.forEach((el, i) => {
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className ? `.${String(el.className).split(/\s+/).join('.')}` : '';
          const text = (el.textContent || '').trim().slice(0, 60);
          stdout(`[${i}] <${el.tagName.toLowerCase()}${id}${cls}> ${text}\n`);
        });
        return 0;
      }
      case 'count': {
        const sel = args.slice(1).join(' ');
        if (!sel) { stderr('dom count: missing selector\n'); return 1; }
        stdout(document.querySelectorAll(sel).length + '\n');
        return 0;
      }
      case 'text': {
        const sel = args.slice(1).join(' ');
        if (!sel) { stderr('dom text: missing selector\n'); return 1; }
        const el = document.querySelector(sel);
        if (!el) { stderr('dom: no element matches selector\n'); return 1; }
        stdout((el.textContent || '') + '\n');
        return 0;
      }
      case 'html': {
        const sel = args.slice(1).join(' ');
        if (!sel) { stderr('dom html: missing selector\n'); return 1; }
        const el = document.querySelector(sel);
        if (!el) { stderr('dom: no element matches selector\n'); return 1; }
        stdout(el.innerHTML + '\n');
        return 0;
      }
      case 'attr': {
        const sel = args[1];
        const attr = args[2];
        if (!sel || !attr) { stderr('Usage: dom attr <selector> <attribute>\n'); return 1; }
        const el = document.querySelector(sel);
        if (!el) { stderr('dom: no element matches selector\n'); return 1; }
        stdout((el.getAttribute(attr) || '') + '\n');
        return 0;
      }
      case 'set-text': {
        const sel = args[1];
        const text = args.slice(2).join(' ');
        if (!sel) { stderr('Usage: dom set-text <selector> <text>\n'); return 1; }
        const el = document.querySelector(sel);
        if (!el) { stderr('dom: no element matches selector\n'); return 1; }
        el.textContent = text;
        stdout('ok\n');
        return 0;
      }
      case 'set-html': {
        const sel = args[1];
        const html = args.slice(2).join(' ');
        if (!sel) { stderr('Usage: dom set-html <selector> <html>\n'); return 1; }
        const el = document.querySelector(sel);
        if (!el) { stderr('dom: no element matches selector\n'); return 1; }
        el.innerHTML = html;
        stdout('ok\n');
        return 0;
      }
      case 'set-attr': {
        const sel = args[1], attr = args[2], val = args.slice(3).join(' ');
        if (!sel || !attr) { stderr('Usage: dom set-attr <selector> <attr> <value>\n'); return 1; }
        const el = document.querySelector(sel);
        if (!el) { stderr('dom: no element matches selector\n'); return 1; }
        el.setAttribute(attr, val);
        stdout('ok\n');
        return 0;
      }
      case 'add-class': {
        const sel = args[1], cls = args[2];
        if (!sel || !cls) { stderr('Usage: dom add-class <selector> <class>\n'); return 1; }
        const el = document.querySelector(sel);
        if (!el) { stderr('dom: no element matches selector\n'); return 1; }
        el.classList.add(cls);
        stdout('ok\n');
        return 0;
      }
      case 'rm-class': {
        const sel = args[1], cls = args[2];
        if (!sel || !cls) { stderr('Usage: dom rm-class <selector> <class>\n'); return 1; }
        const el = document.querySelector(sel);
        if (!el) { stderr('dom: no element matches selector\n'); return 1; }
        el.classList.remove(cls);
        stdout('ok\n');
        return 0;
      }
      case 'create': {
        const tag = args[1];
        const parentSel = args[2] || 'body';
        if (!tag) { stderr('Usage: dom create <tag> [parent-selector]\n'); return 1; }
        const parent = document.querySelector(parentSel);
        if (!parent) { stderr('dom: parent not found\n'); return 1; }
        const el = document.createElement(tag);
        parent.appendChild(el);
        stdout(`Created <${tag}> in ${parentSel}\n`);
        return 0;
      }
      case 'remove': {
        const sel = args.slice(1).join(' ');
        if (!sel) { stderr('Usage: dom remove <selector>\n'); return 1; }
        const els = document.querySelectorAll(sel);
        els.forEach(el => el.remove());
        stdout(`Removed ${els.length} element(s)\n`);
        return 0;
      }
      case 'style': {
        const sel = args[1], prop = args[2], val = args.slice(3).join(' ');
        if (!sel || !prop) { stderr('Usage: dom style <selector> <property> <value>\n'); return 1; }
        const el = document.querySelector(sel);
        if (!el) { stderr('dom: no element matches selector\n'); return 1; }
        el.style[prop] = val;
        stdout('ok\n');
        return 0;
      }
      default:
        stderr(`dom: unknown command '${sub}'\n`);
        return 1;
    }
  } catch (err) {
    stderr(`dom: ${err.message}\n`);
    return 1;
  }
};

// ─── HTTP ───────────────────────────────────────────────────────────────────

commands.fetch = async (args, { stdout, stderr }) => {
  let url = null;
  let method = 'GET';
  let body = null;
  const headers = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m' || args[i] === '--method') { method = (args[++i] || 'GET').toUpperCase(); }
    else if (args[i] === '-H' || args[i] === '--header') {
      const h = args[++i] || '';
      const colon = h.indexOf(':');
      if (colon > 0) headers[h.slice(0, colon).trim()] = h.slice(colon + 1).trim();
    }
    else if (args[i] === '-d' || args[i] === '--data') { body = args[++i]; method = method === 'GET' ? 'POST' : method; }
    else if (args[i] === '-o' || args[i] === '--output') { /* output file — handled below */ }
    else if (args[i] === '-v' || args[i] === '--verbose') { /* verbose flag */ }
    else if (!args[i].startsWith('-')) { url = args[i]; }
  }

  if (!url) { stderr('fetch: missing URL\n'); return 1; }

  try {
    const opts = { method, headers };
    if (body) opts.body = body;
    const res = await globalThis.fetch(url, opts);
    const text = await res.text();
    stdout(text);
    if (!res.ok) { stderr(`HTTP ${res.status} ${res.statusText}\n`); return 1; }
    return 0;
  } catch (err) {
    stderr(`fetch: ${err.message}\n`);
    return 1;
  }
};

commands.curl = async (args, ctx) => {
  // Map curl-style flags to fetch flags
  const fetchArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-X') { fetchArgs.push('-m', args[++i]); }
    else if (args[i] === '-H') { fetchArgs.push('-H', args[++i]); }
    else if (args[i] === '-d' || args[i] === '--data') { fetchArgs.push('-d', args[++i]); }
    else if (args[i] === '-s' || args[i] === '--silent') { /* skip */ }
    else { fetchArgs.push(args[i]); }
  }
  return commands.fetch(fetchArgs, ctx);
};

// ─── TEXT EDITOR (vi/nano-like) ─────────────────────────────────────────────

commands.edit = async (args, { stdout, stderr, vfs, terminal }) => {
  if (args.length === 0) {
    stderr('Usage: edit <file>\n');
    return 1;
  }

  const filename = args[0];

  // Read existing file or create new
  let content = '';
  let isNewFile = false;
  try {
    content = await vfs.readFile(filename);
  } catch (err) {
    // New file
    isNewFile = true;
    content = '';
  }

  // Split into lines
  let lines = content ? content.split('\n') : [''];

  // Simple line-based editor interface
  stdout('\x1b[2J\x1b[H'); // Clear screen
  stdout(`\x1b[1;36m╔═══════════════════════════════════════════════════════════════╗\x1b[0m\n`);
  stdout(`\x1b[1;36m║\x1b[0m  \x1b[1;97mFoam Text Editor\x1b[0m - ${filename} ${isNewFile ? '(new file)' : ''}\x1b[1;36m║\x1b[0m\n`);
  stdout(`\x1b[1;36m╚═══════════════════════════════════════════════════════════════╝\x1b[0m\n\n`);

  // Display content with line numbers
  for (let i = 0; i < lines.length; i++) {
    const lineNum = String(i + 1).padStart(4, ' ');
    stdout(`\x1b[90m${lineNum} │\x1b[0m ${lines[i]}\n`);
  }

  stdout('\n');
  stdout('\x1b[33mCommands:\x1b[0m\n');
  stdout('  a <line> <text>  - Append text at line\n');
  stdout('  i <line> <text>  - Insert text at line\n');
  stdout('  d <line>         - Delete line\n');
  stdout('  c <line> <text>  - Change line content\n');
  stdout('  s                - Save and exit\n');
  stdout('  q                - Quit without saving\n');
  stdout('  p                - Print current content\n');
  stdout('\n');
  stdout('Enter command (or "s" to save): ');

  // For now, provide a simple save mechanism
  // In a real terminal, we'd enter interactive mode
  // For Foam, we'll use a different approach with edit scripts

  if (terminal && terminal.editorMode) {
    // Future: Interactive mode with terminal input
    return 0;
  } else {
    // Batch mode: return instructions
    stdout('\n\n\x1b[33mNote:\x1b[0m For interactive editing, use edit scripts:\n');
    stdout('  echo "line 1 content" > file.txt\n');
    stdout('  echo "line 2 content" >> file.txt\n');
    stdout('Or use the Edit tool in Spirit for direct file editing.\n');
    return 0;
  }
};

// Simplified editor commands that work in non-interactive mode
commands.nano = async (args, ctx) => {
  return commands.edit(args, ctx);
};

commands.vi = async (args, ctx) => {
  return commands.edit(args, ctx);
};

// ─── ED - Line Editor (sed-like, scriptable) ────────────────────────────────

commands.ed = async (args, { stdout, stderr, vfs }) => {
  if (args.length === 0) {
    stderr('Usage: ed <file> [commands]\n');
    stderr('Commands:\n');
    stderr('  <line>a <text>  - Append after line\n');
    stderr('  <line>i <text>  - Insert before line\n');
    stderr('  <line>d         - Delete line\n');
    stderr('  <line>c <text>  - Change line\n');
    stderr('  <line>s/<pattern>/<replacement>/  - Substitute\n');
    stderr('  w               - Write (save)\n');
    stderr('  p               - Print all\n');
    stderr('  <line>p         - Print line\n');
    stderr('\nExample: ed file.txt 1i "new first line" w\n');
    return 1;
  }

  const filename = args[0];
  const cmdArgs = args.slice(1);

  // Load file
  let lines = [];
  try {
    const content = await vfs.readFile(filename);
    lines = content.split('\n');
  } catch (err) {
    // New file
    lines = [''];
  }

  let modified = false;

  // Process commands
  for (let i = 0; i < cmdArgs.length; i++) {
    const cmd = cmdArgs[i];

    if (cmd === 'w' || cmd === 'wq') {
      await vfs.writeFile(filename, lines.join('\n'));
      stdout(`${lines.length} lines written\n`);
      modified = false;
      if (cmd === 'wq') break;
    } else if (cmd === 'p') {
      // Print all lines (plain)
      for (let j = 0; j < lines.length; j++) {
        stdout(`${lines[j]}\n`);
      }
    } else if (cmd === 'n') {
      // Print with line numbers
      for (let j = 0; j < lines.length; j++) {
        stdout(`${String(j + 1).padStart(4, ' ')}: ${lines[j]}\n`);
      }
    } else if (/^\/.*\/$/.test(cmd)) {
      // Search: /pattern/
      const pattern = cmd.slice(1, -1);
      const regex = new RegExp(pattern, 'i');
      let found = false;
      for (let j = 0; j < lines.length; j++) {
        if (regex.test(lines[j])) {
          stdout(`${j + 1}: ${lines[j]}\n`);
          found = true;
        }
      }
      if (!found) {
        stdout('No matches found\n');
      }
    } else if (/^\d+p$/.test(cmd)) {
      // Print specific line
      const lineNum = parseInt(cmd);
      if (lineNum > 0 && lineNum <= lines.length) {
        stdout(`${lines[lineNum - 1]}\n`);
      }
    } else if (/^\d+s\/.+\/.+\/$/.test(cmd)) {
      // Substitute: 1s/old/new/
      const match = cmd.match(/^(\d+)s\/(.+)\/(.+)\/$/);
      if (match) {
        const lineNum = parseInt(match[1]);
        const pattern = match[2];
        const replacement = match[3];
        if (lineNum > 0 && lineNum <= lines.length) {
          lines[lineNum - 1] = lines[lineNum - 1].replace(new RegExp(pattern, 'g'), replacement);
          modified = true;
          stdout(`${lineNum}: ${lines[lineNum - 1]}\n`);
        }
      }
    } else if (/^\d+a$/.test(cmd)) {
      const lineNum = parseInt(cmd);
      const text = cmdArgs[++i] || '';
      lines.splice(lineNum, 0, text);
      modified = true;
    } else if (/^\d+i$/.test(cmd)) {
      const lineNum = parseInt(cmd);
      const text = cmdArgs[++i] || '';
      lines.splice(lineNum - 1, 0, text);
      modified = true;
    } else if (/^\d+d$/.test(cmd)) {
      const lineNum = parseInt(cmd);
      if (lineNum > 0 && lineNum <= lines.length) {
        lines.splice(lineNum - 1, 1);
        modified = true;
      }
    } else if (/^\d+c$/.test(cmd)) {
      const lineNum = parseInt(cmd);
      const text = cmdArgs[++i] || '';
      if (lineNum > 0 && lineNum <= lines.length) {
        lines[lineNum - 1] = text;
        modified = true;
      }
    }
  }

  return 0;
};

// ─── JOB CONTROL ────────────────────────────────────────────────────────────

commands.jobs = async (args, { stdout, terminal }) => {
  if (!terminal || !terminal.shell) {
    stdout('jobs: no shell context\n');
    return 1;
  }

  const jobs = terminal.shell.jobs || [];
  if (jobs.length === 0) {
    return 0;
  }

  for (const job of jobs) {
    const status = job.status === 'running' ? 'Running' : 'Done';
    const marker = job.id === jobs.length ? '+' : ' ';
    stdout(`[${job.id}]${marker} ${status}\t${job.command}\n`);
  }

  return 0;
};

commands.fg = async (args, { stdout, stderr, terminal }) => {
  if (!terminal || !terminal.shell) {
    stderr('fg: no shell context\n');
    return 1;
  }

  const jobs = terminal.shell.jobs || [];
  const jobId = args[0] ? parseInt(args[0]) : jobs.length;

  const job = jobs.find(j => j.id === jobId);
  if (!job) {
    stderr(`fg: ${jobId}: no such job\n`);
    return 1;
  }

  // Bring to foreground - show output
  stdout(job.output.join(''));

  // Remove from background jobs if done
  if (job.status === 'done' || job.status === 'failed') {
    const idx = jobs.indexOf(job);
    if (idx !== -1) jobs.splice(idx, 1);
  }

  return job.exitCode || 0;
};

commands.bg = async (args, { stdout, stderr, terminal }) => {
  if (!terminal || !terminal.shell) {
    stderr('bg: no shell context\n');
    return 1;
  }

  const jobs = terminal.shell.jobs || [];
  const jobId = args[0] ? parseInt(args[0]) : jobs.length;

  const job = jobs.find(j => j.id === jobId);
  if (!job) {
    stderr(`bg: ${jobId}: no such job\n`);
    return 1;
  }

  stdout(`[${job.id}] ${job.command} &\n`);
  return 0;
};

// ─── ENVIRONMENT VARIABLES ──────────────────────────────────────────────────

commands.env = async (args, { stdout, vfs }) => {
  if (args.length === 0) {
    // Print all environment variables
    const env = vfs.env || {};
    const keys = Object.keys(env).sort();
    for (const key of keys) {
      stdout(`${key}=${env[key]}\n`);
    }
    return 0;
  }

  // env KEY=VALUE command - run command with modified environment
  // For now, just set the variable
  for (const arg of args) {
    if (arg.includes('=')) {
      const [key, ...rest] = arg.split('=');
      vfs.env[key] = rest.join('=');
    }
  }

  return 0;
};

commands.printenv = async (args, { stdout, vfs }) => {
  if (args.length === 0) {
    return commands.env([], { stdout, vfs });
  }

  // Print specific variables
  for (const key of args) {
    if (vfs.env[key] !== undefined) {
      stdout(`${vfs.env[key]}\n`);
    }
  }

  return 0;
};

commands.unset = async (args, { stderr, vfs }) => {
  if (args.length === 0) {
    stderr('Usage: unset <variable>\n');
    return 1;
  }

  for (const key of args) {
    delete vfs.env[key];
  }

  return 0;
};

// ─── XARGS ──────────────────────────────────────────────────────────────────

commands.xargs = async (args, { stdin, stdout, stderr, vfs, env, terminal, exec }) => {
  if (!stdin) { stderr('xargs: no stdin\n'); return 1; }
  if (!exec) { stderr('xargs: no exec context\n'); return 1; }

  // Parse flags
  let cmdTemplate = args.length > 0 ? args : ['echo'];
  let delimiter = '\n';
  let maxArgs = Infinity;
  let replaceStr = null;
  let i = 0;

  while (i < args.length) {
    if (args[i] === '-d' && args[i + 1]) { delimiter = args[i + 1]; i += 2; continue; }
    if (args[i] === '-n' && args[i + 1]) { maxArgs = parseInt(args[i + 1]); i += 2; continue; }
    if (args[i] === '-I' && args[i + 1]) { replaceStr = args[i + 1]; i += 2; continue; }
    if (args[i] === '-0') { delimiter = '\0'; i++; continue; }
    break;
  }
  cmdTemplate = args.slice(i);
  if (cmdTemplate.length === 0) cmdTemplate = ['echo'];

  // Split stdin into items
  const items = stdin.split(delimiter === '\n' ? /\r?\n/ : delimiter).filter(s => s.trim());

  let lastExit = 0;
  if (replaceStr) {
    // -I mode: run command once per item, replacing {} with item
    for (const item of items) {
      const cmd = cmdTemplate.map(a => a.replace(replaceStr, item)).join(' ');
      const result = await exec(cmd);
      if (result.stdout) stdout(result.stdout);
      if (result.stderr) stderr(result.stderr);
      lastExit = result.exitCode;
    }
  } else {
    // Batch mode: group items into batches of maxArgs
    for (let j = 0; j < items.length; j += maxArgs) {
      const batch = items.slice(j, j + maxArgs);
      const cmd = cmdTemplate.join(' ') + ' ' + batch.map(s => `"${s}"`).join(' ');
      const result = await exec(cmd);
      if (result.stdout) stdout(result.stdout);
      if (result.stderr) stderr(result.stderr);
      lastExit = result.exitCode;
    }
  }

  return lastExit;
};

// ─── LESS / MORE (pager) ────────────────────────────────────────────────────

commands.less = async (args, { stdin, stdout, stderr, vfs }) => {
  let content = '';

  if (args.length > 0) {
    // Read from file
    const filename = args[args.length - 1];
    if (filename.startsWith('-')) {
      // flags only, read from stdin
      content = stdin || '';
    } else {
      try {
        content = await vfs.readFile(filename);
      } catch (err) {
        stderr(`less: ${err.message}\n`);
        return 1;
      }
    }
  } else if (stdin) {
    content = stdin;
  } else {
    stderr('less: missing filename or stdin\n');
    return 1;
  }

  // In browser terminal, we output with line numbers for context
  const lines = content.split('\n');
  const showLineNumbers = args.includes('-N');

  for (let i = 0; i < lines.length; i++) {
    if (showLineNumbers) {
      stdout(`${String(i + 1).padStart(6)} ${lines[i]}\n`);
    } else {
      stdout(lines[i] + '\n');
    }
  }

  return 0;
};

commands.more = commands.less;

// ─── MAKE (basic) ───────────────────────────────────────────────────────────

commands.make = async (args, { stdout, stderr, vfs, exec }) => {
  if (!exec) { stderr('make: no exec context\n'); return 1; }

  const target = args[0] || 'all';
  let makefilePath = 'Makefile';

  // Check for -f flag
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-f' && args[i + 1]) { makefilePath = args[i + 1]; break; }
  }

  let content;
  try {
    content = await vfs.readFile(makefilePath);
  } catch {
    stderr(`make: *** No targets specified and no makefile found. Stop.\n`);
    return 2;
  }

  // Parse Makefile
  const targets = {};
  const lines = content.split('\n');
  let currentTarget = null;

  for (const line of lines) {
    if (line.startsWith('#') || line.trim() === '') continue;

    // Target line: name: deps
    const targetMatch = line.match(/^([A-Za-z0-9._-]+)\s*:\s*(.*)$/);
    if (targetMatch && !line.startsWith('\t')) {
      currentTarget = targetMatch[1];
      targets[currentTarget] = {
        deps: targetMatch[2].trim().split(/\s+/).filter(s => s),
        commands: []
      };
      continue;
    }

    // Recipe line (starts with tab)
    if ((line.startsWith('\t') || line.startsWith('  ')) && currentTarget) {
      targets[currentTarget].commands.push(line.trim());
    }
  }

  // Execute target
  const executed = new Set();

  async function runTarget(name) {
    if (executed.has(name)) return 0;
    executed.add(name);

    const t = targets[name];
    if (!t) {
      stderr(`make: *** No rule to make target '${name}'. Stop.\n`);
      return 2;
    }

    // Run dependencies first
    for (const dep of t.deps) {
      if (targets[dep]) {
        const result = await runTarget(dep);
        if (result !== 0) return result;
      }
    }

    // Run commands
    for (const cmd of t.commands) {
      const silent = cmd.startsWith('@');
      const actualCmd = silent ? cmd.slice(1) : cmd;
      if (!silent) stdout(`${actualCmd}\n`);
      const result = await exec(actualCmd);
      if (result.stdout) stdout(result.stdout);
      if (result.stderr) stderr(result.stderr);
      if (result.exitCode !== 0) {
        stderr(`make: *** [${name}] Error ${result.exitCode}\n`);
        return 2;
      }
    }

    return 0;
  }

  return runTarget(target);
};

// ─── TRUE / FALSE ───────────────────────────────────────────────────────────

commands.true = async () => 0;
commands.false = async () => 1;

// ─── READ (shell builtin for reading input) ─────────────────────────────────

commands.read = async (args, { stdin, vfs, stderr }) => {
  // read VAR — reads a line from stdin into VAR
  if (args.length === 0) { stderr('read: missing variable name\n'); return 1; }

  const varName = args[args.length - 1];
  let prompt = '';

  // Check for -p flag
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-p' && args[i + 1]) { prompt = args[i + 1]; i++; }
  }

  // Read from stdin
  const value = stdin ? stdin.split('\n')[0] : '';
  vfs.env[varName] = value;
  return 0;
};

// ─── PRINTF ─────────────────────────────────────────────────────────────────

commands.printf = async (args, { stdout }) => {
  if (args.length === 0) return 0;
  const format = args[0];
  const fmtArgs = args.slice(1);

  let result = '';
  let argIdx = 0;

  for (let i = 0; i < format.length; i++) {
    if (format[i] === '\\') {
      i++;
      switch (format[i]) {
        case 'n': result += '\n'; break;
        case 't': result += '\t'; break;
        case '\\': result += '\\'; break;
        case '0': result += '\0'; break;
        default: result += '\\' + format[i]; break;
      }
    } else if (format[i] === '%') {
      i++;
      if (format[i] === 's') { result += fmtArgs[argIdx++] || ''; }
      else if (format[i] === 'd') { result += parseInt(fmtArgs[argIdx++] || '0'); }
      else if (format[i] === '%') { result += '%'; }
      else { result += '%' + format[i]; }
    } else {
      result += format[i];
    }
  }

  stdout(result);
  return 0;
};

// ─── TEST COMMAND (for shell scripting conditionals) ───────────────────────

commands.test = async (args, { vfs }) => {
  if (args.length === 0) return 1;

  // Unary operators
  if (args.length === 2) {
    const op = args[0];
    const arg = args[1];

    switch (op) {
      case '-z': return arg === '' ? 0 : 1; // String is empty
      case '-n': return arg !== '' ? 0 : 1; // String is not empty
      case '-e': return await vfs.exists(arg) ? 0 : 1; // File exists
      case '-f': {
        try {
          const stat = await vfs.stat(arg);
          return stat.type === 'file' ? 0 : 1;
        } catch { return 1; }
      }
      case '-d': {
        try {
          const stat = await vfs.stat(arg);
          return stat.type === 'dir' ? 0 : 1;
        } catch { return 1; }
      }
      case '-r': return await vfs.exists(arg) ? 0 : 1; // File is readable
      case '-w': return await vfs.exists(arg) ? 0 : 1; // File is writable
      case '-x': return await vfs.exists(arg) ? 0 : 1; // File is executable
      case '!': {
        // Negation - recursively test rest
        return await commands.test(args.slice(1), { vfs }) === 0 ? 1 : 0;
      }
    }
  }

  // Binary operators
  if (args.length === 3) {
    const left = args[0];
    const op = args[1];
    const right = args[2];

    switch (op) {
      case '=':
      case '==': return left === right ? 0 : 1;
      case '!=': return left !== right ? 0 : 1;
      case '-eq': return parseInt(left) === parseInt(right) ? 0 : 1;
      case '-ne': return parseInt(left) !== parseInt(right) ? 0 : 1;
      case '-lt': return parseInt(left) < parseInt(right) ? 0 : 1;
      case '-le': return parseInt(left) <= parseInt(right) ? 0 : 1;
      case '-gt': return parseInt(left) > parseInt(right) ? 0 : 1;
      case '-ge': return parseInt(left) >= parseInt(right) ? 0 : 1;
    }
  }

  // Logical operators (AND/OR)
  if (args.length > 3) {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-a') {
        // AND: test left AND right
        const leftResult = await commands.test(args.slice(0, i), { vfs });
        if (leftResult !== 0) return 1;
        return commands.test(args.slice(i + 1), { vfs });
      }
      if (args[i] === '-o') {
        // OR: test left OR right
        const leftResult = await commands.test(args.slice(0, i), { vfs });
        if (leftResult === 0) return 0;
        return commands.test(args.slice(i + 1), { vfs });
      }
    }
  }

  // Default: treat as non-empty string test
  const str = args.join(' ');
  return str.trim() !== '' ? 0 : 1;
};

// ─── SPIRIT (AI coding agent) ────────────────────────────────────────────────

commands.spirit = async (args, { stdout, stderr, vfs }) => {
  const prompt = args.join(' ').replace(/^["']|["']$/g, '');

  // Check for API key
  const apiKey = vfs.env['ANTHROPIC_API_KEY'] || localStorage.getItem('foam_api_key') || '';
  if (!apiKey) {
    stdout([
      'Spirit - AI Coding Agent for Foam OS',
      '',
      'Spirit is not configured. To set up:',
      '',
      '  foam config set api_key sk-ant-your-key-here',
      '  # or',
      '  export ANTHROPIC_API_KEY=sk-ant-your-key-here',
      '',
      '  spirit "your prompt here"',
      '',
      'Spirit uses Claude to read, write, and edit files',
      'in your Foam filesystem with access to all shell commands.',
      '',
      'Slash commands: /help, /clear, /model, /stats, /thinking, /cost',
      '',
    ].join('\n'));
    return 1;
  }

  if (!prompt) {
    stdout('Usage: spirit "your message"\n');
    stdout('Spirit slash commands: /help, /clear, /compact, /stats\n');
    return 0;
  }

  // Get or create Spirit agent from global state
  const foam = window.__foam;
  if (!foam || !foam.provider) {
    stderr('spirit: Foam not fully initialized\n');
    return 1;
  }

  try {
    // Dynamically import SpiritAgent if not already available
    let SpiritAgent = foam._SpiritAgent;
    if (!SpiritAgent) {
      const mod = await import('../spirit/dist/spirit.js');
      SpiritAgent = mod.SpiritAgent;
      foam._SpiritAgent = SpiritAgent;
    }

    const agent = new SpiritAgent(foam.provider, {
      apiKey,
      model: vfs.env['SPIRIT_MODEL'] || 'claude-sonnet-4-20250514',
      maxTurns: parseInt(vfs.env['SPIRIT_MAX_TURNS'] || '30', 10),
      maxTokens: parseInt(vfs.env['SPIRIT_MAX_TOKENS'] || '8192', 10),
      thinkingBudget: vfs.env['SPIRIT_THINKING']
        ? parseInt(vfs.env['SPIRIT_THINKING'], 10)
        : undefined,
      onText: (text) => stdout(text),
      onThinking: (thinking) => stdout(`\x1b[2m${thinking}\x1b[0m`),
      onToolStart: (name, input) => {
        const summary = name === 'Bash' || name === 'bash'
          ? `$ ${input.command}`
          : name === 'Read' || name === 'read_file'
            ? `Reading ${input.file_path || input.path}`
            : name === 'Write' || name === 'write_file'
              ? `Writing ${input.file_path || input.path}`
              : name === 'Edit' || name === 'edit_file'
                ? `Editing ${input.file_path || input.path}`
                : name === 'Glob' || name === 'glob'
                  ? `Glob ${input.pattern}`
                  : `${name}`;
        stdout(`\x1b[36m⟫ ${summary}\x1b[0m\n`);
      },
      onToolEnd: () => {},
      onError: (error) => stderr(`\x1b[31mError: ${error.message}\x1b[0m\n`),
    });

    // Handle slash commands
    if (prompt.startsWith('/')) {
      const { handled, output } = await agent.handleSlashCommand(prompt);
      if (handled) {
        if (output) stdout(output + '\n');
        return 0;
      }
    }

    await agent.run(prompt);
    stdout('\n');
    return 0;
  } catch (e) {
    stderr(`spirit: ${e.message || e}\n`);
    if (e.stack) stderr(`${e.stack}\n`);
    return 1;
  }
};

// ─── CLAUDE (legacy direct API client) ───────────────────────────────────────

commands.claude = async (args, { stdout, stderr, vfs }) => {
  const prompt = args.join(' ').replace(/^["']|["']$/g, '');

  const apiKey = vfs.env['ANTHROPIC_API_KEY'] || localStorage.getItem('foam_api_key') || '';
  if (!apiKey) {
    stderr('No API key set. Run: foam config set api_key YOUR_KEY\n');
    return 1;
  }

  if (!prompt) {
    stdout('Usage: claude "your message"\n');
    return 0;
  }

  const foam = window.__foam;
  if (foam && foam.claude) {
    foam.claude.setApiKey(apiKey);
    await foam.claude.chat(prompt);
    return 0;
  }

  stderr('claude: client not initialized\n');
  return 1;
};

// ─── FOAM CONFIG ─────────────────────────────────────────────────────────────

commands.foam = async (args, { stdout, stderr }) => {
  if (args[0] === 'config' && args[1] === 'set' && args[2] === 'api_key' && args[3]) {
    localStorage.setItem('foam_api_key', args[3]);
    stdout('API key saved.\n');
    return 0;
  }
  if (args[0] === 'config' && args[1] === 'get' && args[2] === 'api_key') {
    const key = localStorage.getItem('foam_api_key');
    stdout(key ? 'sk-ant-...' + key.slice(-8) + '\n' : '(not set)\n');
    return 0;
  }
  stdout('Usage:\n');
  stdout('  foam config set api_key <key>\n');
  stdout('  foam config get api_key\n');
  return 0;
};

// ─── UPLOAD / DOWNLOAD ───────────────────────────────────────────────────────

commands.upload = async (args, { stdout, stderr, vfs }) => {
  const targetDir = args[0] || '.';

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', async () => {
      const files = input.files;
      if (!files || files.length === 0) {
        stdout('No files selected.\n');
        document.body.removeChild(input);
        resolve(0);
        return;
      }

      for (const file of files) {
        try {
          const content = await file.text();
          const destPath = targetDir === '.'
            ? file.name
            : `${targetDir}/${file.name}`;
          await vfs.writeFile(destPath, content);
          stdout(`Uploaded: ${destPath} (${file.size} bytes)\n`);
        } catch (err) {
          stderr(`Failed to upload ${file.name}: ${err.message}\n`);
        }
      }
      document.body.removeChild(input);
      resolve(0);
    });

    input.addEventListener('cancel', () => {
      stdout('Upload cancelled.\n');
      document.body.removeChild(input);
      resolve(0);
    });

    // Timeout fallback in case no event fires
    setTimeout(() => {
      if (document.body.contains(input)) {
        document.body.removeChild(input);
      }
    }, 120000);

    input.click();
  });
};

commands.download = async (args, { stdout, stderr, vfs }) => {
  if (args.length === 0) {
    stderr('Usage: download <file> [file2 ...]\n');
    return 1;
  }

  for (const filePath of args) {
    try {
      const content = await vfs.readFile(filePath);
      const blob = new Blob([content], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filePath.split('/').pop();
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      stdout(`Downloaded: ${filePath}\n`);
    } catch (err) {
      stderr(`download: ${err.message}\n`);
      return 1;
    }
  }
  return 0;
};

export default commands;
