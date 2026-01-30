# NPX Implementation for Foam

## Overview

I've implemented `npx` for Foam, enabling Spirit (Claude Code) to run npm packages without installation in the browser-native environment. This is a critical missing feature for modern JavaScript development workflows.

## Why NPX is Critical

1. **Spirit Dependencies**: Claude Code frequently uses npx to run tools like:
   - `npx vite` - Build tools
   - `npx prettier` - Code formatting
   - `npx eslint` - Linting
   - `npx tsc` - TypeScript compilation

2. **Modern JS Workflow**: NPX is the standard way to run one-off commands without global installation

3. **Zero-Install Philosophy**: Run packages directly from CDN without cluttering node_modules

## Implementation Details

### Location
- File: `/src/devtools.js`
- Added `commands.npx` function alongside existing `git`, `npm`, and `node` commands

### How It Works

1. **Package Loading**: Fetches packages from esm.sh (browser-compatible npm CDN)
2. **Dynamic Import**: Uses ES module imports for browser-native execution
3. **Two Modes**:
   - **Library Mode**: `npx <package>` - loads the package and shows available exports
   - **Execute Mode**: `npx -e "<code>"` - runs inline code with package imports

### Usage Examples

```bash
# Load a package and see available exports
npx nanoid
# Output: ✓ Loaded nanoid
#         Available exports: customAlphabet, customRandom, nanoid, random, urlAlphabet

# Execute inline code with imports
npx -e "const { nanoid } = await import('https://esm.sh/nanoid'); return nanoid()"
# Output: V1StGXR8_Z5jdHi6B-myT (example ID)

# Use date-fns for formatting
npx -e "const { format } = await import('https://esm.sh/date-fns'); return format(new Date(), 'yyyy-MM-dd')"
# Output: 2024-01-29

# Data manipulation with lodash
npx -e "const { sortBy } = await import('https://esm.sh/lodash-es'); return JSON.stringify(sortBy([{a:3},{a:1}], 'a'))"
# Output: [{"a":1},{"a":3}]
```

## Tested Packages

✅ **Working**:
- `nanoid` - ID generation
- `date-fns` - Date utilities
- `lodash-es` - Utility functions
- `preact` - React alternative
- `ms` - Millisecond parsing

❌ **Not Working** (Node.js dependencies):
- `zx` - Requires fs, child_process
- `cowsay` - No ESM version

## Limitations

1. **Browser-Only Packages**: Only packages with browser-compatible code work
2. **No Node.js APIs**: Packages requiring `fs`, `child_process`, etc. will fail
3. **ESM Only**: Package must have ES module exports
4. **No CLI Binaries**: Can't run traditional CLI tools that expect a shell

## Integration with Spirit

Spirit can now:
- ✅ Run `npx` commands in Foam
- ✅ Import and use npm packages inline
- ✅ Execute JavaScript utilities without installation
- ✅ Work with modern ESM packages

## Future Enhancements

Potential improvements:
1. **WASM Support**: Run Python/Rust tools compiled to WASM via npx
2. **Package Caching**: Better IndexedDB caching for faster re-runs
3. **CLI Shims**: Create adapters for popular CLI tools
4. **Bundle Analysis**: Pre-check if package is browser-compatible

## Code Changes

Modified files:
1. `/src/devtools.js` - Added `commands.npx` implementation
2. `/src/commands.js` - Updated help text to include npx

No breaking changes - fully backward compatible.

## Testing

To test npx in Foam:
1. Open Foam in browser
2. Run: `npx nanoid`
3. Run: `npx -e "const { nanoid } = await import('https://esm.sh/nanoid'); return nanoid()"`

See `demo-npx.sh` for comprehensive examples.

## Impact

This implementation bridges the gap between Foam and standard Node.js development workflows, making Foam a viable platform for Spirit to run real development tasks entirely in the browser.

**Status**: ✅ Implemented and tested
**Next Priority**: Python WASM integration for broader language support
