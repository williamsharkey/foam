# Foam

A browser-native cloud OS that runs Claude Code in a virtual Linux terminal — no servers, no sockets, no native dependencies.

## What is Foam?

Foam is a self-contained web page that simulates a Linux environment in the browser. It gives Claude first-class access to a virtual filesystem, shell commands, and the live DOM/JavaScript VM of the page it's running on. Claude can execute `ls`, `grep`, `git`, `npm`, and other standard dev tools — all implemented as pure JavaScript functions backed by IndexedDB — and can read and modify the webpage directly without tunnels or WebSocket bridges.

## Why?

- **No backend required.** Claude talks directly to the Anthropic API from the browser. Commands run in-page. There is no relay server.
- **No native OS dependency.** Every tool Claude needs (`git`, `npm`, `grep`, `find`, etc.) is a JS function with the same stdin/stdout/stderr interface as the real thing. No WASM Linux kernel, no containers.
- **Live page access.** Claude can inspect the DOM, run arbitrary JS, edit styles, and mutate the page — the "computer" it's operating on *is* the page.
- **Persistence.** The virtual filesystem lives in IndexedDB. Reload the page and your files, git history, and project state are still there.
- **Zero-install.** Open the HTML file (or serve it statically). That's it.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Browser Tab                   │
│                                                 │
│  ┌───────────┐   ┌──────────────────────────┐   │
│  │ Terminal   │   │ Claude API Client        │   │
│  │ UI         │◄─►│ (tool_use loop)          │   │
│  │ (xterm.js) │   │                          │   │
│  └─────┬──────┘   └──────────┬───────────────┘   │
│        │                     │                   │
│        ▼                     ▼                   │
│  ┌──────────────────────────────────────────┐   │
│  │          Shell Interpreter               │   │
│  │  parse → pipeline → execute → output     │   │
│  └─────────────────┬────────────────────────┘   │
│                    │                             │
│        ┌───────────┼───────────┐                 │
│        ▼           ▼           ▼                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐         │
│  │ Coreutils│ │ Dev Tools│ │ DOM/JS   │         │
│  │ ls,cat,  │ │ git,npm  │ │ Access   │         │
│  │ grep,... │ │ node,... │ │ Tools    │         │
│  └────┬─────┘ └────┬─────┘ └──────────┘         │
│       │             │                            │
│       ▼             ▼                            │
│  ┌──────────────────────────────────────────┐   │
│  │     Virtual File System (VFS)            │   │
│  │     in-memory cache + IndexedDB          │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

## Components

### 1. Virtual File System (`src/vfs.js`)

Unix-like filesystem stored in IndexedDB with an in-memory cache.

- Inodes with path, type, mode, timestamps, content
- Full path resolution: absolute, relative, `~`, `.`, `..`
- Operations: `stat`, `readFile`, `writeFile`, `mkdir`, `readdir`, `unlink`, `rmdir`, `rename`, `copy`, `glob`
- Default directory tree: `/home/user`, `/tmp`, `/bin`, `/etc`, `/var`, `/dev`
- Environment variables (`HOME`, `PWD`, `PATH`, etc.)

### 2. Shell Commands (`src/commands.js`)

Each command is a JS async function with the signature:

```js
async function cmd(args, { stdin, stdout, stderr, vfs, env }) → exitCode
```

This matches real Unix conventions: args array, three streams, exit code. Claude sees no difference from a real shell.

**Coreutils:**
| Command | Notes |
|---------|-------|
| `ls`    | `-l`, `-a`, `-R`, `-h` flags |
| `cd`    | updates `$PWD` |
| `pwd`   | prints working directory |
| `cat`   | concatenate files, `-n` for line numbers |
| `echo`  | with `-n`, `-e` support |
| `mkdir` | `-p` for recursive |
| `rm`    | `-r`, `-f` flags |
| `cp`    | `-r` flag |
| `mv`    | rename/move |
| `touch` | create or update timestamp |
| `head`  | `-n` flag |
| `tail`  | `-n` flag |
| `wc`    | `-l`, `-w`, `-c` |
| `grep`  | `-i`, `-r`, `-n`, `-l`, `-c`, `-v` |
| `find`  | `-name`, `-type` |
| `sort`  | basic sort |
| `uniq`  | deduplicate |
| `tee`   | write to file and stdout |
| `chmod` | set file mode |
| `env`   | print environment |
| `export`| set env var |
| `which` | locate command |
| `clear` | clear terminal |
| `sed`   | `s/pattern/replace/` basics |
| `diff`  | compare two files |
| `xargs` | pipe stdin to args |
| `true` / `false` | exit 0 / exit 1 |

### 3. Shell Interpreter (`src/shell.js`)

Parses and executes command lines.

- Tokenizer: handles quoting (`"`, `'`, `` ` ``), escapes, variables (`$VAR`, `${VAR}`)
- Pipelines: `cmd1 | cmd2 | cmd3` — stdout of one feeds stdin of next
- Redirects: `>`, `>>`, `<`, `2>`
- Logical operators: `&&`, `||`, `;`
- Subshells: `$(command)` substitution
- `$?` for last exit code

### 4. Terminal UI (`src/terminal.js`)

A terminal rendered in the browser.

- Prompt with PS1 support
- Command history (up/down arrows)
- Basic line editing
- Scrollback buffer
- ANSI color rendering (bold, fg colors at minimum)
- Auto-scroll on output
- Click-to-focus

### 5. Claude API Client (`src/claude.js`)

Integrates with the Anthropic Messages API using tool_use.

- Stores API key in localStorage (set via `foam config set api_key <key>` or settings UI)
- System prompt describes the virtual environment and available tools
- Tool definitions map 1:1 to shell commands:
  - `bash` tool: takes a `command` string, runs it through the shell interpreter, returns stdout/stderr/exit_code
  - `read_file` / `write_file` / `edit_file`: direct VFS operations
  - `glob` / `grep`: search tools
  - `js_eval`: execute JS in the page context
  - `dom_query` / `dom_mutate`: read/modify the DOM
- Conversation loop: user message → Claude response → execute tools → feed results back → repeat until Claude produces a text response
- Streaming support for long responses

### 6. Dev Tools (`src/devtools.js`)

Simplified implementations of standard dev tooling, operating entirely on the VFS.

**git** (simplified):
- `git init` — create `.git/` structure in VFS
- `git add <files>` — stage files (snapshot content)
- `git status` — show staged/unstaged changes
- `git commit -m "msg"` — store commit object with tree snapshot, parent, message
- `git log` — print commit history
- `git diff` — diff working tree vs last commit
- `git branch` / `git checkout` — branch management

**npm** (simplified):
- `npm init` — generate `package.json`
- `npm install <pkg>` — fetch from CDN (esm.sh/unpkg), store in `node_modules/`
- `npm run <script>` — execute script from `package.json`

**node**:
- `node <file>` — eval JS file contents in a sandboxed scope
- `node -e "code"` — eval inline JS

### 7. DOM/Page Access Tools (`src/domtools.js`)

These give Claude direct access to the page it's running on.

- `document.querySelector` / `querySelectorAll` — read DOM nodes
- `getComputedStyle` — inspect styles
- `innerHTML` / `textContent` mutation
- `setAttribute` / `removeAttribute`
- `createElement` / `appendChild` / `removeChild`
- `eval()` in page scope — run arbitrary JS
- `fetch()` — make HTTP requests from the page
- `canvas` API access for drawing
- `localStorage` / `sessionStorage` read/write (namespaced to avoid collision with VFS)

## Spirit Integration

Foam's Claude agent is powered by [Spirit](https://github.com/williamsharkey/spirit) — a shared Claude Code agent loop library that targets virtual OS environments.

Spirit defines an `OSProvider` interface. Foam implements `FoamProvider` (`src/foam-provider.js`) which adapts the VFS and shell to Spirit's expectations. This means Spirit handles the Claude API calls, tool definitions, and agent loop — Foam just provides the OS layer.

```
Spirit (agent loop)  ←→  FoamProvider  ←→  VFS + Shell + Terminal
```

Until Spirit ships its ES module bundle, Foam includes a standalone `claude.js` that implements the same tool_use loop directly. Once `spirit.es.js` is available, `claude.js` gets replaced with a Spirit import.

**Coordination issues filed on Spirit:**
- [#1](https://github.com/williamsharkey/spirit/issues/1) — FileInfo/StatResult type definitions
- [#2](https://github.com/williamsharkey/spirit/issues/2) — exec() shell contract
- [#3](https://github.com/williamsharkey/spirit/issues/3) — ES module bundle for Foam
- [#4](https://github.com/williamsharkey/spirit/issues/4) — DOM/JS tools scope
- [#5](https://github.com/williamsharkey/spirit/issues/5) — Custom tool registration API

## File Structure

```
foam/
├── index.html              # Single entry point, loads everything
├── README.md
├── style.css               # Terminal styling
├── src/
│   ├── vfs.js              # Virtual filesystem + IndexedDB
│   ├── commands.js         # Coreutils (ls, grep, cat, sed, etc.)
│   ├── shell.js            # Command parser + pipeline executor
│   ├── terminal.js         # Terminal UI rendering
│   ├── claude.js           # Claude API client (interim, replaced by Spirit)
│   ├── devtools.js         # git, npm, node implementations
│   └── foam-provider.js    # Spirit OSProvider adapter
```

## Usage

1. Open `index.html` in a browser (or serve statically)
2. Set your Claude API key: `foam config set api_key sk-ant-...`
3. Use the terminal like a normal shell:
   ```
   $ mkdir myproject && cd myproject
   $ echo "hello world" > index.html
   $ cat index.html
   hello world
   $ git init && git add . && git commit -m "init"
   ```
4. Talk to Claude: `claude "add a button to index.html that says hello"`
5. Claude will read files, write files, and run commands — all inside the browser

## Design Principles

1. **IO compatibility over feature completeness.** Each command doesn't need every flag — it needs the same stdin/stdout/stderr/exit-code contract so Claude's tool-use works identically to a real terminal.
2. **No build step.** ES modules loaded directly by the browser. No bundler, no transpiler.
3. **Single page.** Everything is one HTML file with module imports. Deployable anywhere static files can be served, including `file://`.
4. **Persistence by default.** IndexedDB survives page reloads. The filesystem is your project state.
5. **Claude is a first-class user.** The API client and tool definitions are designed so Claude's tool_use responses map directly to shell execution with no adapter layer.

## Status

Under active development. Current progress:

- [x] Virtual filesystem with IndexedDB persistence
- [x] Shell commands (30+ coreutils)
- [x] Shell interpreter (pipes, redirects, `&&`/`||`, variable expansion, command substitution)
- [x] Terminal UI (history, tab completion, ANSI colors, Ctrl+C)
- [x] Claude API integration with tool_use loop
- [x] Dev tools (git, npm, node)
- [x] FoamProvider for Spirit integration
- [ ] Spirit submodule integration (waiting on Spirit ES bundle)
- [ ] DOM access tools (pending Spirit tool registration API)

## License

MIT
