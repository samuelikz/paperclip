import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function OllamaLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <Field
      label="Ollama Base URL"
      hint="URL of the Ollama server. Defaults to http://localhost:11434 if left empty."
    >
      <DraftInput
        value={
          isCreate
            ? (values?.url ?? "")
            : eff("adapterConfig", "baseUrl", String(config.baseUrl ?? ""))
        }
        onCommit={(v) =>
          isCreate
            ? set!({ url: v })
            : mark("adapterConfig", "baseUrl", v || undefined)
        }
        immediate
        className={inputClass}
        placeholder="http://localhost:11434"
      />
    </Field>
  );
}
