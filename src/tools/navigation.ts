import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LspClient, pathToUri, uriToPath, symbolKindName } from "../lsp-client.js";
import {
  prepareSymbolRequest,
  prepareDocumentRequest,
  makePositionParams,
  formatLocations,
  formatSymbolTree,
  formatError,
  textResult,
  ToolResult,
} from "../tool-base.js";

export function registerNavigationTools(
  server: McpServer,
  lsp: LspClient
): void {
  server.registerTool(
    "find_definition",
    {
      title: "Find Definition",
      description: "Find the definition of a symbol by name in a file.",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file"),
        symbolName: z.string().describe("Name of the symbol to find"),
        symbolKind: z
          .string()
          .optional()
          .describe(
            "Kind of symbol: class, method, property, field, interface, enum, function, variable, etc."
          ),
      }),
    },
    async ({ filePath, symbolName, symbolKind }): Promise<ToolResult> => {
      try {
        const prep = await prepareSymbolRequest(lsp, filePath, symbolName, symbolKind);
        if ("error" in prep) return textResult(prep.error);

        const result = await lsp.request(
          "textDocument/definition",
          makePositionParams(prep.ctx)
        );
        return textResult(formatLocations(result, "definition"));
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );

  server.registerTool(
    "find_references",
    {
      title: "Find References",
      description: "Find all references to a symbol across the workspace.",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file"),
        symbolName: z.string().describe("Name of the symbol to find"),
        symbolKind: z.string().optional().describe("Kind of symbol"),
        includeDeclaration: z
          .boolean()
          .default(true)
          .describe("Include the declaration itself"),
      }),
    },
    async ({
      filePath,
      symbolName,
      symbolKind,
      includeDeclaration,
    }): Promise<ToolResult> => {
      try {
        const prep = await prepareSymbolRequest(lsp, filePath, symbolName, symbolKind);
        if ("error" in prep) return textResult(prep.error);

        const params = {
          ...makePositionParams(prep.ctx),
          context: { includeDeclaration },
        };
        const result = await lsp.request("textDocument/references", params);
        return textResult(formatLocations(result, "reference"));
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );

  server.registerTool(
    "get_hover",
    {
      title: "Get Hover Info",
      description:
        "Get hover documentation and type info for a symbol.",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file"),
        symbolName: z.string().describe("Name of the symbol to find"),
        symbolKind: z.string().optional().describe("Kind of symbol"),
      }),
    },
    async ({ filePath, symbolName, symbolKind }): Promise<ToolResult> => {
      try {
        const prep = await prepareSymbolRequest(lsp, filePath, symbolName, symbolKind);
        if ("error" in prep) return textResult(prep.error);

        const result = await lsp.request(
          "textDocument/hover",
          makePositionParams(prep.ctx)
        );

        if (!result) return textResult("No hover information available.");

        const contents = result.contents;
        if (!contents) return textResult("No hover information available.");

        if (typeof contents === "string") return textResult(contents);
        if (contents.value) return textResult(contents.value);

        if (Array.isArray(contents)) {
          const parts: string[] = [];
          for (const item of contents) {
            if (typeof item === "string") parts.push(item);
            else if (item.value) parts.push(item.value);
          }
          return textResult(parts.join("\n"));
        }

        return textResult(JSON.stringify(contents, null, 2));
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );

  server.registerTool(
    "go_to_implementation",
    {
      title: "Go to Implementation",
      description:
        "Find implementations of an interface or abstract method.",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file"),
        symbolName: z.string().describe("Name of the symbol to find"),
        symbolKind: z.string().optional().describe("Kind of symbol"),
        filter: z
          .string()
          .optional()
          .describe("Optional regex filter on symbol/file names in results"),
        limit: z
          .number()
          .default(50)
          .describe("Max results to return. Default: 50"),
      }),
    },
    async ({
      filePath,
      symbolName,
      symbolKind,
      filter,
      limit,
    }): Promise<ToolResult> => {
      try {
        const prep = await prepareSymbolRequest(lsp, filePath, symbolName, symbolKind);
        if ("error" in prep) return textResult(prep.error);

        const result = await lsp.request(
          "textDocument/implementation",
          makePositionParams(prep.ctx)
        );
        return textResult(formatLocations(result, "implementation", filter, limit));
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );

  server.registerTool(
    "go_to_type_definition",
    {
      title: "Go to Type Definition",
      description:
        "Jump to the type definition of a symbol (e.g. find the class/interface of a variable).",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file"),
        symbolName: z.string().describe("Name of the symbol to find"),
        symbolKind: z.string().optional().describe("Kind of symbol"),
      }),
    },
    async ({ filePath, symbolName, symbolKind }): Promise<ToolResult> => {
      try {
        const prep = await prepareSymbolRequest(lsp, filePath, symbolName, symbolKind);
        if ("error" in prep) return textResult(prep.error);

        const result = await lsp.request(
          "textDocument/typeDefinition",
          makePositionParams(prep.ctx)
        );
        return textResult(formatLocations(result, "type definition"));
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );

  server.registerTool(
    "find_document_symbols",
    {
      title: "Find Document Symbols",
      description: "List all symbols defined in a file.",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file"),
      }),
    },
    async ({ filePath }): Promise<ToolResult> => {
      try {
        const prep = await prepareDocumentRequest(lsp, filePath);
        if ("error" in prep) return textResult(prep.error);

        const result = await lsp.request("textDocument/documentSymbol", {
          textDocument: { uri: prep.uri },
        });

        if (!Array.isArray(result) || result.length === 0) {
          return textResult("No symbols found.");
        }

        return textResult(formatSymbolTree(result));
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );

  server.registerTool(
    "find_workspace_symbols",
    {
      title: "Find Workspace Symbols",
      description:
        "Search for symbols across the entire workspace.",
      inputSchema: z.object({
        query: z.string().describe("Search query for the symbol name"),
        pathFilter: z
          .string()
          .optional()
          .describe(
            "Optional path filter (case-insensitive substring match)"
          ),
        filter: z
          .string()
          .optional()
          .describe("Optional regex filter on symbol names"),
        limit: z
          .number()
          .default(50)
          .describe("Max results to return. Default: 50"),
      }),
    },
    async ({ query, pathFilter, filter, limit }): Promise<ToolResult> => {
      try {
        const result = await lsp.request("workspace/symbol", { query });

        if (!Array.isArray(result) || result.length === 0) {
          return textResult(`No symbols matching '${query}' found.`);
        }

        const filterRegex = filter ? new RegExp(filter, "i") : null;
        const lines: string[] = [];
        let shown = 0;
        let matched = 0;
        let total = 0;

        for (const sym of result) {
          const name = sym.name ?? "?";
          const kind = symbolKindName(sym.kind ?? 0);
          const container = sym.containerName ?? "";
          const loc = sym.location;
          const path = loc?.uri ? uriToPath(loc.uri) : "?";
          const line = (loc?.range?.start?.line ?? 0) + 1;

          if (
            pathFilter &&
            !path.toLowerCase().includes(pathFilter.toLowerCase())
          )
            continue;

          total++;
          if (filterRegex && !filterRegex.test(name)) continue;
          matched++;
          if (shown >= limit) continue;

          const containerSuffix =
            container.length > 0 ? ` [${container}]` : "";
          lines.push(`  ${name} (${kind})${containerSuffix} - ${path}:${line}`);
          shown++;
        }

        if (shown === 0) {
          return textResult(
            `No symbols matching '${query}' found` +
              (filter ? ` with filter '${filter}'` : "") +
              (pathFilter ? ` in paths matching '${pathFilter}'` : "") +
              "."
          );
        }

        let header = "Found ";
        if (filter) {
          header +=
            shown < matched
              ? `${shown} of ${matched} symbol(s) matching '${filter}'`
              : `${matched} symbol(s) matching '${filter}'`;
          header += ` (${total} total for '${query}')`;
        } else {
          header +=
            shown < total
              ? `${shown} of ${total} symbol(s) matching '${query}'`
              : `${total} symbol(s) matching '${query}'`;
        }
        if (pathFilter) header += ` (path: '${pathFilter}')`;

        return textResult(header + ":\n\n" + lines.join("\n"));
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );
}
