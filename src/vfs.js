// Virtual File System - IndexedDB-backed Unix-like filesystem
// Stores inodes with metadata and content in IndexedDB, with an in-memory cache

const DB_NAME = 'foam-vfs';
const DB_VERSION = 1;
const STORE_NAME = 'inodes';

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

  resolvePath(p) {
    if (!p) return this.cwd;
    // Handle ~ expansion
    if (p.startsWith('~')) {
      p = this.env.HOME + p.slice(1);
    }
    if (!p.startsWith('/')) {
      p = this.cwd + '/' + p;
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
    if (!inode) throw new Error(`stat: cannot stat '${path}': No such file or directory`);
    return { ...inode };
  }

  async exists(path) {
    path = this.resolvePath(path);
    return !!(await this._get(path));
  }

  async readFile(path) {
    path = this.resolvePath(path);
    const inode = await this._get(path);
    if (!inode) throw new Error(`cat: ${path}: No such file or directory`);
    if (inode.type === 'dir') throw new Error(`cat: ${path}: Is a directory`);
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
    const regex = this._globToRegex(pattern);
    for (const [p] of this.cache) {
      if (p.startsWith(basePath) && regex.test(p)) {
        results.push(p);
      }
    }
    return results.sort();
  }

  _globToRegex(pattern) {
    let re = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '§DOUBLESTAR§')
      .replace(/\*/g, '[^/]*')
      .replace(/§DOUBLESTAR§/g, '.*')
      .replace(/\?/g, '[^/]');
    return new RegExp('^' + re + '$');
  }
}

export default VFS;
