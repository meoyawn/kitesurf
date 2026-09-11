import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { z } from "zod";
import { createPageFactory } from "../src/browser-factory.ts";
import { createBrowserTools } from "../src/browser-tools.ts";
import { createMcpHarness } from "./mcp-harness-client.ts";

const commandSchema = z.discriminatedUnion("method", [
  z.object({ chat: z.string().min(1), method: z.literal("tools/call"), name: z.string(), arguments: z.record(z.unknown()).optional() }).strict(),
  z.object({ chat: z.string().min(1), method: z.literal("tools/list") }).strict(),
  z.object({ chat: z.string().min(1), method: z.literal("reconnect") }).strict(),
]);
const trace = process.argv.includes("--trace");
const module = new WebAssembly.Module(await readFile(new URL("../.wrangler/browser/kitesurf_browser_bg.wasm", import.meta.url)));
const harness = createMcpHarness(createBrowserTools(createPageFactory(module)), trace ? exchange => console.error(JSON.stringify({ http: exchange })) : undefined);
const chats = new Map<string, Awaited<ReturnType<typeof harness.connect>>>();
const lines = createInterface({ input: process.stdin });
try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const command = commandSchema.parse(JSON.parse(line));
      let chat = chats.get(command.chat);
      if (command.method === "reconnect") {
        await chat?.close();
        chats.delete(command.chat);
        chat = undefined;
      }
      if (!chat) { chat = await harness.connect(command.chat); chats.set(command.chat, chat); }
      const result = command.method === "tools/call" ? await chat.callTool({ name: command.name, arguments: command.arguments }) :
        command.method === "tools/list" ? await chat.listTools() : { reconnected: true };
      console.log(JSON.stringify({ chat: command.chat, result }));
      if ("isError" in result && result.isError) process.exitCode = 1;
    } catch (error) {
      console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      process.exitCode = 1;
    } finally {
      harness.exchanges.length = 0;
    }
  }
} finally { lines.close(); await harness.close(); }
