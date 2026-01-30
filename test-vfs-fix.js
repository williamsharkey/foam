// Test script to verify VFS stat() fix for isomorphic-git compatibility
import VFS from './src/vfs.js';

async function testVFSFix() {
  console.log('=== Testing VFS stat() fix for isomorphic-git ===\n');

  const vfs = new VFS();
  await vfs.init();

  console.log('1. Testing stat() on existing file...');
  try {
    const stat = await vfs.stat('/home/user/.bashrc');
    console.log('✓ stat() on existing file works:', stat.type);
  } catch (err) {
    console.log('✗ Failed:', err.message);
  }

  console.log('\n2. Testing stat() on non-existent file...');
  try {
    const stat = await vfs.stat('/home/user/nonexistent');
    console.log('✗ Should have thrown ENOENT, but got:', stat);
  } catch (err) {
    console.log('✓ Correctly threw error');
    console.log('  - error.message:', err.message);
    console.log('  - error.code:', err.code);
    console.log('  - error.errno:', err.errno);

    if (err.code === 'ENOENT' && err.errno === -2) {
      console.log('✓ Error structure matches isomorphic-git expectations!');
    } else {
      console.log('✗ Error structure incomplete:');
      if (err.code !== 'ENOENT') console.log('  - Missing or wrong err.code');
      if (err.errno !== -2) console.log('  - Missing or wrong err.errno');
    }
  }

  console.log('\n3. Testing toIsomorphicGitFS() adapter...');
  const fs = vfs.toIsomorphicGitFS();
  try {
    const stat = await fs.promises.stat('/home/user/.bashrc');
    console.log('✓ Adapter stat() on existing file works');
  } catch (err) {
    console.log('✗ Adapter failed on existing file:', err.message);
  }

  console.log('\n4. Testing adapter stat() on non-existent file...');
  try {
    const stat = await fs.promises.stat('/tmp/.git/config');
    console.log('✗ Should have thrown, but got:', stat);
  } catch (err) {
    console.log('✓ Correctly threw error');
    console.log('  - error.message:', err.message);
    console.log('  - error.code:', err.code);
    console.log('  - error.errno:', err.errno);

    if (err.code === 'ENOENT' && err.errno === -2) {
      console.log('✓ Adapter error structure is correct!');
      console.log('\n=== SUCCESS! VFS is ready for isomorphic-git ===');
    } else {
      console.log('✗ Adapter error structure incorrect');
      console.log('\n=== FAILED: More work needed ===');
    }
  }
}

testVFSFix().catch(console.error);
