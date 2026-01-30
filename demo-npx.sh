#!/bin/bash
# NPX Demo Script for Foam - demonstrates the new npx functionality

echo "=== NPX Implementation Demo for Foam ==="
echo ""

echo "1. Test npx help"
npx
echo ""

echo "2. Load nanoid (ID generation library)"
npx nanoid
echo ""

echo "3. Generate a unique ID using npx -e"
npx -e "const { nanoid } = await import('https://esm.sh/nanoid'); return nanoid()"
echo ""

echo "4. Load preact (React alternative)"
npx preact
echo ""

echo "5. Load date-fns"
npx date-fns
echo ""

echo "6. Format current date using date-fns"
npx -e "const { format } = await import('https://esm.sh/date-fns'); return format(new Date(), 'PPpp')"
echo ""

echo "7. Test lodash-es utility functions"
npx -e "const { chunk } = await import('https://esm.sh/lodash-es'); return JSON.stringify(chunk([1,2,3,4,5], 2))"
echo ""

echo "8. Test ms (millisecond parsing)"
npx -e "const ms = (await import('https://esm.sh/ms')).default; return ms('2 days')"
echo ""

echo "=== NPX Demo Complete ==="
echo ""
echo "Key Features:"
echo "  ✓ Load any ESM-compatible npm package from esm.sh"
echo "  ✓ Execute inline code with -e flag"
echo "  ✓ Full browser-native package execution"
echo "  ✓ No server required - runs entirely in the browser"
echo ""
echo "This makes Foam a true browser-native development environment!"
