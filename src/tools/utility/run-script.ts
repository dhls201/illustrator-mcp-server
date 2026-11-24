import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeJsx, TIMEOUT_HEAVY } from '../../executor/jsx-runner.js';
import { formatToolResult } from '../tool-executor.js';
import { DESTRUCTIVE_ANNOTATIONS } from '../modify/shared.js';

/**
 * run_script — ExtendScript をそのまま実行するエスケープハッチ
 *
 * このリポジトリは通常「型付きツール」だけを公開している（上書き保護・座標系・
 * エラー境界が効くため）。このツールはその方針の例外で、krVatsal/illustrator-mcp の
 * `run` 相当の自由度をローカル利用向けに足すもの。
 *
 * 設計上の要点:
 * - 任意コードは params JSON 経由で渡す（シェルエスケープ不要、巨大コード可）
 * - 既定は eval、as_file: true で一時 .jsx へ書き出して $.evalFile（長いスクリプト向け）
 * - ヘルパー（readParamsFile / writeResultFile / jsonStringify / uuid 系）は
 *   同じスコープに居るのでユーザースクリプトからも呼べる
 * - 破壊的・非冪等なので DESTRUCTIVE_ANNOTATIONS
 */
const jsxCode = `
try {
  var params = readParamsFile(PARAMS_PATH);
  var verErr = checkIllustratorVersion();
  if (verErr) {
    writeResultFile(RESULT_PATH, verErr);
  } else {
    var code = String(params.code);
    var asFile = (params.as_file === true);
    var __value;
    var __mode = asFile ? "file" : "eval";

    if (asFile) {
      var tmpName = "ai-mcp-run-" + generateUUID() + ".jsx";
      var tmpFile = File(Folder.temp + "/" + tmpName);
      tmpFile.encoding = "UTF-8";
      tmpFile.open("w");
      tmpFile.write(code);
      tmpFile.close();
      try {
        __value = $.evalFile(tmpFile);
      } finally {
        try { tmpFile.remove(); } catch (eRemove) {}
      }
    } else {
      __value = eval(code);
    }

    var __type = (typeof __value);
    var __text = null;
    var __notes = [];
    if (__type !== "undefined") {
      if (__type === "string") {
        __text = __value;
      } else {
        try {
          __text = jsonStringify(__value);
        } catch (eJson) {
          try {
            __text = String(__value);
          } catch (eStr) {
            __text = "[unserializable " + __type + "]";
          }
          __notes.push("Return value was not JSON-serializable; returned String() instead.");
        }
      }
    }

    var __result = {
      success: true,
      mode: __mode,
      return_type: __type,
      return_value: __text
    };
    if (__notes.length > 0) { __result.warnings = __notes; }
    writeResultFile(RESULT_PATH, __result);
  }
} catch (e) {
  writeResultFile(RESULT_PATH, {
    error: true,
    message: "run_script failed: " + (e && e.message ? e.message : String(e)),
    line: (e && e.line) ? e.line : null
  });
}
`;

export function register(server: McpServer): void {
  server.registerTool(
    'run_script',
    {
      title: 'Run ExtendScript',
      description:
        'Escape hatch: execute raw ExtendScript/JSX inside Illustrator and return the script\'s value as text. '
        + 'It can do anything the typed tools can, including destructive and irreversible operations, with none of their '
        + 'validation, overwrite protection or UUID tracking — no undo is performed by this server. Prefer the typed tools '
        + 'for anything they cover; use this only for operations they cannot express. Scripts run in the same scope as the '
        + 'built-in helpers (readParamsFile, writeResultFile, jsonStringify, generateUUID, findItemByUUID, ...), and can '
        + 'use app / document directly. Errors are reported with the ExtendScript line number.',
      inputSchema: {
        code: z
          .string()
          .min(1)
          .describe('ExtendScript source to execute. The last evaluated expression is returned as the tool result.'),
        as_file: z
          .boolean()
          .optional()
          .default(false)
          .describe('Write the code to a temporary .jsx and run it with $.evalFile instead of eval — more robust for long or multi-line scripts (default false)'),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(2147483647)
          .optional()
          .describe('Execution timeout in milliseconds (default: the heavy-tool timeout, ILLUSTRATOR_MCP_TIMEOUT_HEAVY)'),
      },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (params) => {
      const timeout = typeof params.timeout_ms === 'number' ? params.timeout_ms : TIMEOUT_HEAVY;
      const result = await executeJsx(jsxCode, params, { timeout });
      return formatToolResult(result);
    },
  );
}
