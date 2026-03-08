import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LspClient, completionItemKindName } from "../lsp-client.js";
import {
  prepareSymbolRequest,
  makePositionParams,
  formatError,
  textResult,
  ToolResult,
} from "../tool-base.js";

export function registerIntelliSenseTools(
  server: McpServer,
  lsp: LspClient
): void {
  server.registerTool(
    "get_completion",
    {
      title: "Get Completion",
      description:
        "Get code completion suggestions at a symbol position. Useful for discovering available members, methods, and types.",
      inputSchema: z.object({
        filePath: z
          .string()
          .describe("Absolute path to the file"),
        symbolName: z
          .string()
          .describe(
            "Name of the symbol to get completions at (positions cursor at the symbol)"
          ),
        symbolKind: z.string().optional().describe("Kind of symbol"),
        limit: z
          .number()
          .default(30)
          .describe("Max items to return. Default: 30"),
      }),
    },
    async ({
      filePath,
      symbolName,
      symbolKind,
      limit,
    }): Promise<ToolResult> => {
      try {
        const prep = await prepareSymbolRequest(lsp, filePath, symbolName, symbolKind);
        if ("error" in prep) return textResult(prep.error);

        const params = {
          ...makePositionParams(prep.ctx),
          context: { triggerKind: 1 }, // Invoked
        };

        const result = await lsp.request("textDocument/completion", params);
        if (!result) return textResult("No completions available.");

        let items: any[];
        if (Array.isArray(result)) {
          items = result;
        } else if (Array.isArray(result.items)) {
          items = result.items;
        } else {
          return textResult("No completions available.");
        }

        if (items.length === 0) return textResult("No completions available.");

        const lines: string[] = [];
        let shown = 0;

        for (const item of items) {
          if (shown >= limit) break;

          const label = item.label ?? "?";
          const kindVal = item.kind ?? 0;
          const kindName = completionItemKindName(kindVal);
          const detail = item.detail;
          const labelDetail = item.labelDetails?.detail;
          const labelDesc = item.labelDetails?.description;

          let entry = `  ${label}`;
          if (labelDetail) entry += labelDetail;
          entry += ` (${kindName})`;
          if (detail) entry += ` - ${detail}`;
          if (labelDesc) entry += ` [${labelDesc}]`;
          lines.push(entry);
          shown++;
        }

        const header =
          shown < items.length
            ? `Showing ${shown} of ${items.length} completion(s)`
            : `Found ${items.length} completion(s)`;

        return textResult(
          `${header} at '${symbolName}':\n\n` + lines.join("\n")
        );
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );

  server.registerTool(
    "get_signature_help",
    {
      title: "Get Signature Help",
      description:
        "Get method signature overloads and parameter info at a symbol position.",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file"),
        symbolName: z
          .string()
          .describe(
            "Name of the symbol (method/function call) to get signatures for"
          ),
        symbolKind: z.string().optional().describe("Kind of symbol"),
      }),
    },
    async ({ filePath, symbolName, symbolKind }): Promise<ToolResult> => {
      try {
        const prep = await prepareSymbolRequest(lsp, filePath, symbolName, symbolKind);
        if ("error" in prep) return textResult(prep.error);

        const result = await lsp.request(
          "textDocument/signatureHelp",
          makePositionParams(prep.ctx)
        );

        if (!result)
          return textResult(
            `No signature help available for '${symbolName}'.`
          );

        const signatures = result.signatures;
        if (!Array.isArray(signatures) || signatures.length === 0) {
          return textResult(`No signatures found for '${symbolName}'.`);
        }

        const activeSignature = result.activeSignature ?? 0;
        const activeParam = result.activeParameter ?? 0;

        const lines: string[] = [
          `Signature(s) for '${symbolName}' (${signatures.length} overload(s)):`,
          "",
        ];

        for (let i = 0; i < signatures.length; i++) {
          const sig = signatures[i];
          const label = sig.label ?? "?";
          const isActive = i === activeSignature;
          const sigActiveParam = sig.activeParameter ?? activeParam;

          lines.push(`${isActive ? "  >> " : "     "}${label}`);

          // Documentation
          const doc = extractMarkupContent(sig.documentation);
          if (doc) lines.push(`     ${doc}`);

          // Parameters
          if (Array.isArray(sig.parameters) && sig.parameters.length > 0) {
            for (let p = 0; p < sig.parameters.length; p++) {
              const param = sig.parameters[p];
              let paramLabel: string;
              if (Array.isArray(param.label)) {
                paramLabel = label.substring(param.label[0], param.label[1]);
              } else {
                paramLabel = param.label ?? "?";
              }
              const paramDoc = extractMarkupContent(param.documentation);
              const marker =
                isActive && p === sigActiveParam ? "*" : " ";

              let entry = `     ${marker} ${paramLabel}`;
              if (paramDoc) entry += ` - ${paramDoc}`;
              lines.push(entry);
            }
          }

          if (i < signatures.length - 1) lines.push("");
        }

        return textResult(lines.join("\n"));
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );
}

function extractMarkupContent(token: any): string | null {
  if (!token) return null;
  if (typeof token === "string") return token;
  if (token.value) return token.value;
  return null;
}
