// Shell interpreter — parses command lines, handles pipes, redirects, variables, logic operators
import commands from './commands.js';

class Shell {
  constructor(vfs) {
    this.vfs = vfs;
    this.lastExitCode = 0;
    this.aliases = {};
    this.terminal = null; // Set by terminal UI
  }

  // Main entry: execute a command string, return { stdout, stderr, exitCode }
  async exec(input) {
    const stdout = [];
    const stderr = [];
    const exitCode = await this._execLine(input, {
      stdout: (t) => stdout.push(t),
      stderr: (t) => stderr.push(t),
    });
    this.lastExitCode = exitCode;
    return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode };
  }

  // Execute with live output (for terminal UI)
  async execLive(input, { stdout, stderr }) {
    const exitCode = await this._execLine(input, { stdout, stderr });
    this.lastExitCode = exitCode;
    return exitCode;
  }

  async _execLine(input, { stdout, stderr }) {
    input = input.trim();
    if (!input || input.startsWith('#')) return 0;

    // Expand variables
    input = this._expandVars(input);

    // Split on ; (respecting quotes)
    const statements = this._splitStatements(input);
    let exitCode = 0;

    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;

      // Handle && and ||
      const logicParts = this._splitLogic(trimmed);
      exitCode = await this._execLogicChain(logicParts, { stdout, stderr });
    }

    return exitCode;
  }

  async _execLogicChain(parts, { stdout, stderr }) {
    let exitCode = 0;
    let i = 0;

    while (i < parts.length) {
      const part = parts[i];

      if (part === '&&') {
        i++;
        if (exitCode !== 0) { // Skip — previous failed
          i++; // skip the command after &&
          continue;
        }
        continue;
      }
      if (part === '||') {
        i++;
        if (exitCode === 0) { // Skip — previous succeeded
          i++;
          continue;
        }
        continue;
      }

      exitCode = await this._execPipeline(part, { stdout, stderr });
      this.lastExitCode = exitCode;
      i++;
    }

    return exitCode;
  }

  async _execPipeline(input, { stdout, stderr }) {
    const segments = this._splitPipes(input);
    if (segments.length === 1) {
      return this._execSingle(segments[0].trim(), { stdin: null, stdout, stderr });
    }

    let currentStdin = null;
    for (let i = 0; i < segments.length; i++) {
      const isLast = i === segments.length - 1;
      const captured = [];
      const segStdout = isLast ? stdout : (t) => captured.push(t);
      await this._execSingle(segments[i].trim(), {
        stdin: currentStdin,
        stdout: segStdout,
        stderr,
      });
      currentStdin = captured.join('');
    }
    return this.lastExitCode;
  }

  async _execSingle(input, { stdin, stdout, stderr }) {
    if (!input) return 0;

    // Handle command substitution $() before parsing
    input = await this._expandCommandSubstitution(input, stderr);

    // Parse redirects
    const { cmd, redirects } = this._parseRedirects(input);
    if (!cmd.trim()) return 0;

    // Tokenize
    const tokens = this._tokenize(cmd);
    if (tokens.length === 0) return 0;

    const name = tokens[0];
    const args = tokens.slice(1);

    // Handle variable assignment: VAR=value
    if (name.includes('=') && !name.startsWith('=') && /^[A-Za-z_]/.test(name)) {
      const eq = name.indexOf('=');
      this.vfs.env[name.slice(0, eq)] = name.slice(eq + 1);
      return 0;
    }

    // Apply alias
    const cmdName = this.aliases[name] || name;

    // Find command
    const cmdFn = commands[cmdName];
    if (!cmdFn) {
      stderr(`${cmdName}: command not found\n`);
      return 127;
    }

    // Set up redirect outputs
    let actualStdout = stdout;
    let actualStderr = stderr;
    let fileOutputs = [];

    for (const r of redirects) {
      if (r.type === '>' || r.type === '>>') {
        const captured = [];
        actualStdout = (t) => captured.push(t);
        fileOutputs.push({ path: r.file, append: r.type === '>>', captured });
      } else if (r.type === '2>') {
        const captured = [];
        actualStderr = (t) => captured.push(t);
        fileOutputs.push({ path: r.file, append: false, captured });
      } else if (r.type === '<') {
        try { stdin = await this.vfs.readFile(r.file); }
        catch (err) { stderr(err.message + '\n'); return 1; }
      }
    }

    // Build context
    const ctx = {
      stdin,
      stdout: actualStdout,
      stderr: actualStderr,
      vfs: this.vfs,
      env: this.vfs.env,
      terminal: this.terminal,
      exec: (cmd) => this.exec(cmd),
    };

    let exitCode;
    try {
      exitCode = await cmdFn(args, ctx);
    } catch (err) {
      stderr(err.message + '\n');
      exitCode = 1;
    }

    // Write file redirect outputs
    for (const fo of fileOutputs) {
      try {
        await this.vfs.writeFile(fo.path, fo.captured.join(''), { append: fo.append });
      } catch (err) {
        stderr(err.message + '\n');
      }
    }

    // If stdout was redirected, also pipe to real stdout for pipeline
    if (fileOutputs.length > 0) {
      for (const fo of fileOutputs) {
        // Don't echo to stdout when redirected to file, unless tee
      }
    }

    return exitCode ?? 0;
  }

  _expandVars(input) {
    return input.replace(/\$\{([A-Za-z_]\w*)\}/g, (_, name) => this.vfs.env[name] || '')
                .replace(/\$([A-Za-z_]\w*)/g, (_, name) => this.vfs.env[name] || '')
                .replace(/\$\?/g, String(this.lastExitCode));
  }

  async _expandCommandSubstitution(input, stderr) {
    const result = [];
    let i = 0;
    while (i < input.length) {
      if (input[i] === '$' && input[i + 1] === '(') {
        let depth = 1;
        let j = i + 2;
        while (j < input.length && depth > 0) {
          if (input[j] === '(') depth++;
          if (input[j] === ')') depth--;
          j++;
        }
        const subCmd = input.slice(i + 2, j - 1);
        const subResult = await this.exec(subCmd);
        if (subResult.stderr) stderr(subResult.stderr);
        result.push(subResult.stdout.replace(/\n$/, ''));
        i = j;
      } else if (input[i] === '`') {
        let j = input.indexOf('`', i + 1);
        if (j === -1) { result.push(input.slice(i)); break; }
        const subCmd = input.slice(i + 1, j);
        const subResult = await this.exec(subCmd);
        if (subResult.stderr) stderr(subResult.stderr);
        result.push(subResult.stdout.replace(/\n$/, ''));
        i = j + 1;
      } else {
        result.push(input[i]);
        i++;
      }
    }
    return result.join('');
  }

  _tokenize(input) {
    const tokens = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escape = false;

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];

      if (escape) {
        current += ch;
        escape = false;
        continue;
      }

      if (ch === '\\' && !inSingle) {
        escape = true;
        continue;
      }

      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }

      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }

      if (ch === ' ' && !inSingle && !inDouble) {
        if (current) { tokens.push(current); current = ''; }
        continue;
      }

      current += ch;
    }
    if (current) tokens.push(current);
    return tokens;
  }

  _splitStatements(input) {
    // Split on unquoted ;
    const result = [];
    let current = '';
    let inSingle = false, inDouble = false, escape = false;

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (escape) { current += ch; escape = false; continue; }
      if (ch === '\\') { escape = true; current += ch; continue; }
      if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
      if (ch === ';' && !inSingle && !inDouble) {
        result.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    if (current) result.push(current);
    return result;
  }

  _splitLogic(input) {
    const parts = [];
    let current = '';
    let inSingle = false, inDouble = false, escape = false;

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (escape) { current += ch; escape = false; continue; }
      if (ch === '\\') { escape = true; current += ch; continue; }
      if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
      if (!inSingle && !inDouble) {
        if (ch === '&' && input[i + 1] === '&') {
          if (current.trim()) parts.push(current.trim());
          parts.push('&&');
          current = '';
          i++;
          continue;
        }
        if (ch === '|' && input[i + 1] === '|') {
          if (current.trim()) parts.push(current.trim());
          parts.push('||');
          current = '';
          i++;
          continue;
        }
      }
      current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  _splitPipes(input) {
    const parts = [];
    let current = '';
    let inSingle = false, inDouble = false, escape = false;

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (escape) { current += ch; escape = false; continue; }
      if (ch === '\\') { escape = true; current += ch; continue; }
      if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
      if (ch === '|' && !inSingle && !inDouble && input[i + 1] !== '|') {
        parts.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    if (current) parts.push(current);
    return parts;
  }

  _parseRedirects(input) {
    const redirects = [];
    let cmd = '';
    let i = 0;
    let inSingle = false, inDouble = false, escape = false;

    while (i < input.length) {
      const ch = input[i];
      if (escape) { cmd += ch; escape = false; i++; continue; }
      if (ch === '\\') { escape = true; cmd += ch; i++; continue; }
      if (ch === "'" && !inDouble) { inSingle = !inSingle; cmd += ch; i++; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; cmd += ch; i++; continue; }

      if (!inSingle && !inDouble) {
        if (ch === '>' && input[i + 1] === '>') {
          const file = this._readRedirectTarget(input, i + 2);
          redirects.push({ type: '>>', file: file.value });
          i = file.end;
          continue;
        }
        if (ch === '2' && input[i + 1] === '>') {
          const file = this._readRedirectTarget(input, i + 2);
          redirects.push({ type: '2>', file: file.value });
          i = file.end;
          continue;
        }
        if (ch === '>') {
          const file = this._readRedirectTarget(input, i + 1);
          redirects.push({ type: '>', file: file.value });
          i = file.end;
          continue;
        }
        if (ch === '<') {
          const file = this._readRedirectTarget(input, i + 1);
          redirects.push({ type: '<', file: file.value });
          i = file.end;
          continue;
        }
      }

      cmd += ch;
      i++;
    }

    return { cmd: cmd.trim(), redirects };
  }

  _readRedirectTarget(input, start) {
    let i = start;
    while (i < input.length && input[i] === ' ') i++;
    let value = '';
    while (i < input.length && input[i] !== ' ' && input[i] !== '>' && input[i] !== '<') {
      value += input[i];
      i++;
    }
    return { value, end: i };
  }
}

export default Shell;
