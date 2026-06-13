import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Successful native-tool result: JSON payload rendered as text. */
export function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 1) }] };
}

/** Error result with a message the model can act on. */
export function fail(code: string, message: string): CallToolResult {
  return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
}

/** First line of a tool result's text content, for the audit detail column. */
export function firstText(result: CallToolResult): string | undefined {
  const block = result.content?.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.split("\n")[0]?.slice(0, 200) : undefined;
}
