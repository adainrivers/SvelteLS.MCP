import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  LspClient,
  pathToUri,
  uriToPath,
  symbolKindName,
} from "./lsp-client.js";

export interface SymbolContext {
  uri: string;
  line: number;
  character: number;
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export async function prepareSymbolRequest(
  lsp: LspClient,
  filePath: string,
  symbolName: string,
  symbolKind?: string | null
): Promise<{ ctx: SymbolContext } | { error: string }> {
  const pos = await lsp.findSymbolPosition(
    filePath,
    symbolName,
    symbolKind ?? undefined
  );
  if (!pos) return { error: `Symbol '${symbolName}' not found in ${filePath}` };

  await lsp.ensureDocumentOpen(filePath);
  const uri = pathToUri(filePath);
  return { ctx: { uri, line: pos.line, character: pos.character } };
}

export async function prepareDocumentRequest(
  lsp: LspClient,
  filePath: string
): Promise<{ uri: string } | { error: string }> {
  try {
    const uri = await lsp.ensureDocumentOpen(filePath);
    return { uri };
  } catch (e: any) {
    return { error: `Failed to open ${filePath}: ${e.message}` };
  }
}

export function makePositionParams(ctx: SymbolContext): any {
  return {
    textDocument: { uri: ctx.uri },
    position: { line: ctx.line, character: ctx.character },
  };
}

// -- Response formatting --

export function formatLocations(
  result: any,
  label: string,
  filter?: string | null,
  limit?: number
): string {
  if (!result) return `No ${label} found.`;

  const locations: Array<{ path: string; line: number; col: number }> = [];

  if (Array.isArray(result)) {
    for (const item of result) extractLocation(item, locations);
  } else {
    extractLocation(result, locations);
  }

  if (locations.length === 0) return `No ${label} found.`;

  const filterRegex = filter ? new RegExp(filter, "i") : null;
  const lines: string[] = [];
  let shown = 0;
  let matched = 0;
  const total = locations.length;
  const fileLineCache = new Map<string, string[]>();

  for (const loc of locations) {
    const symbolName = extractSymbolNameFromFile(
      loc.path,
      loc.line,
      fileLineCache
    );
    const matchTarget = symbolName ?? loc.path;
    if (filterRegex && !filterRegex.test(matchTarget)) continue;
    matched++;
    if (limit && limit > 0 && shown >= limit) continue;

    if (symbolName) {
      lines.push(`  ${symbolName} - ${loc.path}:${loc.line}`);
    } else {
      lines.push(`  ${loc.path}:${loc.line}:${loc.col}`);
    }
    shown++;
  }

  if (shown === 0)
    return (
      `No ${label} found` + (filter ? ` matching '${filter}'.` : ".")
    );

  const header = formatFilteredHeader(
    "Found ",
    shown,
    matched,
    total,
    filter ?? undefined
  );
  return header + "\n\n" + lines.join("\n");
}

export function formatFilteredHeader(
  prefix: string,
  shown: number,
  matched: number,
  total: number,
  filter?: string
): string {
  let result = prefix;
  if (filter) {
    result +=
      shown < matched
        ? `${shown} of ${matched} matching '${filter}'`
        : `${matched} matching '${filter}'`;
    result += `, ${total} total`;
  } else {
    result += shown < total ? `${shown} of ${total}` : `${total}`;
  }
  result += "):";
  return result;
}

export function formatSymbolTree(
  symbols: any[],
  indent: number = 0
): string {
  const lines: string[] = [];
  for (const sym of symbols) {
    const name = sym.name ?? "?";
    const kind = symbolKindName(sym.kind ?? 0);
    const range = sym.selectionRange ?? sym.range;
    const line = (range?.start?.line ?? 0) + 1;

    lines.push(`${"  ".repeat(indent)}${name} (${kind}) line ${line}`);

    if (sym.children) {
      lines.push(formatSymbolTree(sym.children, indent + 1));
    }
  }
  return lines.join("\n");
}

export function formatHierarchyItem(item: any): string {
  const name = item.name ?? "?";
  const kind = symbolKindName(item.kind ?? 0);
  const uri = item.uri;
  const path = uri ? uriToPath(uri) : "?";
  const range = item.selectionRange ?? item.range;
  const line = (range?.start?.line ?? 0) + 1;
  return `  ${name} (${kind}) - ${path}:${line}`;
}

export function formatError(ex: any): string {
  if (
    ex?.name === "AbortError" ||
    ex?.message?.includes("cancel") ||
    ex?.message?.includes("timeout")
  ) {
    return "Request timed out. The language server may still be loading. Try again in a moment.";
  }
  const msg = ex?.message ?? String(ex);
  return `Error: ${msg}`;
}

export function formatWorkspaceEdit(
  result: any,
  description: string
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
      let newText: string = edit.newText ?? "";
      if (newText.length > 60) newText = newText.substring(0, 57) + "...";
      newText = newText.replace(/\r/g, "").replace(/\n/g, "\\n");
      lines.push(`    line ${line}: ${newText}`);
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

  if (totalEdits === 0) return `${description}: no changes needed.`;

  return (
    `${description}: ${totalEdits} edit(s) across ${fileCount} file(s):\n\n` +
    lines.join("\n")
  );
}

// -- Workspace edit application --

export async function applyWorkspaceEdit(
  lsp: LspClient,
  result: any
): Promise<boolean> {
  const fileEdits = new Map<
    string,
    Array<{
      startLine: number;
      startChar: number;
      endLine: number;
      endChar: number;
      newText: string;
    }>
  >();

  function collectEdits(uri: string, edits: any[]): void {
    const path = uriToPath(uri);
    if (!fileEdits.has(path)) fileEdits.set(path, []);
    const list = fileEdits.get(path)!;

    for (const edit of edits) {
      const range = edit.range;
      if (!range) continue;
      list.push({
        startLine: range.start.line,
        startChar: range.start.character,
        endLine: range.end.line,
        endChar: range.end.character,
        newText: edit.newText ?? "",
      });
    }
  }

  if (result.documentChanges) {
    for (const dc of result.documentChanges) {
      const uri = dc.textDocument?.uri;
      if (uri && dc.edits) collectEdits(uri, dc.edits);
    }
  }

  if (result.changes) {
    for (const [uri, edits] of Object.entries(result.changes)) {
      if (Array.isArray(edits)) collectEdits(uri, edits);
    }
  }

  if (fileEdits.size === 0) return false;

  for (const [path, edits] of fileEdits) {
    let text = await readFile(path, "utf-8");
    let lines = text.split("\n");

    // Apply edits in reverse order to preserve offsets
    const sorted = [...edits].sort(
      (a, b) => b.startLine - a.startLine || b.startChar - a.startChar
    );

    for (const edit of sorted) {
      const startOffset = getOffset(lines, edit.startLine, edit.startChar);
      const endOffset = getOffset(lines, edit.endLine, edit.endChar);
      text =
        text.substring(0, startOffset) + edit.newText + text.substring(endOffset);
      lines = text.split("\n");
    }

    await writeFile(path, text, "utf-8");

    const uri = pathToUri(path);
    await lsp.closeDocument(uri);
  }

  return true;
}

export async function applyTextEdits(
  lsp: LspClient,
  filePath: string,
  edits: any[]
): Promise<number> {
  if (edits.length === 0) return 0;

  let text = await readFile(filePath, "utf-8");
  let lines = text.split("\n");
  let count = 0;

  const editList: Array<{
    sl: number;
    sc: number;
    el: number;
    ec: number;
    newText: string;
  }> = [];

  for (const edit of edits) {
    const range = edit.range;
    if (!range) continue;
    editList.push({
      sl: range.start.line,
      sc: range.start.character,
      el: range.end.line,
      ec: range.end.character,
      newText: edit.newText ?? "",
    });
    count++;
  }

  const sorted = [...editList].sort(
    (a, b) => b.sl - a.sl || b.sc - a.sc
  );

  for (const edit of sorted) {
    const startOffset = getOffset(lines, edit.sl, edit.sc);
    const endOffset = getOffset(lines, edit.el, edit.ec);
    text =
      text.substring(0, startOffset) + edit.newText + text.substring(endOffset);
    lines = text.split("\n");
  }

  await writeFile(filePath, text, "utf-8");

  const uri = pathToUri(filePath);
  await lsp.closeDocument(uri);

  return count;
}

function getOffset(lines: string[], line: number, character: number): number {
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for \n
  }
  return offset + character;
}

// -- Location extraction helpers --

function extractLocation(
  item: any,
  locations: Array<{ path: string; line: number; col: number }>
): void {
  if (item.uri && item.range) {
    const path = uriToPath(item.uri);
    const line = (item.range.start?.line ?? 0) + 1;
    const col = (item.range.start?.character ?? 0) + 1;
    locations.push({ path, line, col });
  } else if (item.targetUri && item.targetRange) {
    const path = uriToPath(item.targetUri);
    const line = (item.targetRange.start?.line ?? 0) + 1;
    const col = (item.targetRange.start?.character ?? 0) + 1;
    locations.push({ path, line, col });
  }
}

function extractSymbolNameFromFile(
  path: string,
  line: number,
  cache: Map<string, string[]>
): string | null {
  try {
    if (!existsSync(path)) return null;
    let lines = cache.get(path);
    if (!lines) {
      // Synchronous read for simplicity in formatting
      lines = readFileSync(path, "utf-8").split("\n");
      cache.set(path, lines);
    }

    if (line - 1 < 0 || line - 1 >= lines.length) return null;
    const lineText = lines[line - 1].trim();

    // Svelte/TS/JS patterns
    let match = lineText.match(
      /(?:class|interface|enum|type|function)\s+(\w+)/
    );
    if (match) return match[1];

    match = lineText.match(
      /(?:export\s+)?(?:const|let|var|async\s+function)\s+(\w+)/
    );
    if (match) return match[1];

    return null;
  } catch {
    return null;
  }
}
