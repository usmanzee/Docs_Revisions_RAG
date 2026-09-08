import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDocumentStorage } from '../../src/modules/storage/local-document-storage.js';
import { StorageError } from '../../src/utils/errors.js';

describe('LocalDocumentStorage path safety', () => {
  let root: string;
  let outside: string;
  let storage: LocalDocumentStorage;

  beforeAll(async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'storage-security-'));
    root = path.join(base, 'documents');
    outside = path.join(base, 'secrets');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'credentials.txt'), 'super-secret');
    storage = new LocalDocumentStorage(root);
  });

  afterAll(async () => {
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  const traversalAttempts = [
    '../secrets/credentials.txt',
    '../../etc/passwd',
    'FIN-POL-001/../../secrets/credentials.txt',
    './../secrets/credentials.txt',
    'a/b/c/../../../../secrets/credentials.txt',
  ];

  it.each(traversalAttempts)('rejects traversal: %s', async (key) => {
    await expect(storage.read(key)).rejects.toBeInstanceOf(StorageError);
  });

  it('rejects absolute paths', async () => {
    await expect(storage.read('/etc/passwd')).rejects.toThrow(/relative/);
  });

  it('rejects Windows absolute and UNC paths', async () => {
    await expect(storage.read('C:\\Windows\\win.ini')).rejects.toThrow(/illegal storage key/);
    await expect(storage.read('\\\\server\\share\\file.txt')).rejects.toThrow(/illegal storage key/);
  });

  it('rejects keys containing a NUL byte', async () => {
    await expect(storage.read('valid.pdf\u0000.txt')).rejects.toThrow(/illegal storage key/);
  });

  it('rejects an empty key', async () => {
    await expect(storage.read('')).rejects.toThrow(/non-empty/);
  });

  it('rejects a sibling directory that shares the root prefix', async () => {
    // `/tmp/x/documents-evil` must not be treated as a child of `/tmp/x/documents`.
    await expect(storage.read('../documents-evil/file.txt')).rejects.toBeInstanceOf(StorageError);
  });

  it('allows legitimate keys', async () => {
    const key = 'FIN-POL-001/rev-001/expense-policy.pdf';
    await storage.write(key, Buffer.from('hello'));

    expect((await storage.read(key)).toString()).toBe('hello');
    expect(await storage.exists(key)).toBe(true);
  });

  it('builds keys that strip unexpected characters', () => {
    const key = LocalDocumentStorage.buildKey('../evil', 2, '../../passwd');
    expect(key).toBe('.._evil/rev-002/.._.._passwd');
    // And the resulting key is still confined by resolveKey.
    expect(() => new LocalDocumentStorage(root).resolveKeyForRead(key)).not.toThrow();
  });

  it('lists only files beneath the root, as relative POSIX keys', async () => {
    await storage.write('HR-POL-001/rev-001/leave.pdf', Buffer.from('x'));
    const entries = await storage.list();

    expect(entries.every((entry) => !entry.key.startsWith('/'))).toBe(true);
    expect(entries.some((entry) => entry.key === 'HR-POL-001/rev-001/leave.pdf')).toBe(true);
  });
});
