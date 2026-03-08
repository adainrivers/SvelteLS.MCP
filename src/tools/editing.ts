import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LspClient, uriToPath } from "../lsp-client.js";
import {
  prepareSymbolRequest,
  prepareDocumentRequest,
  makePositionParams,
  formatWorkspaceEdit,
  applyWorkspaceEdit,
  applyTextEdits,
  formatError,
  textResult,
  ToolResult,
} from "../tool-base.js";
import { basename } from "node:path";

export function registerEditingTools(
  server: McpServer,
  lsp: LspClient
): void {
  server.registerTool(
    "rename_symbol",
    {
      title: "Rename Symbol",
      description:
        "Rename a symbol across the workspace. Applies changes to disk.",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file"),
        symbolName: z.string().describe("Name of the symbol to rename"),
        newName: z.string().describe("New name for the symbol"),
        symbolKind: z.string().optional().describe("Kind of symbol"),
      }),
    },
    async ({
      filePath,
      symbolName,
      newName,
      symbolKind,
    }): Promise<ToolResult> => {
      try {
        const prep = await prepareSymbolRequest(lsp, filePath, symbolName, symbolKind);
        if ("error" in prep) return textResult(prep.error);

        // Prepare rename check
        const prepareResult = await lsp.request(
          "textDocument/prepareRename",
          makePositionParams(prep.ctx)
        );
        if (!prepareResult) {
          return textResult(`Symbol '${symbolName}' cannot be renamed.`);
        }

        // Execute rename
        const renameParams = {
          ...makePositionParams(prep.ctx),
          newName,
        };
        const result = await lsp.request("textDocument/rename", renameParams);

        if (!result) return textResult("Rename failed - no changes returned.");

        const applied = await applyWorkspaceEdit(lsp, result);
        const summary = formatRenameEdit(result, symbolName, newName);
        return textResult(
          applied
            ? summary
            : `(dry-run, edits NOT applied to disk)\n\n${summary}`
        );
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );

  server.registerTool(
    "format_document",
    {
      title: "Format Document",
      description:
        "Format a file (or a range of lines) using the project's formatting rules.",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file"),
        startLine: z
          .number()
          .optional()
          .describe("Optional start line (1-based) for range formatting"),
        endLine: z
          .number()
          .optional()
          .describe("Optional end line (1-based) for range formatting"),
        tabSize: z.number().default(2).describe("Tab size. Default: 2"),
        insertSpaces: z
          .boolean()
          .default(true)
          .describe("Use spaces instead of tabs. Default: true"),
      }),
    },
    async ({
      filePath,
      startLine,
      endLine,
      tabSize,
      insertSpaces,
    }): Promise<ToolResult> => {
      try {
        const prep = await prepareDocumentRequest(lsp, filePath);
        if ("error" in prep) return textResult(prep.error);

        const options = {
          tabSize,
          insertSpaces,
          trimTrailingWhitespace: true,
          insertFinalNewline: true,
          trimFinalNewlines: true,
        };

        let result: any;
        if (startLine != null) {
          const sl = startLine - 1;
          const el = (endLine ?? startLine) - 1;
          result = await lsp.request("textDocument/rangeFormatting", {
            textDocument: { uri: prep.uri },
            range: {
              start: { line: sl, character: 0 },
              end: { line: el + 1, character: 0 },
            },
            options,
          });
        } else {
          result = await lsp.request("textDocument/formatting", {
            textDocument: { uri: prep.uri },
            options,
          });
        }

        if (!Array.isArray(result) || result.length === 0) {
          return textResult(
            `No formatting changes needed in ${basename(filePath)}.`
          );
        }

        const count = await applyTextEdits(lsp, filePath, result);
        const rangeDesc =
          startLine != null
            ? ` (lines ${startLine}-${endLine ?? startLine})`
            : "";
        return textResult(
          `Formatted ${basename(filePath)}${rangeDesc}: ${count} edit(s) applied.`
        );
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );
}

function formatRenameEdit(
  result: any,
  oldName: string,
  newName: string
): string {
  const lines: string[] = [];
  let totalEdits = 0;
  let fileCount = 0;

  function formatChanges(docUri: string, edits: any[]): void {
    if (edits.length === 0) return;
    const path = uriToPath(docUri);
    fileCount++;
    lines.push(`  ${path} (${edits.length} edit(s))`);
    for (const edit of edits) {
      const line = (edit.range?.start?.line ?? 0) + 1;
      lines.push(`    line ${line}: '${oldName}' -> '${newName}'`);
      totalEdits++;
    }
  }

  if (result.documentChanges) {
    for (const dc of result.documentChanges) {
      const uri = dc.textDocument?.uri;
      if (uri && dc.edits) formatChanges(uri, dc.edits);
    }
  }

  if (result.changes) {
    for (const [uri, edits] of Object.entries(result.changes)) {
      if (Array.isArray(edits)) formatChanges(uri, edits);
    }
  }

  if (totalEdits === 0) {
    return `Rename '${oldName}' -> '${newName}': no changes needed.`;
  }

  return (
    `Rename '${oldName}' -> '${newName}': ${totalEdits} edit(s) across ${fileCount} file(s):\n\n` +
    lines.join("\n")
  );
}
