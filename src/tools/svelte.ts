import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LspClient, pathToUri, uriToPath } from "../lsp-client.js";
import {
  prepareDocumentRequest,
  formatLocations,
  formatError,
  textResult,
  ToolResult,
} from "../tool-base.js";
import { basename } from "node:path";

export function registerSvelteTools(
  server: McpServer,
  lsp: LspClient
): void {
  server.registerTool(
    "get_compiled_code",
    {
      title: "Get Compiled Code",
      description:
        "Get the compiled JavaScript and CSS output for a Svelte component. Useful for debugging compilation issues.",
      inputSchema: z.object({
        filePath: z
          .string()
          .describe("Absolute path to the .svelte file"),
      }),
    },
    async ({ filePath }): Promise<ToolResult> => {
      try {
        const prep = await prepareDocumentRequest(lsp, filePath);
        if ("error" in prep) return textResult(prep.error);

        const result = await lsp.request("$/getCompiledCode", prep.uri);

        if (!result) {
          return textResult(
            `No compiled code available for ${basename(filePath)}.`
          );
        }

        const parts: string[] = [];

        if (result.js) {
          parts.push("=== Compiled JavaScript ===");
          parts.push(result.js);
        }

        if (result.css) {
          parts.push("");
          parts.push("=== Compiled CSS ===");
          parts.push(result.css);
        }

        if (parts.length === 0) {
          return textResult(
            `Compiled code for ${basename(filePath)} is empty.`
          );
        }

        return textResult(parts.join("\n"));
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );

  server.registerTool(
    "get_component_references",
    {
      title: "Get Component References",
      description:
        "Find all files that use/import a Svelte component.",
      inputSchema: z.object({
        filePath: z
          .string()
          .describe("Absolute path to the .svelte component file"),
      }),
    },
    async ({ filePath }): Promise<ToolResult> => {
      try {
        const uri = pathToUri(filePath);

        const result = await lsp.request("$/getComponentReferences", uri);

        if (!result || !Array.isArray(result) || result.length === 0) {
          return textResult(
            `No references found for component ${basename(filePath)}.`
          );
        }

        return textResult(
          formatLocations(result, "component reference")
        );
      } catch (ex) {
        // This endpoint may not be available
        if (
          String(ex).includes("Unhandled method") ||
          String(ex).includes("not supported")
        ) {
          return textResult(
            "$/getComponentReferences is not supported by this version of svelteserver."
          );
        }
        return textResult(formatError(ex));
      }
    }
  );

  server.registerTool(
    "get_file_references",
    {
      title: "Get File References",
      description:
        "Find all files that reference/import the specified file.",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file"),
      }),
    },
    async ({ filePath }): Promise<ToolResult> => {
      try {
        const uri = pathToUri(filePath);

        const result = await lsp.request("$/getFileReferences", uri);

        if (!result || !Array.isArray(result) || result.length === 0) {
          return textResult(
            `No references found for ${basename(filePath)}.`
          );
        }

        return textResult(formatLocations(result, "file reference"));
      } catch (ex) {
        if (
          String(ex).includes("Unhandled method") ||
          String(ex).includes("not supported")
        ) {
          return textResult(
            "$/getFileReferences is not supported by this version of svelteserver."
          );
        }
        return textResult(formatError(ex));
      }
    }
  );
}
