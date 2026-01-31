// Virtual File System - IndexedDB-backed Unix-like filesystem
// Stores inodes with metadata and content in IndexedDB, with an in-memory cache

const DB_NAME = 'foam-vfs';
const DB_VERSION = 1;
const STORE_NAME = 'inodes';

// Helper to create Node.js-style errors with .code property for isomorphic-git compatibility
function fsError(code, message) {
  const err = new Error(message);
  err.code = code;
  // Add errno for better isomorphic-git compatibility
  err.errno = code === 'ENOENT' ? -2 :
              code === 'EEXIST' ? -17 :
              code === 'EISDIR' ? -21 :
              code === 'ENOTDIR' ? -20 :
              code === 'ENOTEMPTY' ? -39 :
              -1; // Generic error
  return err;
}

class VFS {
  constructor() {
    this.db = null;
    this.cache = new Map();
    this.cwd = '/home/user';
    this.env = {
      HOME: '/home/user',
      USER: 'user',
      PATH: '/usr/bin:/bin',
      PWD: '/home/user',
      SHELL: '/bin/sh',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
    };
  }

  async init() {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'path' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });

    // Check if filesystem is already initialized
    const root = await this._get('/');
    if (!root) {
      await this._initDefaultFS();
    }

    // Load all inodes into cache
    await this._loadCache();
    this.cwd = this.env.HOME;
    this.env.PWD = this.cwd;
  }

  async _initDefaultFS() {
    const now = Date.now();
    const dirs = [
      '/', '/home', '/home/user', '/tmp', '/bin', '/usr', '/usr/bin',
      '/etc', '/var', '/var/log', '/dev',
    ];
    const tx = this.db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const d of dirs) {
      store.put({
        path: d,
        type: 'dir',
        mode: 0o755,
        uid: 0,
        gid: 0,
        size: 0,
        ctime: now,
        mtime: now,
        atime: now,
        content: null,
      });
    }
    // Create default files
    store.put({
      path: '/etc/hostname',
      type: 'file',
      mode: 0o644,
      uid: 0, gid: 0,
      size: 5,
      ctime: now, mtime: now, atime: now,
      content: 'foam\n',
    });
    store.put({
      path: '/home/user/.bashrc',
      type: 'file',
      mode: 0o644,
      uid: 1000, gid: 1000,
      size: 0,
      ctime: now, mtime: now, atime: now,
      content: '# ~/.bashrc\nexport PS1="user@foam:$ "\n',
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async _loadCache() {
    const tx = this.db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const all = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    this.cache.clear();
    for (const inode of all) {
      this.cache.set(inode.path, inode);
    }
  }

  async _get(path) {
    if (this.cache.has(path)) return this.cache.get(path);
    const tx = this.db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
      const req = store.get(path);
      req.onsuccess = () => {
        if (req.result) this.cache.set(path, req.result);
        resolve(req.result || null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async _put(inode) {
    this.cache.set(inode.path, inode);
    const tx = this.db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(inode);
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async _delete(path) {
    this.cache.delete(path);
    const tx = this.db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(path);
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  resolvePath(p, base) {
    if (!p) return base || this.cwd;
    // Handle ~ expansion
    if (p.startsWith('~')) {
      p = this.env.HOME + p.slice(1);
    }
    if (!p.startsWith('/')) {
      // Use provided base directory, or fall back to cwd
      const baseDir = base || this.cwd;
      p = baseDir + '/' + p;
    }
    // Normalize
    const parts = p.split('/');
    const resolved = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') { resolved.pop(); continue; }
      resolved.push(part);
    }
    return '/' + resolved.join('/');
  }

  async stat(path) {
    path = this.resolvePath(path);
    const inode = await this._get(path);
    if (!inode) throw fsError('ENOENT', `ENOENT: no such file or directory, stat '${path}'`);
    return { ...inode };
  }

  async exists(path) {
    path = this.resolvePath(path);
    return !!(await this._get(path));
  }

  async readFile(path) {
    path = this.resolvePath(path);
    let inode = await this._get(path);
    if (!inode) throw fsError('ENOENT', `ENOENT: no such file or directory, open '${path}'`);

    // Follow symlinks
    let maxFollows = 10; // Prevent infinite loops
    while (inode.type === 'symlink' && maxFollows-- > 0) {
      const target = inode.symlinkTarget || inode.content;
      const targetPath = target.startsWith('/') ? target : this.resolvePath(target, path.substring(0, path.lastIndexOf('/')));
      inode = await this._get(targetPath);
      if (!inode) throw fsError('ENOENT', `ENOENT: no such file or directory, open '${targetPath}'`);
    }
    if (inode.type === 'symlink') throw new Error('Too many levels of symbolic links');

    if (inode.type === 'dir') throw fsError('EISDIR', `EISDIR: illegal operation on a directory, read`);
    inode.atime = Date.now();
    await this._put(inode);
    return inode.content || '';
  }

  async writeFile(path, content, options = {}) {
    path = this.resolvePath(path);
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const parent = await this._get(parentPath);
    if (!parent) throw new Error(`cannot create '${path}': No such file or directory`);
    if (parent.type !== 'dir') throw new Error(`cannot create '${path}': Not a directory`);

    const existing = await this._get(path);
    const now = Date.now();
    if (options.append && existing) {
      content = (existing.content || '') + content;
    }
    await this._put({
      path,
      type: 'file',
      mode: existing ? existing.mode : 0o644,
      uid: 1000, gid: 1000,
      size: content.length,
      ctime: existing ? existing.ctime : now,
      mtime: now,
      atime: now,
      content,
    });
  }

  async mkdir(path, options = {}) {
    path = this.resolvePath(path);
    if (await this._get(path)) {
      if (options.recursive) return;
      throw new Error(`mkdir: cannot create directory '${path}': File exists`);
    }
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    if (options.recursive && !(await this._get(parentPath))) {
      await this.mkdir(parentPath, { recursive: true });
    }
    const parent = await this._get(parentPath);
    if (!parent) throw new Error(`mkdir: cannot create directory '${path}': No such file or directory`);
    const now = Date.now();
    await this._put({
      path,
      type: 'dir',
      mode: 0o755,
      uid: 1000, gid: 1000,
      size: 0,
      ctime: now, mtime: now, atime: now,
      content: null,
    });
  }

  async readdir(path) {
    path = this.resolvePath(path);
    const inode = await this._get(path);
    if (!inode) throw new Error(`ls: cannot access '${path}': No such file or directory`);
    if (inode.type !== 'dir') throw new Error(`ls: '${path}' is not a directory`);
    const prefix = path === '/' ? '/' : path + '/';
    const entries = [];
    for (const [p, node] of this.cache) {
      if (p === path) continue;
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        if (!rest.includes('/')) {
          entries.push({ name: rest, ...node });
        }
      }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async unlink(path) {
    path = this.resolvePath(path);
    const inode = await this._get(path);
    if (!inode) throw new Error(`rm: cannot remove '${path}': No such file or directory`);
    if (inode.type === 'dir') throw new Error(`rm: cannot remove '${path}': Is a directory`);
    await this._delete(path);
  }

  async rmdir(path, options = {}) {
    path = this.resolvePath(path);
    const inode = await this._get(path);
    if (!inode) throw new Error(`rmdir: '${path}': No such file or directory`);
    if (inode.type !== 'dir') throw new Error(`rmdir: '${path}': Not a directory`);
    const children = await this.readdir(path);
    if (children.length > 0 && !options.recursive) {
      throw new Error(`rmdir: '${path}': Directory not empty`);
    }
    if (options.recursive) {
      for (const child of children) {
        const childPath = (path === '/' ? '' : path) + '/' + child.name;
        if (child.type === 'dir') {
          await this.rmdir(childPath, { recursive: true });
        } else {
          await this._delete(childPath);
        }
      }
    }
    await this._delete(path);
  }

  async rename(oldPath, newPath) {
    oldPath = this.resolvePath(oldPath);
    newPath = this.resolvePath(newPath);
    const inode = await this._get(oldPath);
    if (!inode) throw new Error(`mv: cannot stat '${oldPath}': No such file or directory`);

    // If it's a directory, move all children too
    if (inode.type === 'dir') {
      const prefix = oldPath === '/' ? '/' : oldPath + '/';
      const toMove = [];
      for (const [p] of this.cache) {
        if (p.startsWith(prefix)) {
          toMove.push(p);
        }
      }
      for (const p of toMove) {
        const child = await this._get(p);
        const newChildPath = newPath + p.slice(oldPath.length);
        child.path = newChildPath;
        await this._put(child);
        await this._delete(p);
      }
    }

    inode.path = newPath;
    inode.mtime = Date.now();
    await this._put(inode);
    await this._delete(oldPath);
  }

  async copy(srcPath, destPath, options = {}) {
    srcPath = this.resolvePath(srcPath);
    destPath = this.resolvePath(destPath);
    const inode = await this._get(srcPath);
    if (!inode) throw new Error(`cp: cannot stat '${srcPath}': No such file or directory`);

    const destInode = await this._get(destPath);
    if (destInode && destInode.type === 'dir') {
      const name = srcPath.split('/').pop();
      destPath = destPath + '/' + name;
    }

    if (inode.type === 'dir') {
      if (!options.recursive) throw new Error(`cp: -r not specified; omitting directory '${srcPath}'`);
      await this.mkdir(destPath, { recursive: true });
      const children = await this.readdir(srcPath);
      for (const child of children) {
        const childSrc = (srcPath === '/' ? '' : srcPath) + '/' + child.name;
        const childDest = destPath + '/' + child.name;
        await this.copy(childSrc, childDest, options);
      }
    } else {
      const now = Date.now();
      await this._put({
        ...inode,
        path: destPath,
        ctime: now,
        mtime: now,
        atime: now,
      });
    }
  }

  chdir(path) {
    path = this.resolvePath(path);
    const inode = this.cache.get(path);
    if (!inode) throw new Error(`cd: ${path}: No such file or directory`);
    if (inode.type !== 'dir') throw new Error(`cd: ${path}: Not a directory`);
    this.cwd = path;
    this.env.PWD = path;
    return path;
  }

  // Glob-like pattern matching for find/glob
  async glob(pattern, basePath) {
    basePath = basePath ? this.resolvePath(basePath) : this.cwd;
    const results = [];
    // Build regex from the full pattern anchored at basePath
    const fullPattern = pattern.startsWith('/') ? pattern : (basePath === '/' ? '/' : basePath + '/') + pattern;
    const regex = this._globToRegex(fullPattern);
    for (const [p, node] of this.cache) {
      if (p.startsWith(basePath) && node.type === 'file' && regex.test(p)) {
        // Return paths relative to basePath (matches Spirit/Shiro behavior)
        let rel = p.slice(basePath.length);
        if (rel.startsWith('/')) rel = rel.slice(1);
        results.push(rel || p);
      }
    }
    return results.sort();
  }

  // ─── Symlinks (isomorphic-git compatibility) ─────────────────────────────

  async symlink(target, path) {
    path = this.resolvePath(path);
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const parent = await this._get(parentPath);
    if (!parent) throw new Error(`symlink: cannot create '${path}': No such file or directory`);
    const now = Date.now();
    await this._put({
      path,
      type: 'symlink',
      mode: 0o120000,
      uid: 1000, gid: 1000,
      size: target.length,
      ctime: now, mtime: now, atime: now,
      content: target,
      symlinkTarget: target,
    });
  }

  async readlink(path) {
    path = this.resolvePath(path);
    const inode = await this._get(path);
    if (!inode) throw new Error(`readlink: '${path}': No such file or directory`);
    if (inode.type !== 'symlink') throw new Error(`readlink: '${path}': Not a symbolic link`);
    return inode.symlinkTarget || inode.content;
  }

  async lstat(path) {
    // Like stat but does not follow symlinks
    path = this.resolvePath(path);
    const inode = await this._get(path);
    if (!inode) throw fsError('ENOENT', `ENOENT: no such file or directory, lstat '${path}'`);
    return { ...inode };
  }

  async chmod(path, mode) {
    path = this.resolvePath(path);
    const inode = await this._get(path);
    if (!inode) throw new Error(`chmod: '${path}': No such file or directory`);
    inode.mode = mode;
    await this._put(inode);
  }

  async appendFile(path, data) {
    path = this.resolvePath(path);
    const existing = await this._get(path);
    const prev = existing ? (existing.content || '') : '';
    await this.writeFile(path, prev + data);
  }

  // Build fs.promises-compatible API for isomorphic-git
  // Binary data is stored as base64 with a \x00BIN: prefix to distinguish from text
  toIsomorphicGitFS() {
    const vfs = this;
    const BIN_PREFIX = '\x00BIN:';

    function encodeBinary(uint8arr) {
      // Convert Uint8Array to base64 string for IndexedDB storage
      let binary = '';
      for (let i = 0; i < uint8arr.length; i++) {
        binary += String.fromCharCode(uint8arr[i]);
      }
      return BIN_PREFIX + btoa(binary);
    }

    function decodeBinary(stored) {
      // Decode base64 back to Uint8Array
      const b64 = stored.slice(BIN_PREFIX.length);
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }

    return {
      promises: {
        readFile: async (p, opts) => {
          const content = await vfs.readFile(p);
          if (opts === 'utf8' || opts?.encoding === 'utf8') {
            // If binary-encoded, decode and convert to utf8
            if (content && content.startsWith(BIN_PREFIX)) {
              return new TextDecoder().decode(decodeBinary(content));
            }
            return content;
          }
          // Return as Uint8Array
          if (content && content.startsWith(BIN_PREFIX)) {
            return decodeBinary(content);
          }
          return new TextEncoder().encode(content);
        },
        writeFile: async (p, data, opts) => {
          let str;
          if (typeof data === 'string') {
            str = data;
          } else {
            // Binary data (Uint8Array/Buffer) - store as base64
            str = encodeBinary(data instanceof Uint8Array ? data : new Uint8Array(data));
          }
          const parentPath = p.substring(0, p.lastIndexOf('/')) || '/';
          if (parentPath !== '/' && !(await vfs.exists(parentPath))) {
            await vfs.mkdir(parentPath, { recursive: true });
          }
          await vfs.writeFile(p, str);
        },
        unlink: (p) => vfs.unlink(p),
        readdir: async (p) => {
          const entries = await vfs.readdir(p);
          return entries.map(e => e.name);
        },
        mkdir: (p, opts) => vfs.mkdir(p, typeof opts === 'number' ? undefined : opts),
        rmdir: (p) => vfs.rmdir(p),
        stat: async (p) => {
          try {
            const s = await vfs.stat(p);
            return {
              type: s.type,
              mode: s.mode,
              size: s.size,
              mtime: new Date(s.mtime),
              ctime: new Date(s.ctime),
              isFile() { return s.type === 'file'; },
              isDirectory() { return s.type === 'dir'; },
              isSymbolicLink() { return s.type === 'symlink'; },
            };
          } catch (err) {
            // Re-throw with proper error structure for isomorphic-git
            if (err.code === 'ENOENT') throw err;
            throw fsError('ENOENT', `ENOENT: no such file or directory, stat '${p}'`);
          }
        },
        lstat: async (p) => {
          try {
            const s = await vfs.lstat(p);
            return {
              type: s.type,
              mode: s.mode,
              size: s.size,
              mtime: new Date(s.mtime),
              ctime: new Date(s.ctime),
              isFile() { return s.type === 'file'; },
              isDirectory() { return s.type === 'dir'; },
              isSymbolicLink() { return s.type === 'symlink'; },
            };
          } catch (err) {
            // Re-throw with proper error structure for isomorphic-git
            if (err.code === 'ENOENT') throw err;
            throw fsError('ENOENT', `ENOENT: no such file or directory, lstat '${p}'`);
          }
        },
        rename: (o, n) => vfs.rename(o, n),
        symlink: (target, p) => vfs.symlink(target, p),
        readlink: (p) => vfs.readlink(p),
        chmod: (p, m) => vfs.chmod(p, m),
      },
    };
  }

  _globToRegex(pattern) {
    let re = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      // Handle ? first (single char wildcard)
      .replace(/\?/g, '§QUESTION§')
      // Handle **/ as "any path including empty" (matches dir/ or nothing)
      .replace(/\*\*\//g, '§DOUBLESTARSLASH§')
      // Handle ** as "match anything"
      .replace(/\*\*/g, '§DOUBLESTAR§')
      // Handle * as "match anything except /"
      .replace(/\*/g, '[^/]*')
      // Now replace placeholders with final regex parts
      .replace(/§QUESTION§/g, '[^/]')
      .replace(/§DOUBLESTARSLASH§/g, '(.*\\/)?')
      .replace(/§DOUBLESTAR§/g, '.*');
    return new RegExp('^' + re + '$');
  }
}

export default VFS;
