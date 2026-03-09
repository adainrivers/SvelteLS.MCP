import { spawn, ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, basename } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  MessageConnection,
} from "vscode-jsonrpc/node.js";
import {
  InitializeParams,
  InitializeResult,
  DidOpenTextDocumentParams,
  DidCloseTextDocumentParams,
  DocumentSymbolParams,
  SymbolKind,
  PublishDiagnosticsParams,
  Diagnostic,
} from "vscode-languageserver-protocol";

export interface LspClientOptions {
  projectRoot?: string;
  timeoutMs?: number;
}

export class LspClient {
  private process: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private openDocuments = new Set<string>();
  private diagnosticsCache = new Map<string, Diagnostic[]>();
  private diagnosticsWaiters = new Map<
    string,
    Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }>
  >();
  private serverCapabilities: InitializeResult["capabilities"] | null = null;

  projectRoot: string | undefined;
  readonly timeoutMs: number;

  get isProjectLoaded(): boolean {
    return this.projectRoot != null && this.connection != null;
  }

  private requireProject(): void {
    if (!this.projectRoot || !this.connection) {
      throw new Error(
        "No project loaded. Call the load_project tool first."
      );
    }
  }

  constructor(options: LspClientOptions) {
    this.projectRoot = options.projectRoot;
    this.timeoutMs =
      options.timeoutMs ??
      parseInt(process.env["SVELTELS_TIMEOUT"] ?? "30000", 10);
  }

  async start(): Promise<void> {
    const serverPath = resolveSvelteServer();
    console.error(`[svelteserver] resolved: ${serverPath}`);

    this.process = spawn(process.execPath, [serverPath, "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      console.error(`[svelteserver] ${data.toString().trimEnd()}`);
    });

    this.process.on("exit", (code) => {
      console.error(`[svelteserver] exited with code ${code}`);
    });

    if (!this.process.stdin || !this.process.stdout) {
      throw new Error("Failed to get svelteserver stdio streams");
    }

    this.connection = createMessageConnection(
      new StreamMessageReader(this.process.stdout),
      new StreamMessageWriter(this.process.stdin)
    );

    // Handle server-to-client requests
    this.connection.onRequest("client/registerCapability", () => {
      // Accept dynamic capability registrations (e.g., file watchers)
      return {};
    });

    this.connection.onRequest("client/unregisterCapability", () => {
      return {};
    });

    this.connection.onRequest("workspace/configuration", () => {
      // Return empty config for any workspace/configuration requests
      return [];
    });

    // Listen for push-based diagnostics
    this.connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: PublishDiagnosticsParams) => {
        this.diagnosticsCache.set(params.uri, params.diagnostics);
        const waiters = this.diagnosticsWaiters.get(params.uri);
        if (waiters) {
          for (const w of waiters) {
            clearTimeout(w.timer);
            w.resolve();
          }
          this.diagnosticsWaiters.delete(params.uri);
        }
      }
    );

    this.connection.listen();
    await this.initializeLsp();
  }

  private async initializeLsp(): Promise<void> {
    const projectRoot = this.projectRoot!;
    const rootUri = pathToFileURL(projectRoot).href;

    const initParams: InitializeParams = {
      processId: process.pid,
      rootUri,
      rootPath: projectRoot,
      capabilities: {
        textDocument: {
          hover: {
            contentFormat: ["markdown", "plaintext"],
          },
          definition: {
            linkSupport: true,
          },
          references: {},
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
          rename: {
            prepareSupport: true,
          },
          publishDiagnostics: {
            relatedInformation: true,
          },
          completion: {
            completionItem: {
              snippetSupport: false,
              documentationFormat: ["markdown", "plaintext"],
              resolveSupport: {
                properties: ["documentation", "detail"],
              },
            },
          },
          signatureHelp: {
            signatureInformation: {
              documentationFormat: ["markdown", "plaintext"],
              parameterInformation: {
                labelOffsetSupport: true,
              },
              activeParameterSupport: true,
            },
          },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: [
                  "quickfix",
                  "refactor",
                  "refactor.extract",
                  "refactor.inline",
                  "refactor.rewrite",
                  "source",
                  "source.organizeImports",
                  "source.fixAll",
                ],
              },
            },
            dataSupport: true,
            resolveSupport: {
              properties: ["edit"],
            },
          },
          formatting: {},
          rangeFormatting: {},
          callHierarchy: {
            dynamicRegistration: false,
          },
          implementation: {},
          typeDefinition: {},
        },
        workspace: {
          symbol: {},
          workspaceFolders: true,
          didChangeWatchedFiles: {
            dynamicRegistration: true,
          },
        },
      },
      workspaceFolders: [
        {
          uri: rootUri,
          name: basename(projectRoot),
        },
      ],
      initializationOptions: {
        configuration: {
          svelte: {
            plugin: {
              svelte: { diagnostics: { enable: true } },
              css: { diagnostics: { enable: true } },
              typescript: { diagnostics: { enable: true } },
              html: { completions: { enable: true } },
            },
          },
        },
      },
    };

    const result = await this.request<InitializeResult>(
      "initialize",
      initParams,
      30000
    );
    this.serverCapabilities = result.capabilities;
    console.error("[svelteserver] initialized");

    await this.notify("initialized", {});
    console.error("[svelteserver] ready");
  }

  async request<T = any>(
    method: string,
    params: any,
    timeoutOverride?: number
  ): Promise<T> {
    this.requireProject();

    const timeout = timeoutOverride ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const cancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => {
          const handler = () => {
            listener();
          };
          controller.signal.addEventListener("abort", handler);
          return { dispose: () => controller.signal.removeEventListener("abort", handler) };
        },
      };

      // If aborted, mark as cancelled
      controller.signal.addEventListener("abort", () => {
        (cancellationToken as any).isCancellationRequested = true;
      });

      return await this.connection!.sendRequest(
        method,
        params,
        cancellationToken as any
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(method: string, params: any): Promise<void> {
    this.requireProject();
    await this.connection!.sendNotification(method, params);
  }

  async ensureDocumentOpen(filePath: string): Promise<string> {
    const uri = pathToUri(filePath);
    if (this.openDocuments.has(uri)) return uri;

    const text = await readFile(filePath, "utf-8");
    const languageId = getLanguageId(filePath);

    const params: DidOpenTextDocumentParams = {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text,
      },
    };

    await this.notify("textDocument/didOpen", params);
    this.openDocuments.add(uri);
    return uri;
  }

  async closeDocument(uri: string): Promise<void> {
    if (!this.openDocuments.has(uri)) return;

    const params: DidCloseTextDocumentParams = {
      textDocument: { uri },
    };

    await this.notify("textDocument/didClose", params);
    this.openDocuments.delete(uri);
  }

  markDocumentClosed(uri: string): void {
    this.openDocuments.delete(uri);
  }

  // -- Diagnostics --

  getCachedDiagnostics(uri: string): Diagnostic[] {
    return this.diagnosticsCache.get(uri) ?? [];
  }

  async waitForDiagnostics(
    uri: string,
    waitMs: number = 5000
  ): Promise<Diagnostic[]> {
    // If we already have diagnostics, return them
    const existing = this.diagnosticsCache.get(uri);
    if (existing && existing.length > 0) return existing;

    // Wait for push notification
    return new Promise<Diagnostic[]>((resolve) => {
      const timer = setTimeout(() => {
        // Remove this waiter
        const waiters = this.diagnosticsWaiters.get(uri);
        if (waiters) {
          const idx = waiters.findIndex((w) => w.timer === timer);
          if (idx >= 0) waiters.splice(idx, 1);
          if (waiters.length === 0) this.diagnosticsWaiters.delete(uri);
        }
        resolve(this.diagnosticsCache.get(uri) ?? []);
      }, waitMs);

      const waiter = {
        resolve: () => resolve(this.diagnosticsCache.get(uri) ?? []),
        timer,
      };

      if (!this.diagnosticsWaiters.has(uri)) {
        this.diagnosticsWaiters.set(uri, []);
      }
      this.diagnosticsWaiters.get(uri)!.push(waiter);
    });
  }

  // -- Symbol Resolution --

  async findSymbolPosition(
    filePath: string,
    symbolName: string,
    symbolKind?: string
  ): Promise<{ line: number; character: number } | null> {
    await this.ensureDocumentOpen(filePath);
    const uri = pathToUri(filePath);

    // 1. Try documentSymbol
    try {
      const params: DocumentSymbolParams = {
        textDocument: { uri },
      };
      const result = await this.request("textDocument/documentSymbol", params);
      if (Array.isArray(result)) {
        const found = searchSymbolTree(result, symbolName, symbolKind);
        if (found) return found;
      }
    } catch {
      // continue to fallback
    }

    // 2. Try workspace/symbol
    try {
      const wsResult = await this.request("workspace/symbol", {
        query: symbolName,
      });
      if (Array.isArray(wsResult)) {
        for (const sym of wsResult) {
          if (sym.name !== symbolName) continue;
          const loc = sym.location;
          if (!loc?.uri || normalizeUri(loc.uri) !== normalizeUri(uri))
            continue;
          if (symbolKind && !matchesKind(sym.kind, symbolKind)) continue;
          return {
            line: loc.range.start.line,
            character: loc.range.start.character,
          };
        }
      }
    } catch {
      // continue to fallback
    }

    // 3. Text search fallback
    return await findSymbolViaTextSearch(filePath, symbolName);
  }

  async findAllSymbolPositions(
    filePath: string,
    symbolName: string,
    symbolKind?: string
  ): Promise<
    Array<{ line: number; character: number; name: string; kind: number }>
  > {
    await this.ensureDocumentOpen(filePath);
    const uri = pathToUri(filePath);

    try {
      const result = await this.request("textDocument/documentSymbol", {
        textDocument: { uri },
      });
      if (Array.isArray(result)) {
        const matches: Array<{
          line: number;
          character: number;
          name: string;
          kind: number;
        }> = [];
        collectMatchingSymbols(result, symbolName, symbolKind, matches);
        return matches;
      }
    } catch {
      // empty
    }

    return [];
  }

  // -- Lifecycle --

  async loadProject(projectRoot: string): Promise<void> {
    console.error(`[svelteserver] loading project: ${projectRoot}`);
    if (this.connection) {
      await this.stop();
    }
    this.projectRoot = projectRoot;
    this.openDocuments.clear();
    this.diagnosticsCache.clear();
    await this.start();
    console.error(`[svelteserver] project loaded: ${projectRoot}`);
  }

  async restart(): Promise<void> {
    console.error("[svelteserver] restarting...");
    await this.stop();
    this.openDocuments.clear();
    this.diagnosticsCache.clear();
    await this.start();
    console.error("[svelteserver] restarted");
  }

  async stop(): Promise<void> {
    if (this.connection) {
      try {
        await this.request("shutdown", null, 5000);
        await this.notify("exit", null);
      } catch {
        // best effort
      }
      this.connection.dispose();
      this.connection = null;
    }

    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
  }
}

// -- Utility functions --

export function pathToUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}

export function uriToPath(uri: string): string {
  return fileURLToPath(uri);
}

export function getLanguageId(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".svelte":
      return "svelte";
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".html":
      return "html";
    case ".css":
      return "css";
    case ".scss":
      return "scss";
    case ".less":
      return "less";
    case ".json":
      return "json";
    default:
      return "plaintext";
  }
}

export function symbolKindName(kind: number): string {
  const names: Record<number, string> = {
    1: "File",
    2: "Module",
    3: "Namespace",
    4: "Package",
    5: "Class",
    6: "Method",
    7: "Property",
    8: "Field",
    9: "Constructor",
    10: "Enum",
    11: "Interface",
    12: "Function",
    13: "Variable",
    14: "Constant",
    15: "String",
    16: "Number",
    17: "Boolean",
    18: "Array",
    19: "Object",
    20: "Key",
    21: "Null",
    22: "EnumMember",
    23: "Struct",
    24: "Event",
    25: "Operator",
    26: "TypeParameter",
  };
  return names[kind] ?? `Unknown(${kind})`;
}

export function completionItemKindName(kind: number): string {
  const names: Record<number, string> = {
    1: "Text",
    2: "Method",
    3: "Function",
    4: "Constructor",
    5: "Field",
    6: "Variable",
    7: "Class",
    8: "Interface",
    9: "Module",
    10: "Property",
    11: "Unit",
    12: "Value",
    13: "Enum",
    14: "Keyword",
    15: "Snippet",
    16: "Color",
    17: "File",
    18: "Reference",
    19: "Folder",
    20: "EnumMember",
    21: "Constant",
    22: "Struct",
    23: "Event",
    24: "Operator",
    25: "TypeParameter",
  };
  return names[kind] ?? `Unknown(${kind})`;
}

function matchesKind(lspKind: number, kindStr: string): boolean {
  const expected: Record<string, number> = {
    file: 1,
    module: 2,
    namespace: 3,
    package: 4,
    class: 5,
    method: 6,
    property: 7,
    field: 8,
    constructor: 9,
    enum: 10,
    interface: 11,
    function: 12,
    variable: 13,
    constant: 14,
    string: 15,
    number: 16,
    boolean: 17,
    array: 18,
    object: 19,
    key: 20,
    null: 21,
    enummember: 22,
    struct: 23,
    event: 24,
    operator: 25,
    typeparameter: 26,
  };
  return expected[kindStr.toLowerCase()] === lspKind;
}

function normalizeUri(uri: string): string {
  // Normalize drive letter case for Windows
  return uri.replace(/^file:\/\/\/([A-Z]):/, (_, d) => `file:///${d.toLowerCase()}:`);
}

function searchSymbolTree(
  symbols: any[],
  name: string,
  kind?: string
): { line: number; character: number } | null {
  for (const sym of symbols) {
    if (sym.name === name) {
      if (kind && !matchesKind(sym.kind, kind)) {
        // check children before giving up
      } else {
        const range = sym.selectionRange ?? sym.range;
        if (range?.start) {
          return { line: range.start.line, character: range.start.character };
        }
      }
    }

    if (sym.children) {
      const found = searchSymbolTree(sym.children, name, kind);
      if (found) return found;
    }
  }
  return null;
}

function collectMatchingSymbols(
  symbols: any[],
  name: string,
  kind: string | undefined,
  matches: Array<{ line: number; character: number; name: string; kind: number }>
): void {
  for (const sym of symbols) {
    if (sym.name === name) {
      if (!kind || matchesKind(sym.kind, kind)) {
        const range = sym.selectionRange ?? sym.range;
        if (range?.start) {
          matches.push({
            line: range.start.line,
            character: range.start.character,
            name: sym.name,
            kind: sym.kind,
          });
        }
      }
    }
    if (sym.children) {
      collectMatchingSymbols(sym.children, name, kind, matches);
    }
  }
}

async function findSymbolViaTextSearch(
  filePath: string,
  symbolName: string
): Promise<{ line: number; character: number } | null> {
  if (!existsSync(filePath)) return null;

  const text = await readFile(filePath, "utf-8");
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const col = lines[i].indexOf(symbolName);
    if (col < 0) continue;

    // Whole word match
    if (col > 0 && isIdentifierChar(lines[i][col - 1])) continue;
    const end = col + symbolName.length;
    if (end < lines[i].length && isIdentifierChar(lines[i][end])) continue;

    return { line: i, character: col };
  }

  return null;
}

function isIdentifierChar(c: string): boolean {
  return /[\w$]/.test(c);
}

/**
 * Resolve the path to the svelteserver entry script.
 * Uses the locally installed svelte-language-server package.
 */
function resolveSvelteServer(): string {
  // Allow env override
  const envPath = process.env["SVELTELS_SERVER_PATH"];
  if (envPath && existsSync(envPath)) return envPath;

  // Use the local node_modules package
  const localPath = new URL(
    "../node_modules/svelte-language-server/bin/server.js",
    import.meta.url
  );
  const resolved = fileURLToPath(localPath);
  if (existsSync(resolved)) return resolved;

  throw new Error(
    "Could not find svelte-language-server. Run: npm install\n" +
      "Or set SVELTELS_SERVER_PATH environment variable."
  );
}
