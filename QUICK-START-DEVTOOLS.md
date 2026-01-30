# Quick Start: Development Tools in Foam

## New Commands Available

Foam now includes comprehensive development tools for Spirit (Claude Code):

```
git      - Version control (isomorphic-git)
npm      - Package manager
npx      - Execute npm packages (NEW!)
node     - JavaScript runtime
python   - Python 3.11 via Pyodide (NEW!)
python3  - Alias for python (NEW!)
pip      - Python package manager (NEW!)
```

---

## NPX - Execute npm Packages

### Basic Usage

```bash
# Load a package and see what it exports
npx nanoid
npx preact
npx date-fns

# Execute code with a package
npx -e "const { nanoid } = await import('https://esm.sh/nanoid'); return nanoid()"
```

### Real Examples

```bash
# Generate unique IDs
npx -e "const { nanoid } = await import('https://esm.sh/nanoid'); return nanoid()"
# Output: V1StGXR8_Z5jdHi6B-myT

# Format dates
npx -e "const { format } = await import('https://esm.sh/date-fns'); return format(new Date(), 'yyyy-MM-dd')"
# Output: 2024-01-29

# Data manipulation
npx -e "const { chunk } = await import('https://esm.sh/lodash-es'); return JSON.stringify(chunk([1,2,3,4,5,6], 2))"
# Output: [[1,2],[3,4],[5,6]]

# String utilities
npx -e "const { default: ms } = await import('https://esm.sh/ms'); return ms('2 days')"
# Output: 172800000
```

### Working Packages

✅ Browser-compatible ESM packages:
- `nanoid` - ID generation
- `date-fns` - Date utilities
- `lodash-es` - Data utilities
- `preact` - React alternative
- `ms` - Time parsing
- `chalk` - Colors
- Any pure ESM package

❌ Requires Node.js (won't work):
- `vite`, `webpack` - build tools with fs
- `zx` - shell scripting
- Packages using `fs`, `child_process`

---

## Python - Full Python 3.11 Support

### Basic Usage

```bash
# Check version
python --version

# Execute inline code
python -c "print('hello world')"

# Run a Python file
echo "print('Hello from Python!')" > hello.py
python hello.py

# Python 3 alias works too
python3 -c "print('same as python')"
```

### Real Examples

```bash
# Math
python -c "print(2 ** 10)"
# Output: 1024

# List comprehensions
python -c "print([x*x for x in range(10)])"
# Output: [0, 1, 4, 9, 16, 25, 36, 49, 64, 81]

# Dictionary manipulation
python -c "import json; print(json.dumps({'name': 'Foam', 'v': '0.1'}))"
# Output: {"name": "Foam", "v": "0.1"}

# String processing
python -c "text = 'hello world'; print(text.title())"
# Output: Hello World

# Date/time
python -c "from datetime import datetime; print(datetime.now().strftime('%Y-%m-%d %H:%M'))"
# Output: 2024-01-29 14:30
```

### Python Files

```bash
# Create a Python script
cat > fibonacci.py << 'EOF'
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        print(a, end=' ')
        a, b = b, a + b
    print()

fib(10)
EOF

# Run it
python fibonacci.py
# Output: 0 1 1 2 3 5 8 13 21 34
```

---

## PIP - Python Package Manager

### Installing Packages

```bash
# Install pure Python packages
pip install requests-html
pip install beautifulsoup4

# Install scientific packages (pre-compiled for WASM)
pip install numpy
pip install pandas
pip install matplotlib
pip install scikit-learn

# List installed packages
pip list
```

### Using Installed Packages

```bash
# NumPy example
pip install numpy
python -c "import numpy as np; print(np.array([1, 2, 3]) * 2)"
# Output: [2 4 6]

# Pandas example
pip install pandas
python -c "import pandas as pd; df = pd.DataFrame({'a': [1,2,3]}); print(df)"
#    a
# 0  1
# 1  2
# 2  3
```

---

## Complete Workflows

### Initialize a JavaScript Project

```bash
# Create project
mkdir myapp && cd myapp

# Initialize git
git init

# Initialize npm
npm init

# Create files
echo "console.log('Hello Foam!')" > index.js
echo "# My App" > README.md

# Commit
git add .
git commit -m "Initial commit"

# Run it
node index.js
```

### Python Data Processing

```bash
# Create data processing script
cat > process.py << 'EOF'
import json

data = [
    {"name": "Alice", "score": 85},
    {"name": "Bob", "score": 92},
    {"name": "Charlie", "score": 78}
]

# Sort by score
sorted_data = sorted(data, key=lambda x: x['score'], reverse=True)
print(json.dumps(sorted_data, indent=2))
EOF

# Run it
python process.py
```

### Mixed Language Project

```bash
# Setup
mkdir fullstack && cd fullstack
git init
npm init

# Python backend
cat > server.py << 'EOF'
print("Python backend starting...")
print("API ready on port 8000")
EOF

# JavaScript frontend
cat > app.js << 'EOF'
console.log("Frontend starting...");
console.log("App ready!");
EOF

# Run both
python server.py
node app.js

# Commit
git add .
git commit -m "Add backend and frontend"
```

### Using NPX with Python

```bash
# Generate data with npx, process with Python
npx -e "const { nanoid } = await import('https://esm.sh/nanoid'); return JSON.stringify([nanoid(), nanoid(), nanoid()])" > ids.json

cat > process_ids.py << 'EOF'
import json

with open('ids.json', 'r') as f:
    ids = json.load(f)

print(f"Generated {len(ids)} IDs:")
for i, id_val in enumerate(ids, 1):
    print(f"  {i}. {id_val}")
EOF

python process_ids.py
```

---

## Tips & Tricks

### NPX

1. **Always use ESM imports**: `await import('https://esm.sh/package')`
2. **Check exports first**: Run `npx package` to see available exports
3. **Use -e for one-liners**: Perfect for quick utilities
4. **Pipe output**: `npx -e "..." | python -c "..."`

### Python

1. **First run is slow**: Pyodide loads ~25MB WASM (one-time)
2. **Subsequent runs fast**: WASM is cached by browser
3. **Use -c for quick tests**: No need to create files
4. **Check package compatibility**: Not all packages work in WASM

### Combining Tools

```bash
# NPX generates JSON, Python processes it
npx -e "return JSON.stringify({x: 1, y: 2})" | python -m json.tool

# Python generates data, pipe to file, read with Node
python -c "print('hello from python')" > data.txt
node -e "console.log(require('fs').readFileSync('data.txt', 'utf8'))"

# Git + NPM + Python workflow
git init
npm init
echo "print('v1.0')" > version.py
git add . && git commit -m "Add version script"
```

---

## Troubleshooting

### NPX

**Problem**: Package fails to load
```bash
# Check if it's browser-compatible
npx package-name
# Look for "failed to load" or "Failed to fetch"
```

**Solution**: Use only browser-compatible ESM packages from esm.sh

### Python

**Problem**: "Loading Python" takes too long
```bash
# First run downloads 25MB Pyodide - wait ~5 seconds
# Subsequent runs are instant (cached)
```

**Problem**: Package import fails
```bash
pip install package-name
# Not all packages work in WASM - check Pyodide docs
```

---

## What's Next?

Now available in Foam:
- ✅ JavaScript/TypeScript development
- ✅ Python development
- ✅ Package management (npm, pip)
- ✅ Git version control
- ✅ File operations
- ✅ 60+ Unix commands

Spirit (Claude Code) can now run real development workflows entirely in the browser!

---

## Quick Reference

| Task | Command |
|------|---------|
| Check versions | `node --version`, `python --version`, `npm --version` |
| Init project | `git init`, `npm init` |
| Install packages | `npm install pkg`, `pip install pkg` |
| Run package | `npx pkg` |
| Execute code | `npx -e "code"`, `python -c "code"` |
| Run file | `node file.js`, `python file.py` |
| Commit changes | `git add .`, `git commit -m "msg"` |
| List commands | `help` |

---

Ready to develop in the browser! 🚀
