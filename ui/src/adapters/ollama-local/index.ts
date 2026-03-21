import type { UIAdapterModule, TranscriptEntry } from "../types";
import { OllamaLocalConfigFields } from "./config-fields";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function parseOllamaStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (!line.trim()) return [];
  return [{ kind: "stdout", ts, text: line }];
}

function buildOllamaLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.baseUrl = v.url;
  if (v.cwd) ac.cwd = v.cwd;
  if (v.model) ac.model = v.model;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  return ac;
}

export const ollamaLocalUIAdapter: UIAdapterModule = {
  type: "ollama_local",
  label: "Ollama (local)",
  parseStdoutLine: parseOllamaStdoutLine,
  ConfigFields: OllamaLocalConfigFields,
  buildAdapterConfig: buildOllamaLocalConfig,
};
