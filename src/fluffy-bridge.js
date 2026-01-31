// Bridge between fluffycoreutils and Foam's command system.
// Wraps Foam's VFS as a FluffyFS and adapts FluffyCommand → Foam command signature.

import { allCommands } from '../fluffycoreutils/dist/fluffycoreutils.js';
import commands from './commands.js';

/**
 * Create a FluffyFS adapter wrapping Foam's VFS.
 * FluffyFS.resolvePath(path, cwd) takes explicit cwd;
 * Foam's VFS resolves relative to its internal cwd.
 */
function createFluffyFS(vfs) {
  return {
    async readFile(path) {
      return vfs.readFile(path);
    },
    async writeFile(path, content) {
      return vfs.writeFile(path, content);
    },
    async mkdir(path, opts) {
      return vfs.mkdir(path, opts);
    },
    async readdir(path) {
      const entries = await vfs.readdir(path);
      return entries.map(e => ({
        name: e.name,
        type: e.type,
        size: e.size || 0,
        mtime: e.mtime || 0,
      }));
    },
    async stat(path) {
      const s = await vfs.stat(path);
      return {
        type: s.type,
        size: s.size || 0,
        mode: s.mode || (s.type === 'dir' ? 0o755 : 0o644),
        mtime: s.mtime || 0,
      };
    },
    async exists(path) {
      return vfs.exists(path);
    },
    async unlink(path) {
      return vfs.unlink(path);
    },
    async rename(oldPath, newPath) {
      return vfs.rename(oldPath, newPath);
    },
    async rmdir(path, opts) {
      return vfs.rmdir(path, opts);
    },
    async symlink(target, path) {
      return vfs.symlink(target, path);
    },
    async readlink(path) {
      return vfs.readlink(path);
    },
    async copy(src, dest, opts) {
      return vfs.copy(src, dest, opts);
    },
    resolvePath(path, cwd) {
      // FluffyFS passes explicit cwd; use Foam's resolution but
      // temporarily set cwd if needed
      if (path.startsWith('/')) return path;
      // Resolve relative to the given cwd
      const resolved = cwd === '/' ? '/' + path : cwd + '/' + path;
      // Normalize .. and .
      const parts = resolved.split('/');
      const stack = [];
      for (const p of parts) {
        if (p === '' || p === '.') continue;
        if (p === '..') { stack.pop(); continue; }
        stack.push(p);
      }
      return '/' + stack.join('/');
    },
  };
}

/**
 * Adapt a FluffyCommand to Foam's command signature:
 *   async (args, { stdin, stdout, stderr, vfs, env, exec }) => exitCode
 */
function adaptCommand(fluffyCmd) {
  return async (args, ctx) => {
    const fs = createFluffyFS(ctx.vfs);
    const io = {
      stdin: ctx.stdin || '',
      env: ctx.vfs.env,
      cwd: ctx.vfs.cwd,
      fs,
      // Pass through exec for commands like xargs that need to run subcommands
      exec: ctx.exec,
    };
    const result = await fluffyCmd.exec(args, io);
    if (result.stdout) ctx.stdout(result.stdout);
    if (result.stderr) ctx.stderr(result.stderr);
    return result.exitCode;
  };
}

/**
 * Register all fluffycoreutils commands into Foam's command map.
 * Does NOT overwrite commands that already exist in Foam
 * (so Foam-specific commands like dom, js, glob, source, type, which are preserved).
 */
export function registerFluffyCommands() {
  for (const [name, cmd] of Object.entries(allCommands)) {
    // Don't overwrite Foam-specific commands that need shell/VFS access
    if (!commands[name]) {
      commands[name] = adaptCommand(cmd);
    }
  }
}

/**
 * List of command names provided by fluffycoreutils.
 */
export const fluffyCommandNames = Object.keys(allCommands);

export default registerFluffyCommands;
