import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LspClient, uriToPath, symbolKindName } from "../lsp-client.js";
import {
  prepareSymbolRequest,
  makePositionParams,
  formatHierarchyItem,
  formatError,
  textResult,
  ToolResult,
} from "../tool-base.js";

export function registerHierarchyTools(
  server: McpServer,
  lsp: LspClient
): void {
  server.registerTool(
    "incoming_calls",
    {
      title: "Incoming Calls",
      description:
        "Find all functions/methods that call the specified symbol.",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file"),
        symbolName: z
          .string()
          .describe("Name of the symbol to find"),
        symbolKind: z.string().optional().describe("Kind of symbol"),
      }),
    },
    async ({ filePath, symbolName, symbolKind }): Promise<ToolResult> => {
      try {
        const prep = await prepareSymbolRequest(lsp, filePath, symbolName, symbolKind);
        if ("error" in prep) return textResult(prep.error);

        // Try native call hierarchy
        try {
          const prepareResult = await lsp.request(
            "textDocument/prepareCallHierarchy",
            makePositionParams(prep.ctx)
          );
          if (Array.isArray(prepareResult) && prepareResult.length > 0) {
            const result = await lsp.request(
              "callHierarchy/incomingCalls",
              { item: prepareResult[0] }
            );
            if (Array.isArray(result) && result.length > 0) {
              const lines: string[] = [
                `Found ${result.length} caller(s) of '${symbolName}':`,
                "",
              ];
              for (const call of result) {
                if (call.from) {
                  lines.push(formatHierarchyItem(call.from));
                }
              }
              return textResult(lines.join("\n"));
            }
          }
        } catch {
          // call hierarchy not supported, try fallback
        }

        // Fallback: use references
        return textResult(
          await incomingCallsFallback(lsp, prep.ctx, symbolName)
        );
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );

  server.registerTool(
    "outgoing_calls",
    {
      title: "Outgoing Calls",
      description:
        "Find all functions/methods called by the specified symbol.",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file"),
        symbolName: z
          .string()
          .describe("Name of the symbol to find"),
        symbolKind: z.string().optional().describe("Kind of symbol"),
      }),
    },
    async ({ filePath, symbolName, symbolKind }): Promise<ToolResult> => {
      try {
        const prep = await prepareSymbolRequest(lsp, filePath, symbolName, symbolKind);
        if ("error" in prep) return textResult(prep.error);

        // Try native call hierarchy
        try {
          const prepareResult = await lsp.request(
            "textDocument/prepareCallHierarchy",
            makePositionParams(prep.ctx)
          );
          if (Array.isArray(prepareResult) && prepareResult.length > 0) {
            const result = await lsp.request(
              "callHierarchy/outgoingCalls",
              { item: prepareResult[0] }
            );
            if (Array.isArray(result) && result.length > 0) {
              const lines: string[] = [
                `Found ${result.length} call(s) from '${symbolName}':`,
                "",
              ];
              for (const call of result) {
                if (call.to) {
                  lines.push(formatHierarchyItem(call.to));
                }
              }
              return textResult(lines.join("\n"));
            }
          }
        } catch {
          // call hierarchy not supported
        }

        return textResult(
          `No outgoing calls found from '${symbolName}'.`
        );
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );
}

async function incomingCallsFallback(
  lsp: LspClient,
  ctx: { uri: string; line: number; character: number },
  symbolName: string
): Promise<string> {
  const params = {
    textDocument: { uri: ctx.uri },
    position: { line: ctx.line, character: ctx.character },
    context: { includeDeclaration: false },
  };

  const refs = await lsp.request("textDocument/references", params);
  if (!Array.isArray(refs) || refs.length === 0) {
    return `No incoming calls found for '${symbolName}'.`;
  }

  const callers: Array<{
    name: string;
    kind: string;
    path: string;
    line: number;
  }> = [];
  const seen = new Set<string>();
  const symbolCache = new Map<string, any[]>();

  for (const r of refs) {
    const refUri = r.uri;
    const refLine = r.range?.start?.line;
    if (!refUri || refLine == null) continue;

    const refPath = uriToPath(refUri);

    if (!symbolCache.has(refUri)) {
      await lsp.ensureDocumentOpen(refPath);
      const symResult = await lsp.request("textDocument/documentSymbol", {
        textDocument: { uri: refUri },
      });
      symbolCache.set(refUri, Array.isArray(symResult) ? symResult : []);
    }

    const symbols = symbolCache.get(refUri)!;
    const container = findContainingMethod(symbols, refLine);
    if (!container) continue;

    const name = container.name ?? "?";
    const kind = symbolKindName(container.kind ?? 0);
    const range = container.selectionRange ?? container.range;
    const line = (range?.start?.line ?? 0) + 1;

    const key = `${name}:${refPath}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    callers.push({ name, kind, path: refPath, line });
  }

  if (callers.length === 0) {
    return `No incoming calls found for '${symbolName}'.`;
  }

  const lines: string[] = [
    `Found ${callers.length} caller(s) of '${symbolName}':`,
    "",
  ];
  for (const c of callers) {
    lines.push(`  ${c.name} (${c.kind}) - ${c.path}:${c.line}`);
  }
  return lines.join("\n");
}

function findContainingMethod(symbols: any[], line: number): any | null {
  for (const sym of symbols) {
    const range = sym.range;
    if (!range) continue;

    const startLine = range.start?.line ?? -1;
    const endLine = range.end?.line ?? -1;

    if (line < startLine || line > endLine) continue;

    // Check children first (innermost match)
    if (sym.children) {
      const child = findContainingMethod(sym.children, line);
      if (child) return child;
    }

    // Return if it's a method, constructor, or function
    const kind = sym.kind ?? 0;
    if (kind === 6 || kind === 9 || kind === 12) return sym; // Method, Constructor, Function
  }
  return null;
}
