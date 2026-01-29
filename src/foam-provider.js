// FoamProvider — implements Spirit's OSProvider interface
// This is the adapter between Spirit (Claude Code agent) and Foam's VFS + Shell
// See: https://github.com/williamsharkey/spirit (OSProvider interface)

class FoamProvider {
  constructor(vfs, shell, terminal) {
    this.vfs = vfs;
    this.shell = shell;
    this.terminal = terminal;
  }

  // ─── Filesystem ───────────────────────────────────────────────────────────

  async readFile(path) {
    return this.vfs.readFile(path);
  }

  async writeFile(path, content) {
    // Auto-create parent dirs
    const parentPath = path.substring(0, path.lastIndexOf('/'));
    if (parentPath && !(await this.vfs.exists(parentPath))) {
      await this.vfs.mkdir(parentPath, { recursive: true });
    }
    await this.vfs.writeFile(path, content);
  }

  async mkdir(path, opts) {
    await this.vfs.mkdir(path, opts);
  }

  async readdir(path) {
    const resolved = this.vfs.resolvePath(path);
    const entries = await this.vfs.readdir(resolved);
    // Spirit expects FileInfo[]: { name, path, type, size, mtime }
    return entries.map(e => ({
      name: e.name,
      path: e.path,
      type: e.type,
      size: e.size,
      mtime: e.mtime,
    }));
  }

  async stat(path) {
    const s = await this.vfs.stat(path);
    // Spirit expects StatResult: { type, size, mtime, isFile(), isDirectory() }
    return {
      type: s.type,
      size: s.size,
      mode: s.mode,
      mtime: s.mtime,
      ctime: s.ctime,
      atime: s.atime,
      isFile() { return s.type === 'file'; },
      isDirectory() { return s.type === 'dir'; },
    };
  }

  async exists(path) {
    return this.vfs.exists(path);
  }

  async unlink(path) {
    const s = await this.vfs.stat(path);
    if (s.type === 'dir') {
      await this.vfs.rmdir(path, { recursive: true });
    } else {
      await this.vfs.unlink(path);
    }
  }

  async rename(oldPath, newPath) {
    await this.vfs.rename(oldPath, newPath);
  }

  // ─── Path / env ──────────────────────────────────────────────────────────

  resolvePath(path) {
    return this.vfs.resolvePath(path);
  }

  getCwd() {
    return this.vfs.cwd;
  }

  setCwd(path) {
    this.vfs.chdir(path);
  }

  getEnv() {
    return { ...this.vfs.env };
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  async glob(pattern, base) {
    return this.vfs.glob(pattern, base);
  }

  // ─── Shell ────────────────────────────────────────────────────────────────

  async exec(command) {
    return this.shell.exec(command);
  }

  // ─── Terminal I/O ─────────────────────────────────────────────────────────

  writeToTerminal(text) {
    if (this.terminal) {
      this.terminal.write(text);
    }
  }

  async readFromUser(prompt) {
    if (this.terminal) {
      return this.terminal.readFromUser(prompt);
    }
    return '';
  }

  // ─── Host info ────────────────────────────────────────────────────────────

  getHostInfo() {
    return {
      name: 'Foam',
      version: '0.1.0',
    };
  }
}

export default FoamProvider;
