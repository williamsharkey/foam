# Git Clone Hurdles in Browser Operating Systems (Foam & Shiro)

## Overview

This document tracks issues, challenges, and solutions for implementing `git clone` functionality in browser-based operating systems (Foam and Shiro). Both systems run entirely in the browser with virtual filesystems backed by IndexedDB, presenting unique challenges for network-based git operations.

## Current State

### What Works ✅
- **Local git operations**: `git init`, `git add`, `git commit`, `git log`, `git status`, `git diff`
- **Virtual filesystem persistence**: All git data stored in IndexedDB
- **Git object storage**: Commits, trees, and blobs stored in `.git/` directory structure
- **Branch management**: `git branch`, `git checkout`

### What Doesn't Work ❌
- **git clone**: Cannot fetch repositories from remote servers
- **git push/pull**: No network synchronization
- **git fetch**: Cannot retrieve remote objects
- **Submodule initialization**: Cannot clone submodule repositories

## Key Hurdles

### 1. CORS and Network Fetch Restrictions
**Status**: 🔴 Critical Blocker

**Problem**: Browsers enforce CORS (Cross-Origin Resource Sharing) policies that prevent arbitrary HTTP requests to git servers.

**Details**:
- Git servers (GitHub, GitLab, etc.) don't typically send CORS headers for git protocol endpoints
- `git://` protocol is not supported in browsers
- HTTP(S) git endpoints require CORS headers: `Access-Control-Allow-Origin`
- Smart HTTP protocol requires POST requests that may be blocked

**Impact**: Cannot directly fetch from git repositories using standard git HTTP protocol

**Related Code**:
- `src/devtools.js` - Current git implementation (local-only)
- `src/commands.js` - Command definitions

---

### 2. Authentication (SSH Keys & Personal Access Tokens)
**Status**: 🔴 Critical Blocker

**Problem**: Browser environments cannot handle SSH authentication or secure credential storage like native git.

**Details**:
- SSH protocol (`git@github.com:...`) not available in browsers
- No native SSH key generation/storage
- Personal Access Tokens (PAT) need secure storage (localStorage is not secure)
- GitHub/GitLab tokens exposed in client-side code are security risks
- No system-level credential managers available

**Impact**: Cannot authenticate to private repositories; limited to public repos via proxy

**Security Considerations**:
- Storing PATs in localStorage = exposed to XSS attacks
- Embedding tokens in code = public exposure
- Need encrypted storage or external auth flow

---

### 3. Large Repository Handling & Memory Constraints
**Status**: 🟡 High Priority

**Problem**: Browser environments have limited memory and storage compared to native systems.

**Details**:
- IndexedDB has browser-specific size limits (typically 50MB-unlimited, but varies)
- Large repositories (>100MB) may exceed practical browser memory
- Cloning large repos requires streaming and chunking
- No native support for git's pack file format
- Transferring large binary files problematic

**Impact**: Limited to small-to-medium repositories; large repos may crash or fail

**Potential Mitigations**:
- Implement shallow cloning (`--depth=1`)
- Sparse checkout (only specific directories)
- Pack file streaming and progressive loading
- Quota management and user warnings

---

### 4. Git Protocol Implementation Complexity
**Status**: 🟡 High Priority

**Problem**: Git wire protocol is complex and browser-native implementations are limited.

**Details**:
- Need to implement git smart HTTP protocol in JavaScript
- Pack file format parsing/generation
- Object negotiation protocol
- Delta compression/decompression
- Reference discovery and capabilities exchange

**Impact**: Significant development effort to implement full git protocol

**Existing Solutions**:
- **isomorphic-git**: Browser-compatible git implementation
- Could be integrated as dependency
- Already handles protocol complexity

---

### 5. Proxy/CORS Workarounds Required
**Status**: 🟠 Medium Priority (Temporary Solution)

**Problem**: Direct git access blocked by CORS; need intermediate proxy.

**Details**:
- Requires CORS proxy service (e.g., `https://cors.isomorphic-git.org`)
- Adds latency and dependency on third-party service
- Privacy concerns (proxy sees all git traffic)
- Rate limiting on free proxy services
- Single point of failure

**Impact**: Functional but not ideal; dependency on external service

**Alternatives**:
- Self-hosted CORS proxy
- GitHub API as alternative to git protocol
- Browser extension to modify CORS headers (user-specific)

---

### 6. Submodule Recursive Cloning
**Status**: 🟠 Medium Priority

**Problem**: Foam and Shiro both use git submodules (`spirit`, `fluffycoreutils`) that need initialization.

**Details**:
- `.gitmodules` defines submodules: `spirit`, `fluffycoreutils`
- `git submodule init` and `git submodule update` need network access
- Recursive cloning requires multiple network requests
- Each submodule faces same CORS/auth issues

**Impact**: Cannot fully initialize project without manual intervention

**Current Workaround**:
- Submodules pre-cloned in deployed version
- Not reproducible from clean clone

---

## Proposed Solutions

### Short-Term Solutions (Immediate Implementation)

#### Solution 1: isomorphic-git Integration
**Status**: ✅ Recommended

**Approach**:
- Add `isomorphic-git` as dependency
- Implement `git clone` command using isomorphic-git
- Use CORS proxy for initial testing (https://cors.isomorphic-git.org)
- Support HTTP(S) cloning of public repositories

**Implementation Steps**:
1. Install isomorphic-git: `npm install isomorphic-git`
2. Create adapter layer in `src/git-adapter.js`
3. Implement `clone` command in `src/commands.js`
4. Add config for CORS proxy URL
5. Test with public GitHub repositories

**Pros**:
- Battle-tested library
- Handles git protocol complexity
- Active maintenance
- Good documentation

**Cons**:
- Adds ~200KB dependency
- Still requires CORS proxy
- Limited to HTTP(S) protocol

**Code Example**:
```javascript
// src/git-adapter.js
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';

export async function clone(url, dir, vfs, corsProxy) {
  await git.clone({
    fs: vfs, // Adapter layer needed
    http,
    dir,
    url,
    corsProxy: corsProxy || 'https://cors.isomorphic-git.org',
    singleBranch: true,
    depth: 1 // Shallow clone by default
  });
}
```

---

#### Solution 2: GitHub API as Alternative
**Status**: ✅ Recommended (Complementary)

**Approach**:
- Use GitHub REST API to fetch repository contents
- Reconstruct git structure in VFS
- Avoid git protocol entirely for GitHub repos

**Implementation Steps**:
1. Detect GitHub URLs
2. Use GitHub API: `GET /repos/{owner}/{repo}/zipball/{ref}`
3. Unzip into VFS
4. Reconstruct `.git/` directory with commit history via API
5. Support GitHub PAT via config (optional, for private repos)

**Pros**:
- No CORS proxy needed (GitHub API has CORS headers)
- Works with GitHub authentication
- Simpler than git protocol
- Can fetch specific branches/tags

**Cons**:
- GitHub-specific (not portable to GitLab, Bitbucket)
- API rate limits (60 req/hr unauthenticated, 5000 with token)
- Doesn't clone full git history (unless reconstructed)

**Code Example**:
```javascript
// src/github-clone.js
export async function cloneFromGitHub(repoUrl, targetDir, vfs, token) {
  const { owner, repo } = parseGitHubUrl(repoUrl);

  // Fetch zipball
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/zipball/main`,
    {
      headers: token ? { 'Authorization': `token ${token}` } : {}
    }
  );

  const blob = await response.blob();
  await unzipToVFS(blob, targetDir, vfs);

  // Optionally reconstruct git history
  await fetchCommitHistory(owner, repo, vfs, token);
}
```

---

#### Solution 3: Self-Hosted CORS Proxy
**Status**: 🟡 Consider for Production

**Approach**:
- Deploy dedicated CORS proxy for Foam/Shiro users
- Use Cloudflare Workers or similar edge function
- Whitelist known git servers

**Implementation**:
- Cloudflare Worker or Vercel Edge Function
- Simple proxy: `https://git-proxy.foam.dev/{target-url}`
- Add rate limiting and authentication

**Pros**:
- No dependency on third-party proxies
- Can add authentication and rate limiting
- Privacy-controlled

**Cons**:
- Infrastructure cost
- Maintenance burden
- Still a centralized dependency

---

### Medium-Term Solutions (Future Enhancement)

#### Solution 4: Shallow Clone & Sparse Checkout
**Status**: 🔵 Future Enhancement

**Approach**:
- Implement `git clone --depth=1` (shallow clone)
- Support sparse checkout (only specific directories)
- Reduce data transfer and storage requirements

**Benefits**:
- Faster clones
- Lower memory usage
- Better suited for browser constraints

---

#### Solution 5: Browser Extension for CORS Bypass
**Status**: 🔵 Optional User Enhancement

**Approach**:
- Create browser extension that modifies CORS headers
- Allows direct git access without proxy
- User-installed, opt-in

**Benefits**:
- No proxy dependency
- Full git protocol support
- Better privacy

**Drawbacks**:
- Requires user installation
- Browser-specific
- Security implications

---

### Long-Term Solutions (Research)

#### Solution 6: WebTransport for Git Protocol
**Status**: 🔵 Experimental

**Approach**:
- Use emerging WebTransport API for low-latency git access
- Requires server-side support

---

#### Solution 7: Service Worker Caching
**Status**: 🔵 Experimental

**Approach**:
- Cache cloned repositories in Service Worker
- Offline-first git clone experience

---

## Implementation Priority

### Phase 1: Basic Clone Support (IMMEDIATE)
1. ✅ Integrate isomorphic-git
2. ✅ Implement `git clone` for public repos via CORS proxy
3. ✅ Add shallow clone support (`--depth=1`)
4. ✅ Test with common public repositories

### Phase 2: GitHub Integration (SHORT-TERM)
5. ✅ Add GitHub API clone alternative
6. ✅ Support GitHub PAT for private repos
7. ✅ Handle submodule cloning

### Phase 3: Production Readiness (MEDIUM-TERM)
8. 🔵 Deploy self-hosted CORS proxy
9. 🔵 Add repository size warnings
10. 🔵 Implement quota management

### Phase 4: Advanced Features (LONG-TERM)
11. 🔵 Sparse checkout support
12. 🔵 Delta compression optimization
13. 🔵 Multi-protocol support (GitLab, Bitbucket)

---

## Testing Plan

### Test Cases
1. Clone small public repo (e.g., `https://github.com/octocat/Hello-World`)
2. Clone medium repo with submodules
3. Clone with authentication (GitHub PAT)
4. Handle clone failures gracefully
5. Verify IndexedDB persistence after clone
6. Test shallow clone vs full clone
7. Clone into non-empty directory (should fail)
8. Clone with progress indication

### Test Repositories
- **Small**: `https://github.com/octocat/Hello-World` (~1MB)
- **Medium**: `https://github.com/williamsharkey/foam` (~5MB with submodules)
- **Large**: Test size limits and warnings

---

## Configuration

### Proposed Config Options
```bash
# Set CORS proxy (default: https://cors.isomorphic-git.org)
foam config set git.corsProxy https://my-proxy.com

# Set GitHub PAT for private repos
foam config set git.githubToken ghp_xxxxxxxxxxxx

# Set default clone depth (0 = full, 1 = shallow)
foam config set git.defaultDepth 1

# Enable/disable GitHub API fallback
foam config set git.useGitHubAPI true
```

---

## Open Questions

1. **Should we prioritize GitHub API or isomorphic-git?**
   - Recommendation: Both. GitHub API for GitHub repos, isomorphic-git for others.

2. **How to handle authentication securely?**
   - Recommendation: Warn users about localStorage risks, consider session-only storage.

3. **What are acceptable repository size limits?**
   - Recommendation: Warn at 50MB, hard limit at 100MB (configurable).

4. **Should submodules auto-clone?**
   - Recommendation: Yes, with `--recursive` flag (default false).

5. **How to handle CORS proxy privacy concerns?**
   - Recommendation: Self-host for production, document privacy implications.

---

## Related Issues

### Foam Repository
- Issue #1: Implement git clone support (isomorphic-git integration)
- Issue #2: GitHub API clone alternative
- Issue #3: CORS proxy configuration
- Issue #4: Authentication and security for git operations
- Issue #5: Large repository handling and quotas

### Shiro Repository
- (Same issues apply to Shiro - TypeScript implementation)

### Spirit Repository
- Issue: OSProvider interface for network operations
- Issue: Git operations in virtual OS contract

---

## Resources

- [isomorphic-git](https://isomorphic-git.org/) - Browser-compatible git implementation
- [Git HTTP Protocol](https://git-scm.com/docs/http-protocol) - Git smart HTTP spec
- [GitHub API](https://docs.github.com/en/rest) - GitHub REST API reference
- [CORS Proxy Options](https://gist.github.com/jimmywarting/ac1be6ea0297c16c477e17f8fbe51347) - CORS proxy implementations

---

## Contributors

- Initial analysis: Claude (AI Assistant)
- Maintainer: @williamsharkey

---

**Last Updated**: 2026-01-29
