// Claude API client — tool_use agent loop
// Designed to be replaced by Spirit's FoamProvider once Spirit ships.
// For now, implements the same loop directly.

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

class ClaudeClient {
  constructor(shell, terminal) {
    this.shell = shell;
    this.terminal = terminal;
    this.messages = [];
    this.apiKey = localStorage.getItem('foam_api_key') || '';
    this.systemPrompt = this._buildSystemPrompt();
    this.tools = this._buildTools();
  }

  setApiKey(key) {
    this.apiKey = key;
    localStorage.setItem('foam_api_key', key);
  }

  _buildSystemPrompt() {
    return `You are Claude, running inside Foam — a browser-based virtual Linux environment. You have access to a virtual filesystem persisted in IndexedDB and a shell with standard Unix commands.

Environment:
- OS: Foam (browser-based virtual OS)
- Shell: /bin/sh (JavaScript implementation)
- Working directory: ${this.shell.vfs.cwd}
- User: user
- Available commands: ls, cd, pwd, cat, echo, mkdir, rm, cp, mv, touch, head, tail, wc, grep, find, sort, uniq, tee, chmod, sed, diff, env, export, date, whoami, hostname, uname, test, git, npm, node
- You also have direct access to the browser DOM and JavaScript VM

You can execute shell commands, read/write files, and run JavaScript. All files persist across sessions.

When the user asks you to do something, use the tools available to complete the task. Be concise in your responses.`;
  }

  _buildTools() {
    return [
      {
        name: 'bash',
        description: 'Execute a shell command in the Foam virtual environment. Returns stdout, stderr, and exit code.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to execute' }
          },
          required: ['command']
        }
      },
      {
        name: 'read_file',
        description: 'Read the contents of a file. Returns file content with line numbers.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute or relative file path' },
            offset: { type: 'number', description: 'Line offset to start reading from (0-based)' },
            limit: { type: 'number', description: 'Maximum number of lines to read' }
          },
          required: ['path']
        }
      },
      {
        name: 'write_file',
        description: 'Create or overwrite a file with the given content. Parent directories must exist.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute or relative file path' },
            content: { type: 'string', description: 'The content to write' }
          },
          required: ['path', 'content']
        }
      },
      {
        name: 'edit_file',
        description: 'Replace an exact string in a file with a new string. The old_string must appear exactly once in the file.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            old_string: { type: 'string', description: 'Exact string to find (must be unique in file)' },
            new_string: { type: 'string', description: 'Replacement string' }
          },
          required: ['path', 'old_string', 'new_string']
        }
      },
      {
        name: 'glob',
        description: 'Find files matching a glob pattern.',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.js")' },
            path: { type: 'string', description: 'Base directory to search from' }
          },
          required: ['pattern']
        }
      },
      {
        name: 'js_eval',
        description: 'Execute JavaScript code in the browser page context. Returns the result as a string. Has access to the DOM, window, document, etc.',
        input_schema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'JavaScript code to evaluate' }
          },
          required: ['code']
        }
      }
    ];
  }

  async chat(userMessage) {
    if (!this.apiKey) {
      this.terminal.writeError('No API key set. Run: foam config set api_key YOUR_KEY\n');
      return;
    }

    this.messages.push({ role: 'user', content: userMessage });
    this.systemPrompt = this._buildSystemPrompt(); // Refresh cwd

    await this._loop();
  }

  async _loop() {
    const maxTurns = 50;
    for (let turn = 0; turn < maxTurns; turn++) {
      this.terminal.write('\x1b[90m...\x1b[0m\n');

      let response;
      try {
        response = await this._callApi();
      } catch (err) {
        this.terminal.writeError(`API error: ${err.message}\n`);
        return;
      }

      // Process response content blocks
      const toolResults = [];
      let hasText = false;

      for (const block of response.content) {
        if (block.type === 'text') {
          hasText = true;
          this.terminal.write(block.text + '\n');
        } else if (block.type === 'tool_use') {
          this.terminal.write(`\x1b[36m► ${block.name}\x1b[0m`);
          if (block.name === 'bash') {
            this.terminal.write(`: ${block.input.command}\n`);
          } else {
            this.terminal.write('\n');
          }

          const result = await this._executeTool(block);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      // Add assistant message
      this.messages.push({ role: 'assistant', content: response.content });

      // If there were tool uses, add results and continue loop
      if (toolResults.length > 0) {
        this.messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // If stop_reason is end_turn or we got text only, we're done
      if (response.stop_reason === 'end_turn' || hasText) {
        break;
      }
    }
  }

  async _callApi() {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8192,
        system: this.systemPrompt,
        tools: this.tools,
        messages: this.messages,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`${res.status}: ${errBody}`);
    }

    return res.json();
  }

  async _executeTool(block) {
    try {
      switch (block.name) {
        case 'bash': {
          const { stdout, stderr, exitCode } = await this.shell.exec(block.input.command);
          let output = '';
          if (stdout) { output += stdout; this.terminal.write(stdout); }
          if (stderr) { output += stderr; this.terminal.writeError(stderr); }
          output += `\n[exit code: ${exitCode}]`;
          return output.slice(0, 30000); // Truncate for API limits
        }

        case 'read_file': {
          const content = await this.shell.vfs.readFile(block.input.path);
          const lines = content.split('\n');
          const offset = block.input.offset || 0;
          const limit = block.input.limit || lines.length;
          const slice = lines.slice(offset, offset + limit);
          const numbered = slice.map((l, i) => `${String(offset + i + 1).padStart(6)}\t${l}`).join('\n');
          return numbered;
        }

        case 'write_file': {
          // Auto-create parent directories
          const parentPath = block.input.path.substring(0, block.input.path.lastIndexOf('/'));
          if (parentPath && !(await this.shell.vfs.exists(parentPath))) {
            await this.shell.vfs.mkdir(parentPath, { recursive: true });
          }
          await this.shell.vfs.writeFile(block.input.path, block.input.content);
          return `File written: ${block.input.path} (${block.input.content.length} bytes)`;
        }

        case 'edit_file': {
          const content = await this.shell.vfs.readFile(block.input.path);
          const count = content.split(block.input.old_string).length - 1;
          if (count === 0) return `Error: old_string not found in ${block.input.path}`;
          if (count > 1) return `Error: old_string appears ${count} times in ${block.input.path} (must be unique)`;
          const newContent = content.replace(block.input.old_string, block.input.new_string);
          await this.shell.vfs.writeFile(block.input.path, newContent);
          return `File edited: ${block.input.path}`;
        }

        case 'glob': {
          const results = await this.shell.vfs.glob(block.input.pattern, block.input.path);
          return results.join('\n') || '(no matches)';
        }

        case 'js_eval': {
          try {
            const result = eval(block.input.code);
            const str = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
            return str;
          } catch (err) {
            return `Error: ${err.message}`;
          }
        }

        default:
          return `Unknown tool: ${block.name}`;
      }
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  // Reset conversation
  reset() {
    this.messages = [];
  }
}

export default ClaudeClient;
