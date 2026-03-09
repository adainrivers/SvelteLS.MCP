import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LspClient } from "../lsp-client.js";
import { formatError, textResult, ToolResult } from "../tool-base.js";

export function registerLifecycleTools(
  server: McpServer,
  lsp: LspClient
): void {
  server.registerTool(
    "load_project",
    {
      title: "Load Project",
      description:
        "Load a Svelte project by its root directory. Restarts the language server pointed at the new workspace. Call this to switch between projects at runtime.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path to the Svelte project root directory"
          ),
      },
    },
    async ({ path }): Promise<ToolResult> => {
      try {
        const resolved = resolve(path);
        if (!existsSync(resolved)) {
          return textResult(`Directory not found: ${resolved}`);
        }
        await lsp.loadProject(resolved);
        return textResult(
          `Loaded project '${basename(resolved)}'. Language server is indexing - first requests may be slow.`
        );
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );

  server.registerTool(
    "restart_lsp",
    {
      title: "Restart Language Server",
      description:
        "Restart the Svelte language server. Use when the server is in a bad state or returning stale results.",
    },
    async (): Promise<ToolResult> => {
      try {
        if (!lsp.isProjectLoaded) {
          return textResult(
            "No project loaded. Call the load_project tool first."
          );
        }
        await lsp.restart();
        return textResult(
          "Svelte language server restarted successfully. First requests may be slow as it re-indexes."
        );
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );
}
