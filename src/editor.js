// Foam Text Editor - Simple line-based editor for browser environment
// Provides ed/sed-like editing capabilities for Spirit (Claude Code)

export class Editor {
  constructor(vfs, filename) {
    this.vfs = vfs;
    this.filename = filename;
    this.lines = [];
    this.modified = false;
  }

  async load() {
    try {
      const content = await this.vfs.readFile(this.filename);
      this.lines = content.split('\n');
      return true;
    } catch (err) {
      // New file
      this.lines = [''];
      return false;
    }
  }

  async save() {
    const content = this.lines.join('\n');
    await this.vfs.writeFile(this.filename, content);
    this.modified = false;
  }

  // Insert line at position (1-indexed)
  insert(lineNum, text) {
    const index = lineNum - 1;
    if (index < 0 || index > this.lines.length) {
      throw new Error(`Line ${lineNum} out of range`);
    }
    this.lines.splice(index, 0, text);
    this.modified = true;
  }

  // Append line after position (1-indexed)
  append(lineNum, text) {
    const index = lineNum;
    if (index < 0 || index > this.lines.length) {
      throw new Error(`Line ${lineNum} out of range`);
    }
    this.lines.splice(index, 0, text);
    this.modified = true;
  }

  // Delete line at position (1-indexed)
  delete(lineNum) {
    const index = lineNum - 1;
    if (index < 0 || index >= this.lines.length) {
      throw new Error(`Line ${lineNum} out of range`);
    }
    this.lines.splice(index, 1);
    this.modified = true;
  }

  // Change line content (1-indexed)
  change(lineNum, text) {
    const index = lineNum - 1;
    if (index < 0 || index >= this.lines.length) {
      throw new Error(`Line ${lineNum} out of range`);
    }
    this.lines[index] = text;
    this.modified = true;
  }

  // Replace text in line (1-indexed)
  substitute(lineNum, pattern, replacement) {
    const index = lineNum - 1;
    if (index < 0 || index >= this.lines.length) {
      throw new Error(`Line ${lineNum} out of range`);
    }
    const regex = new RegExp(pattern, 'g');
    this.lines[index] = this.lines[index].replace(regex, replacement);
    this.modified = true;
  }

  // Get line content (1-indexed)
  getLine(lineNum) {
    const index = lineNum - 1;
    if (index < 0 || index >= this.lines.length) {
      return null;
    }
    return this.lines[index];
  }

  // Print content with line numbers
  print() {
    return this.lines.map((line, idx) => {
      const num = String(idx + 1).padStart(4, ' ');
      return `${num} │ ${line}`;
    }).join('\n');
  }

  // Get content
  getContent() {
    return this.lines.join('\n');
  }

  // Get line count
  lineCount() {
    return this.lines.length;
  }
}

export default Editor;
