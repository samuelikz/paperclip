import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { listOllamaModels, DEFAULT_BASE_URL } from "./models.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const baseUrl = asString(config.baseUrl, DEFAULT_BASE_URL).replace(/\/$/, "");
  const configuredModel = asString(config.model, "").trim();

  // Check 1: Reachability — GET /api/tags with a 5s timeout
  let discoveredModels: Array<{ id: string; label: string }> = [];
  let reachable = false;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5_000);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      checks.push({
        code: "ollama_unreachable",
        level: "error",
        message: `Ollama server at ${baseUrl} returned HTTP ${response.status}.`,
        hint: `Verify Ollama is running at ${baseUrl}. Run \`ollama serve\` to start it.`,
      });
    } else {
      reachable = true;
      checks.push({
        code: "ollama_reachable",
        level: "info",
        message: `Ollama server is reachable at ${baseUrl}.`,
      });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "ollama_unreachable",
      level: "error",
      message: `Could not reach Ollama server at ${baseUrl}.`,
      detail,
      hint: `Ensure Ollama is installed and running. Run \`ollama serve\` or check http://localhost:11434.`,
    });
  }

  // Check 2: Model discovery
  if (reachable) {
    try {
      discoveredModels = await listOllamaModels(baseUrl);
      if (discoveredModels.length > 0) {
        checks.push({
          code: "ollama_models_discovered",
          level: "info",
          message: `Discovered ${discoveredModels.length} model(s) from Ollama.`,
        });
      } else {
        checks.push({
          code: "ollama_models_empty",
          level: "warn",
          message: "Ollama returned no models.",
          hint: "Pull a model with `ollama pull llama3.2` or `ollama pull qwen2.5-coder` and retry.",
        });
      }
    } catch (err) {
      checks.push({
        code: "ollama_models_discovery_failed",
        level: "warn",
        message: "Could not list models from Ollama.",
        detail: err instanceof Error ? err.message : String(err),
        hint: "Run `ollama list` to verify Ollama is working correctly.",
      });
    }
  }

  // Check 3: Configured model presence
  if (!configuredModel) {
    checks.push({
      code: "ollama_model_required",
      level: "error",
      message: "ollama_local requires a configured model name.",
      hint: "Set adapterConfig.model to an Ollama model name, e.g. llama3.2 or qwen2.5-coder.",
    });
  } else if (reachable && discoveredModels.length > 0) {
    const modelExists = discoveredModels.some((m) => m.id === configuredModel);
    if (modelExists) {
      checks.push({
        code: "ollama_model_configured",
        level: "info",
        message: `Configured model "${configuredModel}" is available.`,
      });
    } else {
      const sample = discoveredModels
        .slice(0, 8)
        .map((m) => m.id)
        .join(", ");
      checks.push({
        code: "ollama_model_not_found",
        level: "warn",
        message: `Configured model "${configuredModel}" was not found in available models.`,
        detail: `Available: ${sample}${discoveredModels.length > 8 ? ", ..." : ""}`,
        hint: `Run \`ollama pull ${configuredModel}\` to pull it, or choose a different model.`,
      });
    }
  } else if (!reachable) {
    // Can't verify — skip
    checks.push({
      code: "ollama_model_configured",
      level: "info",
      message: `Configured model: ${configuredModel} (could not verify — Ollama unreachable).`,
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
