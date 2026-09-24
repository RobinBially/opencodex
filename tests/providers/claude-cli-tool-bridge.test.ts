import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { dirname } from "node:path";
import type { ChildProcess } from "node:child_process";
import { createClaudeCliAdapter, type SpawnFn } from "../../src/adapters/claude-cli/adapter";
import { CLAUDE_CLI_PROFILE, clearClaudeCliBinaryCache } from "../../src/adapters/claude-cli/profiles";
import { CODING_AGENT_MCP_SERVER_NAME, buildCodingAgentToolBridge } from "../../src/adapters/coding-agent/tool-bridge";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const enc = new TextEncoder();

beforeEach(() => clearClaudeCliBinaryCache());

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
}

function fakeChild(stdout: Uint8Array[]): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Readable.from(stdout);
  child.stderr = Readable.from([]);
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => { child.killed = true; return true; };
  setTimeout(() => { child.exitCode = 0; child.emit("close", 0); }, 3);
  return child;
}

function tool(name: string): OcxTool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: { path: { type: "string" } } },
  };
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "claude-cli",
    baseUrl: CLAUDE_CLI_PROFILE.canonicalBaseUrl,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    ...overrides,
  } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "claude-sonnet-5",
    stream: true,
    options: {},
    context: { messages: [{ role: "user", content: "read a file", timestamp: 0 }] },
    ...overrides,
  } as OcxParsedRequest;
}

async function run(adapter: ReturnType<typeof createClaudeCliAdapter>, p: OcxParsedRequest): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(p, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, e => events.push(e));
  return events;
}

function frameLines(frames: unknown[]): Uint8Array[] {
  return frames.map(frame => enc.encode(JSON.stringify(frame) + "\n"));
}

/**
 * The frame shapes Claude Code 2.1.281 emits for a capture-only turn: the bridge server is reported
 * as connected in `system/init`, the call renders as `mcp__<server>__<tool>`, and the process parks
 * on the never-answering handler after `message_stop` instead of delivering a `result` frame.
 */
const INIT_OK = { type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected", source: "dynamic" }] };
const INIT_NO_SERVER = { type: "system", subtype: "init", mcp_servers: [] };

function toolUseStart(name: string, id = "toolu_1"): unknown {
  return { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id, name } } };
}
function inputJsonDelta(part: string): unknown {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: part } } };
}
const BLOCK_STOP = { type: "stream_event", event: { type: "content_block_stop" } };
const MESSAGE_STOP = { type: "stream_event", event: { type: "message_stop" } };

describe("claude-cli capture-only tool bridge", () => {
  test("advertises an isolated MCP server, captures the call, renames it, and ends the leg at message_stop", async () => {
    const p = parsed({ context: { systemPrompt: ["Be terse."], messages: [{ role: "user", content: "read a file", timestamp: 0 }], tools: [tool("read_file")] } });
    const bridge = buildCodingAgentToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const wireName = bridge.emittedNameMap.get(cliName)!;
    expect(cliName.startsWith(`mcp__${CODING_AGENT_MCP_SERVER_NAME}__`)).toBe(true);

    let child: FakeChild | undefined;
    let seenArgs: readonly string[] = [];
    let mcpConfigPath = "";
    let mcpServer: { type: string; command: string; args: string[] } | undefined;
    let advertisedCatalog: Array<{ name: string }> = [];
    const spawn: SpawnFn = (_cmd, args) => {
      seenArgs = args;
      const index = args.indexOf("--mcp-config");
      if (index >= 0) mcpConfigPath = args[index + 1] ?? "";
      // The staging directory is private and removed once the turn settles, so the files are read
      // while the turn is still running.
      const config = JSON.parse(readFileSync(mcpConfigPath, "utf8")) as {
        mcpServers: Record<string, { type: string; command: string; args: string[] }>;
      };
      mcpServer = config.mcpServers[CODING_AGENT_MCP_SERVER_NAME];
      advertisedCatalog = JSON.parse(readFileSync(mcpServer!.args[1]!, "utf8")) as Array<{ name: string }>;
      child = fakeChild(frameLines([
        INIT_OK,
        toolUseStart(cliName),
        inputJsonDelta('{"path":'),
        inputJsonDelta('"README.md"}'),
        BLOCK_STOP,
        MESSAGE_STOP,
      ]));
      return child as unknown as ChildProcess;
    };
    const adapter = createClaudeCliAdapter(provider(), { spawn, which: () => "/opt/homebrew/bin/claude" });
    const events = await run(adapter, p);

    // Built-in tools stay off and no permission bypass is requested: the isolated catalog is the
    // only capability this turn can reach.
    expect(seenArgs[seenArgs.indexOf("--tools") + 1]).toBe("");
    expect(seenArgs).toContain("--strict-mcp-config");
    const allowedIndex = seenArgs.indexOf("--allowedTools");
    expect(seenArgs[allowedIndex + 1]).toBe(cliName);
    expect(mcpConfigPath).toContain("ocx-coding-agent-tools-");

    // The MCP config is the shape Claude Code accepts (verified against 2.1.281): a stdio server
    // running the shared capture module with the private catalog as its only argument.
    expect(mcpServer?.type).toBe("stdio");
    expect(mcpServer?.command).toBe(process.execPath);
    expect(mcpServer?.args[0]!.endsWith("src/adapters/coding-agent/mcp-server.ts")).toBe(true);
    expect(mcpServer?.args[1]!.endsWith("catalog.json")).toBe(true);
    // The catalog carries the bare alias; the harness renders it as `mcp__<server>__<alias>`.
    const prefix = `mcp__${CODING_AGENT_MCP_SERVER_NAME}__`;
    expect(advertisedCatalog.map(entry => entry.name))
      .toEqual([...bridge.emittedNameMap.keys()].map(name => name.slice(prefix.length)));

    expect(events.map(event => event.type)).toEqual([
      "tool_call_start",
      "tool_call_delta",
      "tool_call_delta",
      "tool_call_end",
      "done",
    ]);
    expect(events[0]).toMatchObject({ type: "tool_call_start", name: wireName });
    expect(events[4]).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
    expect(child?.killed).toBe(true);
    // Both private directories are gone once the turn settled.
    expect(existsSync(dirname(mcpConfigPath))).toBe(false);
  });

  test("stages the bridge directive with the caller's prompt, out of argv", async () => {
    const secret = "private-system-instruction";
    const p = parsed({ context: { systemPrompt: [secret], messages: [{ role: "user", content: "read a file", timestamp: 0 }], tools: [tool("read_file")] } });
    let staged = "";
    const spawn: SpawnFn = (_cmd, args) => {
      expect(args).not.toContain(secret);
      staged = readFileSync(args[args.indexOf("--system-prompt-file") + 1]!, "utf8");
      return fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess;
    };
    const adapter = createClaudeCliAdapter(provider(), { spawn, which: () => "/opt/homebrew/bin/claude", killGraceMs: 20 });
    await run(adapter, p);

    expect(staged).toContain(secret);
    expect(staged).toContain("That MCP process captures call intent only; it never executes a tool.");
  });

  test("a request without a catalog keeps the text-only arg shape and stages no directive", async () => {
    let seenArgs: readonly string[] = [];
    let staged = "";
    const spawn: SpawnFn = (_cmd, args) => {
      seenArgs = args;
      staged = readFileSync(args[args.indexOf("--system-prompt-file") + 1]!, "utf8");
      return fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess;
    };
    const adapter = createClaudeCliAdapter(provider(), { spawn, which: () => "/opt/homebrew/bin/claude", killGraceMs: 20 });
    const events = await run(adapter, parsed());

    expect(seenArgs).not.toContain("--mcp-config");
    expect(seenArgs).not.toContain("--allowedTools");
    expect(staged).toBe("");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("tool_choice none keeps the text-only arg shape", async () => {
    let seenArgs: readonly string[] = [];
    const spawn: SpawnFn = (_cmd, args) => {
      seenArgs = args;
      return fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess;
    };
    const adapter = createClaudeCliAdapter(provider(), { spawn, which: () => "/opt/homebrew/bin/claude", killGraceMs: 20 });
    await run(adapter, parsed({
      options: { toolChoice: "none" },
      context: { messages: [{ role: "user", content: "read a file", timestamp: 0 }], tools: [tool("read_file")] },
    }));
    expect(seenArgs).not.toContain("--mcp-config");
    expect(seenArgs).not.toContain("--allowedTools");
  });

  test("an invalid catalog fails closed as a request error before any spawn", async () => {
    let spawns = 0;
    const spawn: SpawnFn = () => { spawns++; return fakeChild([]) as unknown as ChildProcess; };
    const adapter = createClaudeCliAdapter(provider(), { spawn, which: () => "/opt/homebrew/bin/claude" });
    const events = await run(adapter, parsed({
      context: { messages: [{ role: "user", content: "go", timestamp: 0 }], tools: [tool("bad name")] },
    }));
    expect(spawns).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 400, code: "tool_catalog_invalid", retryable: false });
    expect(String((events[0] as { message: string }).message)).toContain("Invalid Claude Code tool catalog");
  });

  test("an init frame that does not report the capture server fails closed", async () => {
    const spawn: SpawnFn = () => fakeChild(frameLines([
      INIT_NO_SERVER,
      { type: "result", subtype: "success", is_error: false },
    ])) as unknown as ChildProcess;
    const adapter = createClaudeCliAdapter(provider(), { spawn, which: () => "/opt/homebrew/bin/claude", killGraceMs: 20 });
    const events = await run(adapter, parsed({
      context: { messages: [{ role: "user", content: "read a file", timestamp: 0 }], tools: [tool("read_file")] },
    }));
    expect(events[0]).toMatchObject({ type: "error", code: "tool_bridge_init_mismatch", retryable: false });
  });
});
