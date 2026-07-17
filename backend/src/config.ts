import ollama from 'ollama';
import * as fs from 'fs';
import * as path from 'path';

export interface AppConfig {
  style: string;
  width: number;
  height: number;
}

export function loadAppConfig(): AppConfig {
  const configPath = path.resolve(process.cwd(), "config.json");
  const defaults: AppConfig = {
    style: "anime",
    width: 1280,
    height: 720
  };

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    
    let style = parsed.style || defaults.style;
    let width = parsed.width;
    let height = parsed.height;

    if (parsed.resolution && typeof parsed.resolution === "string") {
      const match = parsed.resolution.match(/^(\d+)x(\d+)$/i);
      if (match && match[1] && match[2]) {
        width = parseInt(match[1], 10);
        height = parseInt(match[2], 10);
      }
    }

    return {
      style,
      width: typeof width === "number" && !isNaN(width) ? width : defaults.width,
      height: typeof height === "number" && !isNaN(height) ? height : defaults.height
    };
  } catch (err) {
    return defaults;
  }
}

export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'nemotron-3-ultra:cloud';

// export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'nemotron3:33b';

/**
 * Helper to call the Ollama model with structured or text outputs.
 */
export async function callOllama(
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
  jsonMode: boolean = false,
  temperature: number = 0.7
): Promise<any> {
  console.log(`\x1b[36m[Ollama] Invoking ${OLLAMA_MODEL} (JSON: ${jsonMode}, Temp: ${temperature})...\x1b[0m`);
  
  const maxRetries = 3;
  let attempts = 0;
  
  while (attempts < maxRetries) {
    attempts++;
    try {
      const response = await ollama.chat({
        model: OLLAMA_MODEL,
        messages: messages,
        options: {
          temperature: temperature,
        },
        ...(jsonMode ? { format: 'json' } : {}),
      });

      const content = response.message.content;
      if (jsonMode) {
        try {
          return JSON.parse(content);
        } catch (err) {
          console.warn(`[Ollama] Attempt ${attempts} - JSON parse failure. Retrying... Raw content:\n`, content);
          if (attempts >= maxRetries) {
            throw new Error(`Failed to parse JSON after ${maxRetries} attempts: ${err}`);
          }
          // Append a retry instruction message
          messages.push({
            role: 'assistant',
            content: content
          });
          messages.push({
            role: 'user',
            content: 'Error: The response was not valid JSON. Please output the response again, ensuring it conforms strictly to the JSON schema requested.'
          });
        }
      } else {
        return content;
      }
    } catch (error) {
      console.error(`[Ollama] Attempt ${attempts} failed with error:`, error);
      if (attempts >= maxRetries) {
        throw error;
      }
    }
  }
}
