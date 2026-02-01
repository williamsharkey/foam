// Terminal UI — renders a terminal in the browser with prompt, history, ANSI color support
import commands from './commands.js';

class Terminal {
  constructor(container, shell) {
    this.container = container;
    this.shell = shell;
    this.shell.terminal = this;
    this.history = [];
    this.historyIndex = -1;
    this.currentInput = '';
    this.busy = false;
    this.promptStr = '';
    this.inputCallback = null; // For readFromUser
    this.abortController = null;
    this.rawModeCallback = null; // For vi/interactive editors

    this._build();
    this._updatePrompt();
    this.focus();
  }

  /**
   * Enter raw mode - all keystrokes go directly to the callback.
   * Used by interactive commands like vi that need character-by-character input.
   */
  enterRawMode(callback) {
    this.rawModeCallback = callback;
    this.input.style.display = 'none';
    this.promptEl.style.display = 'none';
    // Create a hidden input to capture keystrokes
    if (!this.rawInput) {
      this.rawInput = document.createElement('input');
      this.rawInput.style.cssText = 'position:absolute;left:-9999px;';
      this.container.appendChild(this.rawInput);
      this.rawInput.addEventListener('keydown', (e) => this._onRawKey(e));
    }
    this.rawInput.focus();
  }

  /**
   * Exit raw mode - return to normal line-editing mode.
   */
  exitRawMode() {
    this.rawModeCallback = null;
    this.input.style.display = '';
    this.promptEl.style.display = '';
    this.focus();
  }

  /**
   * Check if terminal is in raw mode.
   */
  isRawMode() {
    return this.rawModeCallback !== null;
  }

  /**
   * Get terminal dimensions (approximate based on container size).
   */
  getSize() {
    // Estimate based on font size and container
    const fontSize = 14;
    const lineHeight = 1.12;
    const charWidth = fontSize * 0.6; // Approximate monospace width
    const charHeight = fontSize * lineHeight;
    const rows = Math.floor(this.container.clientHeight / charHeight) || 24;
    const cols = Math.floor(this.container.clientWidth / charWidth) || 80;
    return { rows, cols };
  }

  _onRawKey(e) {
    if (!this.rawModeCallback) return;
    e.preventDefault();

    let key = e.key;
    // Normalize key names to match Shiro's raw mode
    if (e.ctrlKey && e.key.length === 1) {
      key = 'Ctrl+' + e.key.toUpperCase();
    } else if (e.key === 'ArrowUp') {
      key = 'ArrowUp';
    } else if (e.key === 'ArrowDown') {
      key = 'ArrowDown';
    } else if (e.key === 'ArrowLeft') {
      key = 'ArrowLeft';
    } else if (e.key === 'ArrowRight') {
      key = 'ArrowRight';
    } else if (e.key === 'Backspace') {
      key = 'Backspace';
    } else if (e.key === 'Delete') {
      key = 'Delete';
    } else if (e.key === 'Home') {
      key = 'Home';
    } else if (e.key === 'End') {
      key = 'End';
    } else if (e.key === 'Tab') {
      key = 'Tab';
    }
    // Enter and Escape are already correct

    this.rawModeCallback(key);
    // Re-focus to keep capturing
    this.rawInput.focus();
  }

  _build() {
    this.container.innerHTML = '';
    this.container.classList.add('foam-terminal');

    this.output = document.createElement('div');
    this.output.className = 'foam-output';
    this.container.appendChild(this.output);

    this.inputLine = document.createElement('div');
    this.inputLine.className = 'foam-input-line';

    this.promptEl = document.createElement('span');
    this.promptEl.className = 'foam-prompt';
    this.inputLine.appendChild(this.promptEl);

    this.input = document.createElement('input');
    this.input.className = 'foam-input';
    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.inputLine.appendChild(this.input);

    this.container.appendChild(this.inputLine);

    this.input.addEventListener('keydown', (e) => this._onKey(e));
    this.container.addEventListener('click', () => this.focus());
  }

  _updatePrompt() {
    const cwd = this.shell.vfs.cwd;
    const home = this.shell.vfs.env.HOME;
    const display = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    const user = this.shell.vfs.env.USER || 'user';
    this.promptStr = `${user}@foam:${display}$ `;
    this.promptEl.textContent = this.promptStr;
  }

  focus() {
    this.input.focus();
  }

  clear() {
    this.output.innerHTML = '';
  }

  write(text) {
    // Parse basic ANSI codes and render
    const span = document.createElement('span');
    span.innerHTML = this._ansiToHtml(text);
    this.output.appendChild(span);
    this._scroll();
  }

  // Alias for compatibility with Shiro's terminal API
  writeOutput(text) {
    this.write(text);
  }

  writeLine(text) {
    this.write(text + '\n');
  }

  writeError(text) {
    const span = document.createElement('span');
    span.className = 'foam-stderr';
    span.innerHTML = this._ansiToHtml(text);
    this.output.appendChild(span);
    this._scroll();
  }

  _scroll() {
    this.container.scrollTop = this.container.scrollHeight;
  }

  async _onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = this.input.value;
      this.input.value = '';

      // If waiting for user input (readFromUser), resolve it
      if (this.inputCallback) {
        this.write(this.promptStr + cmd + '\n');
        const cb = this.inputCallback;
        this.inputCallback = null;
        cb(cmd);
        return;
      }

      if (cmd.trim()) {
        this.history.push(cmd);
      }
      this.historyIndex = this.history.length;

      this.write(this.promptStr + cmd + '\n');

      if (!cmd.trim()) {
        this._updatePrompt();
        return;
      }

      await this._run(cmd);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.historyIndex > 0) {
        if (this.historyIndex === this.history.length) {
          this.currentInput = this.input.value;
        }
        this.historyIndex--;
        this.input.value = this.history[this.historyIndex];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.historyIndex < this.history.length) {
        this.historyIndex++;
        if (this.historyIndex === this.history.length) {
          this.input.value = this.currentInput;
        } else {
          this.input.value = this.history[this.historyIndex];
        }
      }
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      if (this.abortController) {
        this.abortController.abort();
        this.write('^C\n');
      } else {
        this.input.value = '';
        this.write(this.promptStr + '^C\n');
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      this.clear();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      await this._tabComplete();
    }
  }

  async _run(cmd) {
    this.busy = true;
    this.input.disabled = true;
    this.abortController = new AbortController();

    try {
      await this.shell.execLive(cmd, {
        stdout: (t) => this.write(t),
        stderr: (t) => this.writeError(t),
      });
    } catch (err) {
      this.writeError(err.message + '\n');
    }

    this.busy = false;
    this.input.disabled = false;
    this.abortController = null;
    this._updatePrompt();
    this.focus();
  }

  async _runSpirit(cmd) {
    const msg = cmd.slice(6).trim() || null;
    if (!this.spiritAgent) {
      this.writeError('Spirit not configured. Run: foam config set api_key YOUR_KEY\n');
      return;
    }
    if (!msg) {
      this.writeLine('Usage: spirit "your message"');
      this.writeLine('Spirit slash commands: /help, /clear, /compact, /stats');
      return;
    }
    // Strip surrounding quotes
    const cleaned = msg.replace(/^["']|["']$/g, '');

    // Handle slash commands
    if (cleaned.startsWith('/')) {
      const { handled, output } = await this.spiritAgent.handleSlashCommand(cleaned);
      if (handled) {
        if (output) this.write(output + '\n');
        return;
      }
    }

    await this.spiritAgent.run(cleaned);
    this.write('\n');
  }

  async _runClaude(cmd) {
    const msg = cmd.slice(6).trim() || null;
    if (!this.claudeClient) {
      this.writeError('Claude not configured. Run: foam config set api_key YOUR_KEY\n');
      return;
    }
    if (!msg) {
      this.writeLine('Usage: claude "your message"');
      return;
    }
    // Strip surrounding quotes
    const cleaned = msg.replace(/^["']|["']$/g, '');
    await this.claudeClient.chat(cleaned);
  }

  async _runFoamConfig(cmd) {
    const parts = cmd.split(/\s+/);
    if (parts[1] === 'config' && parts[2] === 'set' && parts[3] === 'api_key' && parts[4]) {
      localStorage.setItem('foam_api_key', parts[4]);
      this.writeLine('API key saved.');
      if (this.onConfigChange) this.onConfigChange();
    } else if (parts[1] === 'config' && parts[2] === 'get' && parts[3] === 'api_key') {
      const key = localStorage.getItem('foam_api_key');
      this.writeLine(key ? 'sk-ant-...' + key.slice(-8) : '(not set)');
    } else if (parts[1] === 'reset') {
      if (confirm('Delete all files in virtual filesystem?')) {
        const req = indexedDB.deleteDatabase('foam-vfs');
        req.onsuccess = () => { this.writeLine('Filesystem reset. Reload page.'); };
      }
    } else {
      this.writeLine('foam config set api_key <key>');
      this.writeLine('foam config get api_key');
      this.writeLine('foam reset');
    }
  }

  async _tabComplete() {
    const val = this.input.value;
    const lastSpace = val.lastIndexOf(' ');
    const prefix = lastSpace === -1 ? val : val.slice(lastSpace + 1);
    if (!prefix) return;

    // If completing the first word, try command names
    if (lastSpace === -1) {
      const cmdNames = Object.keys(commands).filter(n => n.startsWith(prefix));
      if (cmdNames.length === 1) {
        this.input.value = cmdNames[0] + ' ';
        return;
      } else if (cmdNames.length > 1) {
        this.write('\n' + cmdNames.join('  ') + '\n');
        let common = cmdNames[0];
        for (const n of cmdNames) {
          while (!n.startsWith(common)) common = common.slice(0, -1);
        }
        this.input.value = common;
        return;
      }
    }

    // File/directory completion
    try {
      const dir = prefix.includes('/') ? prefix.substring(0, prefix.lastIndexOf('/')) || '/' : '.';
      const base = prefix.includes('/') ? prefix.substring(prefix.lastIndexOf('/') + 1) : prefix;
      const resolved = this.shell.vfs.resolvePath(dir);
      const entries = await this.shell.vfs.readdir(resolved);
      const matches = entries.filter(e => e.name.startsWith(base));

      if (matches.length === 1) {
        const completion = matches[0].name.slice(base.length);
        const suffix = matches[0].type === 'dir' ? '/' : ' ';
        this.input.value = val + completion + suffix;
      } else if (matches.length > 1) {
        this.write('\n' + matches.map(m => m.name).join('  ') + '\n');
        let common = matches[0].name;
        for (const m of matches) {
          while (!m.name.startsWith(common)) common = common.slice(0, -1);
        }
        this.input.value = val + common.slice(base.length);
      }
    } catch (_) {}
  }

  // For Spirit's readFromUser
  async readFromUser(prompt) {
    this.write(prompt);
    this._updatePrompt();
    this.input.disabled = false;
    this.focus();
    return new Promise((resolve) => {
      this.inputCallback = resolve;
    });
  }

  _ansiToHtml(text) {
    // Convert \n to <br>, escape HTML, handle basic ANSI codes
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // ANSI color codes (matching Shiro theme)
    const colorMap = {
      '30': '#1a1a2e', '31': '#ff6b6b', '32': '#51cf66', '33': '#ffd43b',
      '34': '#74c0fc', '35': '#cc5de8', '36': '#66d9e8', '37': '#e0e0e0',
      '90': '#4a4a6a', '91': '#ff8787', '92': '#69db7c', '93': '#ffe066',
      '94': '#91d5ff', '95': '#e599f7', '96': '#99e9f2', '97': '#ffffff',
    };

    html = html.replace(/\x1b\[([0-9;]*)m/g, (_, codes) => {
      if (!codes || codes === '0') return '</span>';
      const parts = codes.split(';');
      const styles = [];
      for (const p of parts) {
        if (p === '1') styles.push('font-weight:bold');
        if (p === '3') styles.push('font-style:italic');
        if (p === '4') styles.push('text-decoration:underline');
        if (colorMap[p]) styles.push(`color:${colorMap[p]}`);
      }
      return styles.length ? `<span style="${styles.join(';')}">` : '';
    });

    html = html.replace(/\n/g, '<br>');
    return html;
  }
}

export default Terminal;
