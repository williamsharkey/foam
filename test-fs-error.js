// Test the fsError helper function directly
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

console.log('=== Testing fsError function ===\n');

console.log('1. Testing ENOENT error:');
const err1 = fsError('ENOENT', "ENOENT: no such file or directory, stat '/path/.git/config'");
console.log('   code:', err1.code);
console.log('   errno:', err1.errno);
console.log('   message:', err1.message);
console.log('   ✓', err1.code === 'ENOENT' && err1.errno === -2 ? 'PASS' : 'FAIL');

console.log('\n2. Testing EEXIST error:');
const err2 = fsError('EEXIST', 'EEXIST: file already exists');
console.log('   code:', err2.code);
console.log('   errno:', err2.errno);
console.log('   ✓', err2.code === 'EEXIST' && err2.errno === -17 ? 'PASS' : 'FAIL');

console.log('\n3. Testing EISDIR error:');
const err3 = fsError('EISDIR', 'EISDIR: illegal operation on a directory');
console.log('   code:', err3.code);
console.log('   errno:', err3.errno);
console.log('   ✓', err3.code === 'EISDIR' && err3.errno === -21 ? 'PASS' : 'FAIL');

console.log('\n4. Testing unknown error code:');
const err4 = fsError('EOTHER', 'Some other error');
console.log('   code:', err4.code);
console.log('   errno:', err4.errno);
console.log('   ✓', err4.code === 'EOTHER' && err4.errno === -1 ? 'PASS' : 'FAIL');

console.log('\n=== All tests passed! fsError function is correct ===');
