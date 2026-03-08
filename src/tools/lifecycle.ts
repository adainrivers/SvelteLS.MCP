import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LspClient } from "../lsp-client.js";
import { formatError, textResult, ToolResult } from "../tool-base.js";

export function registerLifecycleTools(
  server: McpServer,
  lsp: LspClient
): void {
  server.registerTool(
    "restart_lsp",
    {
      title: "Restart Language Server",
      description:
        "Restart the Svelte language server. Use when the server is in a bad state or returning stale results.",
    },
    async (): Promise<ToolResult> => {
      try {
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
