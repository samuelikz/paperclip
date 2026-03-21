export const type = "ollama_local";
export const label = "Ollama (local)";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Use when:
- You want Paperclip to run an agent loop against a locally running Ollama instance
- You want to use open-weight models (llama3.2, codellama, qwen2.5-coder, etc.) without cloud costs
- You need a fully local, privacy-preserving agent runtime with tool-calling support
- Ollama is already installed and running on the machine (default: http://localhost:11434)

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- You need session resumption across heartbeats (this adapter is stateless per run)
- Ollama is not installed or the configured model is not pulled

Core fields:
- baseUrl (string, optional): Ollama server URL. Defaults to http://localhost:11434. Override if Ollama is running on a different host or port.
- model (string, required): Ollama model name to use (e.g. llama3.2, codellama, qwen2.5-coder:7b, mistral). Run \`ollama list\` to see available models.
- cwd (string, optional): Default working directory for tool execution. Created if missing. Defaults to process.cwd().
- promptTemplate (string, optional): Handlebars-style template for the user prompt. Supports {{agent.id}}, {{agent.name}}, {{runId}}, {{context.*}} etc.
- instructionsFilePath (string, optional): Absolute or cwd-relative path to a markdown file appended to the system prompt as agent instructions.
- maxTurns (number, optional): Maximum number of tool-calling turns before the loop halts. Defaults to 30.
- timeoutSec (number, optional): Overall execution timeout in seconds. 0 means no timeout.
- env (object, optional): Additional KEY=VALUE environment variables injected into tool execution subprocesses.

Notes:
- Models are discovered dynamically via GET {baseUrl}/api/tags. Use listModels to enumerate available options.
- The agent loop uses Ollama's OpenAI-compatible endpoint (POST {baseUrl}/v1/chat/completions).
- Tool execution runs directly in the Paperclip server process (no subprocess spawned for the agent itself).
- Built-in tools: bash (shell commands), read_file, write_file, list_files.
- Token usage is tracked from the Ollama API response and reported for budget accounting.
- The adapter does not maintain sessions between runs; each run starts a fresh conversation.
`;
