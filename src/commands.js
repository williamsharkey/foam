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
  stdout('Dev tools:     git, npm, node\n');
  stdout('Claude:        claude "your message"\n');
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

export default commands;
