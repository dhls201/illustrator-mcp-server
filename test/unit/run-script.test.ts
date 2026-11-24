/**
 * run_script（生 ExtendScript 実行）の JSX を Node 上のフェイクで検証する。
 * 実機の eval / $.evalFile 挙動は e2e でしか確認できないが、戻り値の整形・
 * エラー整形・as_file 分岐はここで押さえられる。
 */
import { describe, it, expect } from 'vitest';
import { runToolJsx } from './helpers/run-tool-jsx.js';

const TOOL = 'utility/run-script.ts';

/** 実機の app / document の代わり。スクリプトから参照されることだけ確認する */
const fakeGlobals = {
  app: { version: '30.0', name: 'Adobe Illustrator', documents: { length: 1 } },
  document: { name: 'test.ai' },
};

function run(code: string, extraParams: Record<string, unknown> = {}) {
  return runToolJsx(TOOL, fakeGlobals, { code, ...extraParams });
}

describe('run_script: return value shaping', () => {
  it('returns the value of a simple expression', () => {
    const result = run('1 + 2');
    expect(result.success).toBe(true);
    expect(result.mode).toBe('eval');
    expect(result.return_type).toBe('number');
    expect(result.return_value).toBe('3');
  });

  it('returns a string as-is, not JSON-quoted', () => {
    const result = run('"hello" + " " + "illustrator"');
    expect(result.return_type).toBe('string');
    expect(result.return_value).toBe('hello illustrator');
  });

  it('JSON-serializes an object return value', () => {
    const result = run('({ artboards: 3, mode: "CMYK" })');
    expect(result.return_type).toBe('object');
    expect(result.return_value).toBe('{"artboards":3,"mode":"CMYK"}');
  });

  it('reports return_value null when the script returns nothing', () => {
    const result = run('var x = 5;');
    expect(result.success).toBe(true);
    expect(result.return_type).toBe('undefined');
    expect(result.return_value).toBe(null);
  });

  it('can see app / document from the injected scope', () => {
    const result = run('document.name');
    expect(result.return_value).toBe('test.ai');
  });
});

describe('run_script: error handling', () => {
  it('reports a thrown error as error: true with the message', () => {
    const result = run('throw new Error("deliberate failure");');
    expect(result.error).toBe(true);
    expect(String(result.message)).toContain('deliberate failure');
  });

  it('reports a runtime error from calling an undefined function', () => {
    const result = run('notDefinedAnywhere();');
    expect(result.error).toBe(true);
    expect(String(result.message)).toContain('run_script failed');
  });
});

describe('run_script: as_file mode', () => {
  it('writes a temp .jsx, runs it with $.evalFile and removes the file', () => {
    const written: Record<string, string> = {};
    const removed: string[] = [];
    const fakeFile = (path: string) => ({
      encoding: '',
      open: () => true,
      write: (s: string) => { written[path] = s; return true; },
      close: () => true,
      remove: () => { removed.push(path); return true; },
    });
    const globals = {
      ...fakeGlobals,
      Folder: { temp: '/tmp' },
      File: (path: string) => fakeFile(path),
      $: { evalFile: (f: any) => { written.__evaluated = f; return 'from-file'; } },
    };

    const result = runToolJsx(TOOL, globals as Record<string, unknown>, {
      code: 'return "from-file";',
      as_file: true,
    });

    expect(result.mode).toBe('file');
    expect(result.return_value).toBe('from-file');
    expect(Object.keys(written).some((k) => k.startsWith('/tmp/ai-mcp-run-'))).toBe(true);
    expect(removed).toHaveLength(1);
  });
});
