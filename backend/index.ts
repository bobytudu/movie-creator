import { graph } from "./src/graph.ts";
import { loadAppConfig, OLLAMA_MODEL } from "./src/config.ts";
import { initializeImageCounter } from "./src/comfy.ts";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs/promises";

const execAsync = promisify(exec);
const startTime = Date.now();

const appConfig = loadAppConfig();

const args = process.argv.slice(2);
let style = appConfig.style;
let clientId = "";
const topicWords: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg !== undefined) {
    if (arg === "--style" && i + 1 < args.length) {
      style = args[i + 1] ?? appConfig.style;
      i++;
    } else if ((arg === "--clientId" || arg === "--client_id") && i + 1 < args.length) {
      clientId = args[i + 1] ?? "";
      i++;
    } else {
      topicWords.push(arg);
    }
  }
}

const defaultTopic = "space exploration people lost in unknown planet, they see some unknown plants who can eat them, strange animal totally different from earth";
const topic = topicWords.join(" ") || defaultTopic;

const outputFile = "story_output.json";

console.log(`\x1b[34m==================================================`);
console.log(`Starting story generation workflow...`);
console.log(`Topic:      "${topic}"`);
console.log(`Style:      "${style}" (config: "${appConfig.style}")`);
console.log(`Resolution: ${appConfig.width}x${appConfig.height}`);
console.log(`Model:      ${OLLAMA_MODEL}`);
console.log(`ClientId:   "${clientId || "none"}"`);
console.log(`Output:     ${outputFile}`);
console.log(`==================================================\x1b[0m\n`);

try {
  await initializeImageCounter();
  
  let shouldGenerateStory = true;
  try {
    await fs.access(outputFile);
    const isCustomTopic = topicWords.length > 0;
    if (!isCustomTopic) {
      console.log(`\x1b[34m[Info] Existing story manifest found at ${outputFile} and no custom topic was provided. Skipping story generation graph and resuming asset pipeline...\x1b[0m`);
      shouldGenerateStory = false;
    }
  } catch {
    // outputFile does not exist, must generate
  }

  if (shouldGenerateStory) {
    await graph.invoke({
      topic: topic,
      style: style,
      outputFile: outputFile
    });
    console.log(`\x1b[32mWorkflow execution finished successfully!\x1b[0m`);
  }

  // Call the external generate_assets.ts script
  try {
    console.log(`\n\x1b[35m=== RUNNING ASSET GENERATION PIPELINE ===\x1b[0m`);
    const assetScriptPath = path.join(process.cwd(), "src", "generate_assets.ts");
    const runArgs = [assetScriptPath];
    if (clientId) {
      runArgs.push("--clientId", clientId);
    }
    console.log(`\x1b[34m[Info] Executing: bun "${assetScriptPath}" ${clientId ? `--clientId ${clientId}` : ""}\x1b[0m`);
    
    await new Promise<void>((resolve, reject) => {
      const child = spawn("bun", runArgs, { stdio: "inherit", shell: true });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Asset pipeline exited with code ${code}`));
      });
      child.on("error", reject);
    });
  } catch (err: any) {
    console.error(`\x1b[31m[Error] Failed to execute generate_assets.ts script\x1b[0m`, err);
  }

  const endTime = Date.now();
  const elapsedSeconds = ((endTime - startTime) / 1000).toFixed(2);
  console.log(`\n\x1b[32m=== PROCESS COMPLETE ===\x1b[0m`);
  console.log(`\x1b[32mTotal time taken: ${elapsedSeconds}s\x1b[0m`);

} catch (error) {
  console.error("\x1b[31mWorkflow failed with error:\x1b[0m", error);
}