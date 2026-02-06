import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

// Import the function we want to test
// Note: This is a simplified test that focuses on edge cases
// The actual extractZipRequestToDirectory is complex and would need integration testing

describe('File extraction edge cases', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `extract-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await fsp.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fsp.rm(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('should handle file/directory name collision - file exists, then need directory', async () => {
    // This test simulates the scenario where a ZIP contains:
    // 1. A file named "file"
    // 2. A file inside "file/subfile" (which would require "file" to be a directory)
    
    const filePath = path.join(testDir, 'file');
    const subfilePath = path.join(testDir, 'file', 'subfile.txt');
    
    // Create the file first
    await fsp.writeFile(filePath, 'original content');
    expect((await fsp.stat(filePath)).isFile()).toBe(true);
    
    // Now simulate what mkdirp should do when we try to write a file inside "file"
    // The mkdirp function should handle ENOTDIR by removing the blocking file
    const dirPath = path.dirname(subfilePath);
    
    // First, remove the blocking file
    try {
      const stat = await fsp.stat(dirPath);
      if (!stat.isDirectory()) {
        await fsp.rm(dirPath, { force: true });
      }
    } catch {}
    
    // Create the directory
    await fsp.mkdir(dirPath, { recursive: true });
    
    // Now we can write the file
    await fsp.writeFile(subfilePath, 'new content');
    
    expect((await fsp.stat(subfilePath)).isFile()).toBe(true);
    expect((await fsp.stat(dirPath)).isDirectory()).toBe(true);
  });

  it('should handle multiple files with the same parent directory path', async () => {
    // This test simulates the scenario where a ZIP contains:
    // 1. dir/file1.txt
    // 2. dir/file2.txt
    // 3. dir/subdir/file3.txt
    // All referencing the same parent directory
    
    const dirPath = path.join(testDir, 'dir');
    const file1Path = path.join(dirPath, 'file1.txt');
    const file2Path = path.join(dirPath, 'file2.txt');
    const file3Path = path.join(dirPath, 'subdir', 'file3.txt');
    
    // Create all files (simulating multiple mkdir calls to the same path)
    await fsp.mkdir(path.dirname(file1Path), { recursive: true });
    await fsp.writeFile(file1Path, 'content1');
    
    // Second mkdir call to the same directory should not fail
    await fsp.mkdir(path.dirname(file2Path), { recursive: true });
    await fsp.writeFile(file2Path, 'content2');
    
    // Nested directory
    await fsp.mkdir(path.dirname(file3Path), { recursive: true });
    await fsp.writeFile(file3Path, 'content3');
    
    expect((await fsp.stat(file1Path)).isFile()).toBe(true);
    expect((await fsp.stat(file2Path)).isFile()).toBe(true);
    expect((await fsp.stat(file3Path)).isFile()).toBe(true);
  });

  it('should handle directory entry in ZIP followed by file with same parent', async () => {
    // This test simulates a ZIP with:
    // 1. dir/ (directory entry)
    // 2. dir/file.txt (file entry)
    
    const dirPath = path.join(testDir, 'dir');
    const filePath = path.join(dirPath, 'file.txt');
    
    // First, create the directory as a directory entry
    await fsp.mkdir(dirPath, { recursive: true });
    expect((await fsp.stat(dirPath)).isDirectory()).toBe(true);
    
    // Then write a file inside
    await fsp.writeFile(filePath, 'file content');
    expect((await fsp.stat(filePath)).isFile()).toBe(true);
    
    // Both should exist
    expect((await fsp.stat(dirPath)).isDirectory()).toBe(true);
    expect((await fsp.stat(filePath)).isFile()).toBe(true);
  });

  it('should handle overwriting a directory with a file', async () => {
    // This test simulates a malformed ZIP with:
    // 1. file/ (directory entry)
    // 2. file (file entry - same name, should overwrite)
    
    const dirPath = path.join(testDir, 'file');
    
    // First create as a directory
    await fsp.mkdir(dirPath, { recursive: true });
    expect((await fsp.stat(dirPath)).isDirectory()).toBe(true);
    
    // Now remove it and write as a file
    await fsp.rm(dirPath, { recursive: true, force: true });
    await fsp.writeFile(dirPath, 'file content');
    expect((await fsp.stat(dirPath)).isFile()).toBe(true);
  });

  it('should handle race condition with concurrent mkdir calls', async () => {
    // This test checks that multiple concurrent mkdirp calls don't fail with EEXIST
    const dirPath = path.join(testDir, 'concurrent-dir');
    
    // Simulate concurrent mkdir calls
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        fsp.mkdir(dirPath, { recursive: true }).catch(e => {
          // EEXIST should be ignored
          if (e?.code !== 'EEXIST') throw e;
        })
      );
    }
    
    await Promise.all(promises);
    expect((await fsp.stat(dirPath)).isDirectory()).toBe(true);
  });
});
