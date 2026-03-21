import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
  renderTemplate,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_BASE_URL } from "./models.js";

const MAX_FILE_READ_BYTES = 100 * 1024; // 100 KB
const DEFAULT_MAX_TURNS = 30;
const TOOL_CALL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Ollama OpenAI-compatible API types
// ---------------------------------------------------------------------------

interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OllamaToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OllamaToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

interface OllamaChatResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: OllamaToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
  };
  model?: string;
}

// ---------------------------------------------------------------------------
// Built-in tool definitions
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS: OllamaToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command and return its stdout/stderr output. Use for running scripts, git commands, tests, builds, and any other shell operations.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the text content of a file. Returns up to 100KB of content. Use for reading source files, configuration, documentation, etc.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the file to read.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write text content to a file. Creates parent directories as needed. Overwrites existing files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the file to write.",
          },
          content: {
            type: "string",
            description: "The text content to write to the file.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List the files and directories in a directory. Returns one entry per line.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the directory to list.",
          },
        },
        required: ["path"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function executeBash(
  command: string,
  cwd: string,
  env: Record<string, string>,
): string {
  try {
    const result = spawnSync(command, {
      shell: true,
      cwd,
      env: { ...process.env, ...env },
      timeout: TOOL_CALL_TIMEOUT_MS,
      maxBuffer: MAX_FILE_READ_BYTES * 2,
      encoding: "utf8",
    });

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";

    if (result.error) {
      const msg = result.error.message ?? String(result.error);
      return stderr
        ? `Error: ${msg}\nstderr: ${stderr}`
        : `Error: ${msg}`;
    }

    if (result.status !== 0) {
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      return combined
        ? `Exit code ${result.status ?? "unknown"}\n${combined}`
        : `Exit code ${result.status ?? "unknown"}`;
    }

    return stdout || "(no output)";
  } catch (err) {
    return `Error executing bash command: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function executeReadFile(filePath: string, cwd: string): string {
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const stats = fs.statSync(resolved);
    if (!stats.isFile()) {
      return `Error: "${resolved}" is not a file.`;
    }
    const buffer = Buffer.alloc(MAX_FILE_READ_BYTES);
    const fd = fs.openSync(resolved, "r");
    let bytesRead: number;
    try {
      bytesRead = fs.readSync(fd, buffer, 0, MAX_FILE_READ_BYTES, 0);
    } finally {
      fs.closeSync(fd);
    }
    const content = buffer.slice(0, bytesRead).toString("utf8");
    if (bytesRead === MAX_FILE_READ_BYTES && stats.size > MAX_FILE_READ_BYTES) {
      return content + `\n\n[... truncated — file is ${stats.size} bytes, showing first ${MAX_FILE_READ_BYTES} bytes]`;
    }
    return content;
  } catch (err) {
    return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function executeWriteFile(filePath: string, content: string, cwd: string): string {
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    return `File written: ${resolved}`;
  } catch (err) {
    return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function executeListFiles(dirPath: string, cwd: string): string {
  try {
    const resolved = path.isAbsolute(dirPath) ? dirPath : path.resolve(cwd, dirPath);
    const entries = fs.readdirSync(resolved);
    if (entries.length === 0) return "(empty directory)";
    return entries.join("\n");
  } catch (err) {
    return `Error listing files: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function dispatchTool(
  name: string,
  argumentsRaw: string,
  cwd: string,
  env: Record<string, string>,
): string {
  const args = parseToolArguments(argumentsRaw);

  switch (name) {
    case "bash": {
      const command = typeof args.command === "string" ? args.command : "";
      if (!command.trim()) return "Error: bash tool requires a non-empty `command` argument.";
      return executeBash(command, cwd, env);
    }
    case "read_file": {
      const filePath = typeof args.path === "string" ? args.path : "";
      if (!filePath.trim()) return "Error: read_file tool requires a non-empty `path` argument.";
      return executeReadFile(filePath, cwd);
    }
    case "write_file": {
      const filePath = typeof args.path === "string" ? args.path : "";
      const content = typeof args.content === "string" ? args.content : "";
      if (!filePath.trim()) return "Error: write_file tool requires a non-empty `path` argument.";
      return executeWriteFile(filePath, content, cwd);
    }
    case "list_files": {
      const dirPath = typeof args.path === "string" ? args.path : ".";
      return executeListFiles(dirPath, cwd);
    }
    default:
      return `Error: unknown tool "${name}".`;
  }
}

// ---------------------------------------------------------------------------
// Ollama API call
// ---------------------------------------------------------------------------

const TOOLS_NOT_SUPPORTED_RE = /does not support tools/i;

function isToolsNotSupportedError(message: string): boolean {
  return TOOLS_NOT_SUPPORTED_RE.test(message);
}

async function callOllamaChatCompletions(
  baseUrl: string,
  model: string,
  messages: OllamaChatMessage[],
  tools: OllamaToolDefinition[],
  timeoutMs: number,
): Promise<OllamaChatResponse> {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const controller = new AbortController();
  const timeoutId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Ollama API returned HTTP ${response.status}: ${text.slice(0, 400)}`);
    }

    const body: unknown = await response.json();
    return body as OllamaChatResponse;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// System prompt construction
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI agent running inside Paperclip.
You have access to tools for executing shell commands and working with files.
Complete the task given by the user step by step, using tools as needed.
When you have finished and have nothing more to do, respond with a clear summary of what you accomplished.`;

async function buildSystemPrompt(
  config: Record<string, unknown>,
  cwd: string,
  templateData: Record<string, unknown>,
  onLog: AdapterExecutionContext["onLog"],
): Promise<string> {
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();

  if (!instructionsFilePath) {
    const promptTemplate = asString(config.promptTemplate, "");
    return promptTemplate.trim()
      ? renderTemplate(promptTemplate, templateData)
      : DEFAULT_SYSTEM_PROMPT;
  }

  const resolved = path.isAbsolute(instructionsFilePath)
    ? instructionsFilePath
    : path.resolve(cwd, instructionsFilePath);

  try {
    const contents = fs.readFileSync(resolved, "utf8");
    const instructionsDir = `${path.dirname(resolved)}/`;
    const base = [
      contents,
      `The above agent instructions were loaded from ${resolved}.`,
      `Resolve any relative file references from ${instructionsDir}.`,
    ].join("\n\n");
    await onLog("stdout", `[paperclip] Loaded agent instructions file: ${resolved}\n`);
    return base;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await onLog(
      "stdout",
      `[paperclip] Warning: could not read agent instructions file "${resolved}": ${reason}\n`,
    );
    return DEFAULT_SYSTEM_PROMPT;
  }
}

// ---------------------------------------------------------------------------
// Main execute function
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;

  const baseUrl = asString(config.baseUrl, DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = asString(config.model, "").trim();
  const configuredCwd = asString(config.cwd, "").trim();
  const maxTurns = asNumber(config.maxTurns, DEFAULT_MAX_TURNS);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const overallTimeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 0;
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );

  const envConfig = parseObject(config.env);
  const toolEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") toolEnv[key] = value;
  }

  const cwd = configuredCwd || process.cwd();

  const templateData: Record<string, unknown> = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  // Build system prompt
  const systemPrompt = await buildSystemPrompt(config, cwd, templateData, onLog);

  // Build user prompt
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const renderedHeartbeatPrompt = renderTemplate(promptTemplate, templateData);
  const userPrompt = joinPromptSections([sessionHandoffNote, renderedHeartbeatPrompt]);

  // Call onMeta
  if (onMeta) {
    await onMeta({
      adapterType: "ollama_local",
      command: `${baseUrl}/v1/chat/completions`,
      cwd,
      commandNotes: [`Model: ${model}`, `Max turns: ${maxTurns}`],
      prompt: userPrompt,
      promptMetrics: {
        systemPromptChars: systemPrompt.length,
        promptChars: userPrompt.length,
      },
      context,
    });
  }

  if (!model) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "ollama_local requires adapterConfig.model to be set.",
    };
  }

  const startedAt = Date.now();

  function isTimedOut(): boolean {
    return overallTimeoutMs > 0 && Date.now() - startedAt >= overallTimeoutMs;
  }

  // Build initial message history
  const messages: OllamaChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalAssistantMessage: string | null = null;
  let turn = 0;
  // Start with tools enabled; disable permanently if model reports no tool support
  let toolsEnabled = true;

  // Per-request timeout: use remaining time from overall timeout, or a generous per-call cap
  function resolveRequestTimeoutMs(): number {
    if (overallTimeoutMs <= 0) return 300_000; // 5 min default per request
    const elapsed = Date.now() - startedAt;
    const remaining = overallTimeoutMs - elapsed;
    return Math.max(5_000, remaining);
  }

  try {
    while (turn < maxTurns) {
      if (isTimedOut()) {
        return {
          exitCode: null,
          signal: null,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
          model,
          provider: "ollama",
          biller: "ollama",
          billingType: "unknown",
          summary: finalAssistantMessage,
        };
      }

      turn++;
      await onLog("stdout", `[paperclip] Ollama turn ${turn}/${maxTurns}${toolsEnabled ? "" : " (no-tools mode)"}\n`);

      let response: OllamaChatResponse;
      try {
        response = await callOllamaChatCompletions(
          baseUrl,
          model,
          messages,
          toolsEnabled ? TOOL_DEFINITIONS : [],
          resolveRequestTimeoutMs(),
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        // If model doesn't support tools, retry this turn without them
        if (toolsEnabled && isToolsNotSupportedError(errorMessage)) {
          await onLog(
            "stdout",
            `[paperclip] Model does not support tool calling — switching to no-tools mode.\n`,
          );
          toolsEnabled = false;
          turn--; // don't count this as a turn
          continue;
        }

        await onLog("stderr", `[paperclip] Ollama API error: ${errorMessage}\n`);
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `Ollama API error: ${errorMessage}`,
          usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
          model,
          provider: "ollama",
          biller: "ollama",
          billingType: "unknown",
          summary: finalAssistantMessage,
        };
      }

      // Accumulate token usage
      if (response.usage) {
        totalInputTokens += response.usage.prompt_tokens ?? 0;
        totalOutputTokens += response.usage.completion_tokens ?? 0;
      }

      const choice = response.choices?.[0];
      if (!choice) {
        await onLog("stderr", "[paperclip] Ollama returned no choices.\n");
        break;
      }

      const assistantMessage = choice.message;
      const assistantContent = assistantMessage.content ?? null;
      const toolCalls = assistantMessage.tool_calls ?? [];

      // Append assistant message to history
      messages.push({
        role: "assistant",
        content: assistantContent,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });

      // Track last non-null assistant text for summary
      if (assistantContent && assistantContent.trim()) {
        finalAssistantMessage = assistantContent;
      }

      if (toolCalls.length === 0) {
        // No tool calls — agent is done
        break;
      }

      // Execute each tool call
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function?.name ?? "unknown";
        const toolArgs = toolCall.function?.arguments ?? "{}";
        const toolCallId = toolCall.id;

        await onLog(
          "stdout",
          `[paperclip] Tool call: ${toolName}(${toolArgs.slice(0, 120)}${toolArgs.length > 120 ? "..." : ""})\n`,
        );

        const toolResult = dispatchTool(toolName, toolArgs, cwd, toolEnv);

        const resultPreview =
          toolResult.length > 200
            ? toolResult.slice(0, 200) + `... (${toolResult.length} chars total)`
            : toolResult;
        await onLog("stdout", `[paperclip] Tool result: ${resultPreview}\n`);

        messages.push({
          role: "tool",
          content: toolResult,
          tool_call_id: toolCallId,
          name: toolName,
        });
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage,
      usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      model,
      provider: "ollama",
      biller: "ollama",
      billingType: "unknown",
      summary: finalAssistantMessage,
    };
  }

  if (isTimedOut()) {
    return {
      exitCode: null,
      signal: null,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      model,
      provider: "ollama",
      biller: "ollama",
      billingType: "unknown",
      summary: finalAssistantMessage,
    };
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    model,
    provider: "ollama",
    biller: "ollama",
    billingType: "unknown",
    summary: finalAssistantMessage,
    resultJson: {
      turns: turn,
      maxTurns,
    },
  };
}
