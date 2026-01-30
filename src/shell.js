// Shell interpreter — parses command lines, handles pipes, redirects, variables, logic operators
import commands from './commands.js';

class Shell {
  constructor(vfs) {
    this.vfs = vfs;
    this.lastExitCode = 0;
    this.aliases = {};
    this.terminal = null; // Set by terminal UI
    this.jobs = []; // Background jobs
    this.nextJobId = 1;
    this.currentJob = null; // Foreground job
    this.functions = {}; // Shell functions: name -> { body, params }
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

    // Check for function definition: name() { ... } or function name { ... }
    const funcDef = this._parseFunctionDef(input);
    if (funcDef) {
      this.functions[funcDef.name] = { body: funcDef.body };
      return 0;
    }

    // Check for control structures (if/while/for/case)
    if (this._isControlStructure(input)) {
      return this._execControlStructure(input, { stdout, stderr });
    }

    // Expand arithmetic $((...))
    input = this._expandArithmetic(input);

    // Note: variable expansion is deferred to per-command execution
    // in _execLogicChain so that `export X=1 && echo $X` works correctly.

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

      // Expand variables per-command so prior commands (e.g. export) take effect
      const expanded = this._expandVars(part);
      exitCode = await this._execPipeline(expanded, { stdout, stderr });
      this.lastExitCode = exitCode;
      i++;
    }

    return exitCode;
  }

  async _execPipeline(input, { stdout, stderr }) {
    // Check for background job (&)
    const isBackground = input.trim().endsWith('&');
    if (isBackground) {
      input = input.trim().slice(0, -1).trim();
    }

    const segments = this._splitPipes(input);

    if (isBackground) {
      // Start job in background
      const jobId = this.nextJobId++;
      const job = {
        id: jobId,
        command: input,
        status: 'running',
        pid: Date.now(), // Fake PID
        output: [],
        exitCode: null,
      };

      this.jobs.push(job);
      stdout(`[${jobId}] ${job.pid}\n`);

      // Run in background (non-blocking)
      (async () => {
        try {
          const jobStdout = (t) => job.output.push(t);
          const jobStderr = (t) => job.output.push(t);

          if (segments.length === 1) {
            job.exitCode = await this._execSingle(segments[0].trim(), {
              stdin: null,
              stdout: jobStdout,
              stderr: jobStderr,
            });
          } else {
            let currentStdin = null;
            for (let i = 0; i < segments.length; i++) {
              const isLast = i === segments.length - 1;
              const captured = [];
              const segStdout = isLast ? jobStdout : (t) => captured.push(t);
              await this._execSingle(segments[i].trim(), {
                stdin: currentStdin,
                stdout: segStdout,
                stderr: jobStderr,
              });
              currentStdin = captured.join('');
            }
            job.exitCode = this.lastExitCode;
          }

          job.status = 'done';
          if (this.terminal) {
            this.terminal.write(`\n[${jobId}]+ Done\t${job.command}\n`);
          }
        } catch (err) {
          job.status = 'failed';
          job.exitCode = 1;
          job.output.push(`Error: ${err.message}\n`);
        }
      })();

      return 0; // Background job started
    }

    // Foreground execution
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

    // Check for shell function
    if (this.functions[cmdName]) {
      return this._execFunction(cmdName, args, { stdin, stdout, stderr });
    }

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
      } else if (r.type === '2>&1') {
        // Redirect stderr to stdout
        actualStderr = actualStdout;
      } else if (r.type === '2>') {
        const captured = [];
        actualStderr = (t) => captured.push(t);
        fileOutputs.push({ path: r.file, append: false, captured });
      } else if (r.type === '<') {
        if (r.heredocContent !== undefined) {
          stdin = r.heredocContent;
        } else {
          try { stdin = await this.vfs.readFile(r.file); }
          catch (err) { stderr(err.message + '\n'); return 1; }
        }
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
        if (ch === '2' && input[i + 1] === '>' && input[i + 2] === '&' && input[i + 3] === '1') {
          redirects.push({ type: '2>&1', file: '' });
          i += 4;
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
        if (ch === '<' && input[i + 1] === '<') {
          // Here document: <<DELIM or <<-DELIM or <<'DELIM'
          const heredoc = this._parseHeredoc(input, i + 2);
          redirects.push({ type: '<', file: '__heredoc__', heredocContent: heredoc.content });
          i = heredoc.end;
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

  // ─── SHELL SCRIPTING CONTROL STRUCTURES ─────────────────────────────────────

  _isControlStructure(input) {
    const trimmed = input.trim();
    return /^if\s+/.test(trimmed) ||
           /^while\s+/.test(trimmed) ||
           /^for\s+/.test(trimmed) ||
           /^case\s+/.test(trimmed);
  }

  async _execControlStructure(input, { stdout, stderr }) {
    const trimmed = input.trim();

    // if/then/else/fi
    if (/^if\s+/.test(trimmed)) {
      return this._execIf(trimmed, { stdout, stderr });
    }

    // while/do/done
    if (/^while\s+/.test(trimmed)) {
      return this._execWhile(trimmed, { stdout, stderr });
    }

    // for/in/do/done
    if (/^for\s+/.test(trimmed)) {
      return this._execFor(trimmed, { stdout, stderr });
    }

    // case/esac
    if (/^case\s+/.test(trimmed)) {
      return this._execCase(trimmed, { stdout, stderr });
    }

    return 0;
  }

  async _execIf(input, { stdout, stderr }) {
    // Parse: if <condition>; then <commands>; [elif <condition>; then <commands>;]* [else <commands>;] fi
    const lines = input.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    // Find structural keywords
    let thenIdx = -1, elseIdx = -1, elifIndices = [], fiIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === 'then' || line.startsWith('then ') || line.endsWith('; then')) thenIdx = i;
      else if (line === 'else' || line.startsWith('else ') || line.endsWith('; else')) elseIdx = i;
      else if (/^elif\s+/.test(line) || /;\s*elif\s+/.test(line)) elifIndices.push(i);
      else if (line === 'fi' || line.startsWith('fi ') || line.endsWith('; fi')) fiIdx = i;
    }

    // Simple single-line format: if <condition>; then <command>; fi
    if (lines.length === 1) {
      const match = lines[0].match(/^if\s+(.+?);\s*then\s+(.+?);\s*fi$/);
      if (match) {
        const condition = match[1];
        const thenCmd = match[2];
        const condResult = await this._evalCondition(condition, { stdout, stderr });
        if (condResult === 0) {
          return this._execLine(thenCmd, { stdout, stderr });
        }
        return 0;
      }
    }

    // Multi-line format
    const ifLine = lines[0];
    const condMatch = ifLine.match(/^if\s+(.+?)(?:;\s*then)?$/);
    if (!condMatch) {
      stderr('if: syntax error\n');
      return 1;
    }

    const condition = condMatch[1];
    const condResult = await this._evalCondition(condition, { stdout, stderr });

    if (condResult === 0) {
      // Execute then block
      const thenStart = thenIdx + 1;
      const thenEnd = elifIndices.length > 0 ? elifIndices[0] : (elseIdx >= 0 ? elseIdx : fiIdx);
      const thenBlock = lines.slice(thenStart, thenEnd).join('\n');
      if (thenBlock.trim()) {
        return this._execLine(thenBlock, { stdout, stderr });
      }
    } else if (elifIndices.length > 0) {
      // Handle elif chains
      for (let i = 0; i < elifIndices.length; i++) {
        const elifIdx = elifIndices[i];
        const elifLine = lines[elifIdx];
        const elifMatch = elifLine.match(/elif\s+(.+?)(?:;\s*then)?$/);
        if (elifMatch) {
          const elifCond = elifMatch[1];
          const elifResult = await this._evalCondition(elifCond, { stdout, stderr });
          if (elifResult === 0) {
            const elifStart = elifIdx + 1;
            const elifEnd = i + 1 < elifIndices.length ? elifIndices[i + 1] : (elseIdx >= 0 ? elseIdx : fiIdx);
            const elifBlock = lines.slice(elifStart, elifEnd).join('\n');
            if (elifBlock.trim()) {
              return this._execLine(elifBlock, { stdout, stderr });
            }
            return 0;
          }
        }
      }
    }

    // Execute else block if condition failed
    if (condResult !== 0 && elseIdx >= 0) {
      const elseStart = elseIdx + 1;
      const elseEnd = fiIdx;
      const elseBlock = lines.slice(elseStart, elseEnd).join('\n');
      if (elseBlock.trim()) {
        return this._execLine(elseBlock, { stdout, stderr });
      }
    }

    return 0;
  }

  async _execWhile(input, { stdout, stderr }) {
    // Parse: while <condition>; do <commands>; done
    const lines = input.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    // Single-line format: while <condition>; do <command>; done
    if (lines.length === 1) {
      const match = lines[0].match(/^while\s+(.+?);\s*do\s+(.+?);\s*done$/);
      if (match) {
        const condition = match[1];
        const body = match[2];
        let iterations = 0;
        const maxIterations = 10000; // Safety limit
        while (iterations < maxIterations) {
          const condResult = await this._evalCondition(condition, { stdout, stderr });
          if (condResult !== 0) break;
          await this._execLine(body, { stdout, stderr });
          iterations++;
        }
        return 0;
      }
    }

    // Multi-line format
    const whileLine = lines[0];
    const condMatch = whileLine.match(/^while\s+(.+?)(?:;\s*do)?$/);
    if (!condMatch) {
      stderr('while: syntax error\n');
      return 1;
    }

    const condition = condMatch[1];
    let doIdx = -1, doneIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === 'do' || line.startsWith('do ') || line.endsWith('; do')) doIdx = i;
      if (line === 'done' || line.startsWith('done ') || line.endsWith('; done')) doneIdx = i;
    }

    const bodyStart = doIdx >= 0 ? doIdx + 1 : 1;
    const bodyEnd = doneIdx >= 0 ? doneIdx : lines.length;
    const body = lines.slice(bodyStart, bodyEnd).join('\n');

    let iterations = 0;
    const maxIterations = 10000; // Safety limit
    while (iterations < maxIterations) {
      const condResult = await this._evalCondition(condition, { stdout, stderr });
      if (condResult !== 0) break;
      if (body.trim()) {
        await this._execLine(body, { stdout, stderr });
      }
      iterations++;
    }

    return 0;
  }

  async _execFor(input, { stdout, stderr }) {
    // Parse: for VAR in <list>; do <commands>; done
    const lines = input.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    // Single-line format: for i in 1 2 3; do echo $i; done
    if (lines.length === 1) {
      const match = lines[0].match(/^for\s+(\w+)\s+in\s+(.+?);\s*do\s+(.+?);\s*done$/);
      if (match) {
        const varName = match[1];
        const listStr = match[2];
        const body = match[3];
        const items = this._expandVars(listStr).split(/\s+/).filter(x => x);

        for (const item of items) {
          this.vfs.env[varName] = item;
          await this._execLine(body, { stdout, stderr });
        }
        return 0;
      }
    }

    // Multi-line format
    const forLine = lines[0];
    const forMatch = forLine.match(/^for\s+(\w+)\s+in\s+(.+?)(?:;\s*do)?$/);
    if (!forMatch) {
      stderr('for: syntax error\n');
      return 1;
    }

    const varName = forMatch[1];
    const listStr = forMatch[2];
    const items = this._expandVars(listStr).split(/\s+/).filter(x => x);

    let doIdx = -1, doneIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === 'do' || line.startsWith('do ') || line.endsWith('; do')) doIdx = i;
      if (line === 'done' || line.startsWith('done ') || line.endsWith('; done')) doneIdx = i;
    }

    const bodyStart = doIdx >= 0 ? doIdx + 1 : 1;
    const bodyEnd = doneIdx >= 0 ? doneIdx : lines.length;
    const body = lines.slice(bodyStart, bodyEnd).join('\n');

    for (const item of items) {
      this.vfs.env[varName] = item;
      if (body.trim()) {
        await this._execLine(body, { stdout, stderr });
      }
    }

    return 0;
  }

  async _execCase(input, { stdout, stderr }) {
    // Parse: case <word> in <pattern>) <commands>;; esac
    const lines = input.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    const caseLine = lines[0];
    const caseMatch = caseLine.match(/^case\s+(.+?)\s+in$/);
    if (!caseMatch) {
      stderr('case: syntax error\n');
      return 1;
    }

    const word = this._expandVars(caseMatch[1]);

    // Find esac
    let esacIdx = lines.findIndex(l => l === 'esac' || l.startsWith('esac '));
    if (esacIdx < 0) esacIdx = lines.length;

    // Parse pattern blocks
    let i = 1;
    while (i < esacIdx) {
      const line = lines[i];

      // Pattern line: pattern) or pattern )
      const patternMatch = line.match(/^(.+?)\s*\)/);
      if (patternMatch) {
        const patterns = patternMatch[1].split('|').map(p => p.trim());
        let matched = false;

        // Check if word matches any pattern
        for (const pattern of patterns) {
          if (pattern === '*' || word === pattern || this._globMatch(word, pattern)) {
            matched = true;
            break;
          }
        }

        if (matched) {
          // Execute commands until ;;
          i++;
          const commandLines = [];
          while (i < esacIdx && !lines[i].endsWith(';;')) {
            commandLines.push(lines[i]);
            i++;
          }
          // Handle last line with ;;
          if (i < esacIdx && lines[i].endsWith(';;')) {
            const lastLine = lines[i].replace(/;;\s*$/, '').trim();
            if (lastLine) commandLines.push(lastLine);
          }

          if (commandLines.length > 0) {
            return this._execLine(commandLines.join('\n'), { stdout, stderr });
          }
          return 0;
        }
      }

      i++;
    }

    return 0;
  }

  async _evalCondition(condition, { stdout, stderr }) {
    // Evaluate condition - could be:
    // 1. [ ... ] or test ...
    // 2. Command that returns exit code

    const trimmed = condition.trim();

    // Handle [ ... ] syntax
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const testArgs = trimmed.slice(1, -1).trim();
      return this._execTestCommand(testArgs, { stdout, stderr });
    }

    // Handle explicit test command
    if (trimmed.startsWith('test ')) {
      const testArgs = trimmed.slice(5);
      return this._execTestCommand(testArgs, { stdout, stderr });
    }

    // Otherwise execute as command and return exit code
    const result = await this.exec(trimmed);
    if (result.stderr) stderr(result.stderr);
    if (result.stdout) stdout(result.stdout);
    return result.exitCode;
  }

  async _execTestCommand(args, { stdout, stderr }) {
    // Simple test command implementation for basic conditions
    const tokens = args.split(/\s+/);

    if (tokens.length === 0) return 1;

    // Unary operators
    if (tokens.length === 2) {
      const op = tokens[0];
      const arg = this._expandVars(tokens[1]);

      switch (op) {
        case '-z': return arg === '' ? 0 : 1; // String is empty
        case '-n': return arg !== '' ? 0 : 1; // String is not empty
        case '-e': return await this.vfs.exists(arg) ? 0 : 1; // File exists
        case '-f': {
          try {
            const stat = await this.vfs.stat(arg);
            return stat.type === 'file' ? 0 : 1;
          } catch { return 1; }
        }
        case '-d': {
          try {
            const stat = await this.vfs.stat(arg);
            return stat.type === 'dir' ? 0 : 1;
          } catch { return 1; }
        }
        case '!': {
          // Negation - recursively eval rest
          const restResult = await this._execTestCommand(tokens.slice(1).join(' '), { stdout, stderr });
          return restResult === 0 ? 1 : 0;
        }
      }
    }

    // Binary operators
    if (tokens.length === 3) {
      const left = this._expandVars(tokens[0]);
      const op = tokens[1];
      const right = this._expandVars(tokens[2]);

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

    // Default: treat as non-empty string test
    const str = this._expandVars(args);
    return str.trim() !== '' ? 0 : 1;
  }

  _globMatch(str, pattern) {
    // Simple glob matching for case statements
    const regexPattern = pattern
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${regexPattern}$`).test(str);
  }

  // ─── SHELL FUNCTIONS ──────────────────────────────────────────────────────

  _parseFunctionDef(input) {
    // Match: name() { body } or function name { body } or function name() { body }
    // Single-line: greet() { echo hello; }
    // Multi-line: function greet {\n  echo hello\n}
    let match = input.match(/^(\w+)\s*\(\)\s*\{([\s\S]*)\}$/);
    if (!match) match = input.match(/^function\s+(\w+)\s*(?:\(\))?\s*\{([\s\S]*)\}$/);
    if (match) {
      return { name: match[1], body: match[2].trim() };
    }
    return null;
  }

  async _execFunction(name, args, { stdin, stdout, stderr }) {
    const func = this.functions[name];
    if (!func) return 127;

    // Save positional parameters
    const savedArgs = {};
    for (let i = 0; i <= args.length; i++) {
      savedArgs[String(i)] = this.vfs.env[String(i)];
    }
    const savedPound = this.vfs.env['#'];
    const savedAt = this.vfs.env['@'];
    const savedStar = this.vfs.env['*'];

    // Set positional parameters
    this.vfs.env['0'] = name;
    for (let i = 0; i < args.length; i++) {
      this.vfs.env[String(i + 1)] = args[i];
    }
    this.vfs.env['#'] = String(args.length);
    this.vfs.env['@'] = args.join(' ');
    this.vfs.env['*'] = args.join(' ');

    // Execute function body
    let exitCode = 0;
    const bodyLines = func.body.split(/\n|;/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    for (const line of bodyLines) {
      if (line === 'return' || line.startsWith('return ')) {
        const retMatch = line.match(/^return\s+(\d+)?/);
        exitCode = retMatch && retMatch[1] ? parseInt(retMatch[1]) : this.lastExitCode;
        break;
      }
      exitCode = await this._execLine(line, { stdout, stderr });
    }

    // Restore positional parameters
    for (const key of Object.keys(savedArgs)) {
      if (savedArgs[key] === undefined) delete this.vfs.env[key];
      else this.vfs.env[key] = savedArgs[key];
    }
    if (savedPound === undefined) delete this.vfs.env['#'];
    else this.vfs.env['#'] = savedPound;
    if (savedAt === undefined) delete this.vfs.env['@'];
    else this.vfs.env['@'] = savedAt;
    if (savedStar === undefined) delete this.vfs.env['*'];
    else this.vfs.env['*'] = savedStar;

    return exitCode;
  }

  // ─── ARITHMETIC EXPANSION ─────────────────────────────────────────────────

  _expandArithmetic(input) {
    // Expand $((expr)) → evaluated result
    let result = '';
    let i = 0;
    while (i < input.length) {
      if (input[i] === '$' && input[i + 1] === '(' && input[i + 2] === '(') {
        // Find matching ))
        let depth = 1;
        let j = i + 3;
        while (j < input.length - 1 && depth > 0) {
          if (input[j] === '(' && input[j + 1] === '(') { depth++; j += 2; continue; }
          if (input[j] === ')' && input[j + 1] === ')') { depth--; if (depth === 0) break; j += 2; continue; }
          j++;
        }
        const expr = input.slice(i + 3, j);
        result += String(this._evalArithmetic(expr));
        i = j + 2; // skip ))
      } else {
        result += input[i];
        i++;
      }
    }
    return result;
  }

  _evalArithmetic(expr) {
    // Replace variable references with their values
    let expanded = expr.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (_, name) => {
      return this.vfs.env[name] || '0';
    });
    // Also replace bare variable names (not preceded by digit or letter)
    expanded = expanded.replace(/\b([A-Za-z_]\w*)\b/g, (match) => {
      if (/^\d+$/.test(match)) return match;
      return this.vfs.env[match] || '0';
    });

    // Evaluate using safe arithmetic (no eval)
    try {
      return this._safeArithEval(expanded.trim());
    } catch {
      return 0;
    }
  }

  _safeArithEval(expr) {
    // Tokenize and evaluate arithmetic expression
    // Supports: + - * / % ** ( ) and integer comparisons
    const tokens = [];
    let i = 0;
    while (i < expr.length) {
      if (/\s/.test(expr[i])) { i++; continue; }
      if (/\d/.test(expr[i])) {
        let num = '';
        while (i < expr.length && /\d/.test(expr[i])) { num += expr[i]; i++; }
        tokens.push({ type: 'num', value: parseInt(num) });
        continue;
      }
      if (expr[i] === '+') { tokens.push({ type: 'op', value: '+' }); i++; continue; }
      if (expr[i] === '-') {
        // Unary minus
        if (tokens.length === 0 || tokens[tokens.length - 1].type === 'op' || tokens[tokens.length - 1].value === '(') {
          let num = '-';
          i++;
          while (i < expr.length && /\d/.test(expr[i])) { num += expr[i]; i++; }
          tokens.push({ type: 'num', value: parseInt(num) });
          continue;
        }
        tokens.push({ type: 'op', value: '-' }); i++; continue;
      }
      if (expr[i] === '*' && expr[i + 1] === '*') { tokens.push({ type: 'op', value: '**' }); i += 2; continue; }
      if (expr[i] === '*') { tokens.push({ type: 'op', value: '*' }); i++; continue; }
      if (expr[i] === '/') { tokens.push({ type: 'op', value: '/' }); i++; continue; }
      if (expr[i] === '%') { tokens.push({ type: 'op', value: '%' }); i++; continue; }
      if (expr[i] === '(') { tokens.push({ type: 'paren', value: '(' }); i++; continue; }
      if (expr[i] === ')') { tokens.push({ type: 'paren', value: ')' }); i++; continue; }
      if (expr[i] === '<' && expr[i + 1] === '=') { tokens.push({ type: 'op', value: '<=' }); i += 2; continue; }
      if (expr[i] === '>' && expr[i + 1] === '=') { tokens.push({ type: 'op', value: '>=' }); i += 2; continue; }
      if (expr[i] === '=' && expr[i + 1] === '=') { tokens.push({ type: 'op', value: '==' }); i += 2; continue; }
      if (expr[i] === '!' && expr[i + 1] === '=') { tokens.push({ type: 'op', value: '!=' }); i += 2; continue; }
      if (expr[i] === '<') { tokens.push({ type: 'op', value: '<' }); i++; continue; }
      if (expr[i] === '>') { tokens.push({ type: 'op', value: '>' }); i++; continue; }
      i++; // skip unknown
    }

    // Simple recursive descent evaluation
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];

    const parseAtom = () => {
      const t = peek();
      if (!t) return 0;
      if (t.type === 'num') { next(); return t.value; }
      if (t.value === '(') { next(); const v = parseExpr(); next(); return v; } // skip )
      return 0;
    };

    const parsePow = () => {
      let left = parseAtom();
      while (peek() && peek().value === '**') { next(); left = Math.pow(left, parseAtom()); }
      return left;
    };

    const parseMul = () => {
      let left = parsePow();
      while (peek() && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
        const op = next().value;
        const right = parsePow();
        if (op === '*') left *= right;
        else if (op === '/') left = right === 0 ? 0 : Math.trunc(left / right);
        else left = right === 0 ? 0 : left % right;
      }
      return left;
    };

    const parseAdd = () => {
      let left = parseMul();
      while (peek() && (peek().value === '+' || peek().value === '-')) {
        const op = next().value;
        const right = parseMul();
        left = op === '+' ? left + right : left - right;
      }
      return left;
    };

    const parseExpr = () => {
      let left = parseAdd();
      while (peek() && ['<', '>', '<=', '>=', '==', '!='].includes(peek().value)) {
        const op = next().value;
        const right = parseAdd();
        if (op === '<') left = left < right ? 1 : 0;
        else if (op === '>') left = left > right ? 1 : 0;
        else if (op === '<=') left = left <= right ? 1 : 0;
        else if (op === '>=') left = left >= right ? 1 : 0;
        else if (op === '==') left = left === right ? 1 : 0;
        else if (op === '!=') left = left !== right ? 1 : 0;
      }
      return left;
    };

    return parseExpr();
  }

  // ─── HERE DOCUMENTS ───────────────────────────────────────────────────────

  _parseHeredoc(input, start) {
    let i = start;
    let stripTabs = false;

    // Check for <<- (strip leading tabs)
    if (input[i] === '-') { stripTabs = true; i++; }

    // Skip whitespace
    while (i < input.length && input[i] === ' ') i++;

    // Read delimiter (may be quoted)
    let delimiter = '';
    let noExpansion = false;

    if (input[i] === "'" || input[i] === '"') {
      const quote = input[i];
      i++;
      while (i < input.length && input[i] !== quote) {
        delimiter += input[i];
        i++;
      }
      i++; // skip closing quote
      noExpansion = true;
    } else {
      while (i < input.length && input[i] !== '\n' && input[i] !== ' ' && input[i] !== ';') {
        delimiter += input[i];
        i++;
      }
    }

    // Find the heredoc body (everything from next line until delimiter on its own line)
    let bodyStart = input.indexOf('\n', i);
    if (bodyStart === -1) {
      return { content: '', end: input.length };
    }
    bodyStart++;

    const bodyLines = [];
    let pos = bodyStart;
    while (pos < input.length) {
      let lineEnd = input.indexOf('\n', pos);
      if (lineEnd === -1) lineEnd = input.length;
      let line = input.slice(pos, lineEnd);

      // Check if this line is the delimiter
      const trimmedLine = stripTabs ? line.replace(/^\t+/, '') : line;
      if (trimmedLine.trim() === delimiter) {
        pos = lineEnd + 1;
        break;
      }

      if (stripTabs) line = line.replace(/^\t+/, '');
      bodyLines.push(line);
      pos = lineEnd + 1;
    }

    let content = bodyLines.join('\n');
    if (!noExpansion) {
      content = this._expandVars(content);
    }

    return { content, end: pos };
  }
}

export default Shell;
