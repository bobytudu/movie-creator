import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { config } from "dotenv";
import { loadAppConfig } from "./config.ts";

config();
const execAsync = promisify(exec);

const COMFYUI_URL = process.env.COMFYUI_URL || "http://127.0.0.1:8188";
const outputDir = process.env.output_dir || "";

// Standard styling helper
function logHeader(text: string) {
  console.log(`\n\x1b[35m=== ${text} ===\x1b[0m`);
}
function logInfo(text: string) {
  console.log(`\x1b[34m[Info] ${text}\x1b[0m`);
}
function logSuccess(text: string) {
  console.log(`\x1b[32m[Success] ${text}\x1b[0m`);
}
function logWarning(text: string) {
  console.log(`\x1b[33m[Warning] ${text}\x1b[0m`);
}
function logError(text: string, err?: any) {
  console.error(`\x1b[31m[Error] ${text}\x1b[0m`, err || "");
}

/**
 * Checks if the ComfyUI server is reachable.
 */
async function checkComfyServer(): Promise<boolean> {
  try {
    const res = await fetch(`${COMFYUI_URL}/system_info`);
    return res.ok;
  } catch {
    try {
      const res = await fetch(`${COMFYUI_URL}/prompt`);
      return res.status === 405 || res.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Queues a workflow JSON to ComfyUI and returns the prompt ID.
 */
async function queueWorkflow(workflow: any): Promise<string> {
  const response = await fetch(`${COMFYUI_URL}/prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: workflow }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  const result = (await response.json()) as { prompt_id: string };
  return result.prompt_id;
}

/**
 * Polls the ComfyUI history API for a prompt ID until completion.
 */
async function pollPromptCompletion(promptId: string): Promise<any> {
  const start = Date.now();
  let dots = "";
  
  while (true) {
    try {
      const response = await fetch(`${COMFYUI_URL}/history/${promptId}`);
      if (response.ok) {
        const history = (await response.json()) as Record<string, any>;
        if (history && history[promptId]) {
          const entry = history[promptId];
          const status = entry.status;
          
          if (status) {
            if (status.status_str === "success") {
              process.stdout.write(`\r\x1b[K`);
              return entry;
            } else {
              throw new Error(`ComfyUI generation failed with status: ${JSON.stringify(status)}`);
            }
          }
          process.stdout.write(`\r\x1b[K`);
          return entry;
        }
      }
    } catch (err: any) {
      if (err.message && err.message.includes("ComfyUI generation failed")) {
        throw err;
      }
    }

    dots = dots.length >= 5 ? "." : dots + ".";
    const elapsed = Math.floor((Date.now() - start) / 1000);
    process.stdout.write(`\r\x1b[K\x1b[36m[ComfyUI] Generating${dots} (${elapsed}s elapsed)\x1b[0m`);
    
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * Extracts the file path from the execution history of a completed node.
 */
function extractFileFromHistory(historyEntry: any, nodeId: string): { filename: string; absolutePath: string } {
  const nodeOutput = historyEntry.outputs?.[nodeId];
  if (!nodeOutput) {
    throw new Error(`Node ${nodeId} output was not found in prompt history.`);
  }

  const list = nodeOutput.gifs || nodeOutput.videos || nodeOutput.images || nodeOutput.filenames || [];
  if (list.length === 0) {
    throw new Error(`Node ${nodeId} did not output any files.`);
  }

  const item = list[0];
  const filename = typeof item === "string" ? item : item.filename;
  const subfolder = typeof item === "string" ? "" : (item.subfolder || "");

  const relativePath = subfolder ? path.join(subfolder, filename) : filename;
  const absolutePath = outputDir ? path.join(outputDir, relativePath) : path.resolve(relativePath);

  return {
    filename,
    absolutePath: absolutePath.replace(/\\/g, "/"),
  };
}

async function main() {
  logHeader("COMFYUI VIDEO-ONLY GENERATION SYSTEM");

  const appConfig = loadAppConfig();
  logInfo(`Configuration - Default Resolution: ${appConfig.width}x${appConfig.height}`);

  // Parse arguments and environment variables for resolution overrides
  const args = process.argv.slice(2);
  let targetWidth: number | undefined;
  let targetHeight: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--width" && i + 1 < args.length) {
      const val = parseInt(args[i + 1]!, 10);
      if (!isNaN(val)) targetWidth = val;
      i++;
    } else if (arg === "--height" && i + 1 < args.length) {
      const val = parseInt(args[i + 1]!, 10);
      if (!isNaN(val)) targetHeight = val;
      i++;
    } else if (arg === "--resolution" && i + 1 < args.length) {
      const res = args[i + 1];
      if (res) {
        const match = res.match(/^(\d+)x(\d+)$/i);
        if (match && match[1] && match[2]) {
          const w = parseInt(match[1], 10);
          const h = parseInt(match[2], 10);
          if (!isNaN(w) && !isNaN(h)) {
            targetWidth = w;
            targetHeight = h;
          }
        }
      }
      i++;
    }
  }

  // Fallback to env variables if not passed via CLI
  if (targetWidth === undefined && process.env.VIDEO_WIDTH) {
    const val = parseInt(process.env.VIDEO_WIDTH, 10);
    if (!isNaN(val)) targetWidth = val;
  }
  if (targetHeight === undefined && process.env.VIDEO_HEIGHT) {
    const val = parseInt(process.env.VIDEO_HEIGHT, 10);
    if (!isNaN(val)) targetHeight = val;
  }

  // Final fallback to config.json values
  if (targetWidth === undefined) {
    targetWidth = appConfig.width;
  }
  if (targetHeight === undefined) {
    targetHeight = appConfig.height;
  }

  logInfo(`Video resolution: ${targetWidth}x${targetHeight}`);

  const manifestFileName = "story_output_assets.json";
  const manifestFilePath = path.resolve(manifestFileName);
  
  logInfo(`Target story manifest: ${manifestFilePath}`);

  // Check if target file exists
  try {
    await fs.access(manifestFilePath);
  } catch {
    logError(`Story asset manifest file not found at ${manifestFilePath}. Video generation requires an existing asset manifest.`);
    process.exit(1);
  }

  // Load and parse story file
  let storyData: any;
  try {
    const fileContent = await fs.readFile(manifestFilePath, "utf-8");
    storyData = JSON.parse(fileContent);
  } catch (err: any) {
    logError(`Failed to read or parse story JSON: ${err.message}`);
    process.exit(1);
  }

  if (!storyData.scenes || !Array.isArray(storyData.scenes)) {
    logError("Invalid story manifest: 'scenes' array is missing or empty.");
    process.exit(1);
  }


  if (!outputDir) {
    logWarning("output_dir is not set in environment. Saved file paths will resolve relative to working directory.");
  } else {
    logInfo(`Output directory set to: ${outputDir}`);
  }

  // Define paths to templates
  const videoTemplatePath = path.join(process.cwd(), "workflow", "video_ltx2_3_i2v.json");

  // Verify template exists
  try {
    await fs.access(videoTemplatePath);
  } catch (err: any) {
    logError(`Required video workflow template is missing in 'workflow' folder: ${err.message}`);
    process.exit(1);
  }

  // GENERATE VIDEOS FOR ALL SCENES
  logHeader("GENERATING VIDEOS FOR SCENES");
  for (let idx = 0; idx < storyData.scenes.length; idx++) {
    const scene = storyData.scenes[idx];
    const sceneNum = scene.sceneNumber || (idx + 1);

    const imagePath = scene.imagePath;
    if (!imagePath) {
      logWarning(`Scene ${sceneNum} has no imagePath. Video generation requires an input image. Skipping.`);
      continue;
    }

    // Verify image file exists on disk
    try {
      await fs.access(imagePath);
    } catch {
      logWarning(`Scene ${sceneNum} image file not found at ${imagePath}. Skipping video generation.`);
      continue;
    }

    // Skip if video already exists
    if (scene.videoPath) {
      try {
        await fs.access(scene.videoPath);
        logInfo(`Scene ${sceneNum} already has a generated video at: ${scene.videoPath}. Skipping.`);
        continue;
      } catch {
        // Video path is invalid/missing, generate it
      }
    }

    const imagePrompt = scene.imagePrompt;
    const duration = scene.duration || 6;

    logHeader(`GENERATING VIDEO FOR SCENE ${sceneNum}/${storyData.scenes.length}`);
    logInfo(`Duration: ${duration}s${targetWidth !== undefined ? `, Width: ${targetWidth}` : ""}${targetHeight !== undefined ? `, Height: ${targetHeight}` : ""}`);

    try {
      logInfo("Queueing video generation...");
      const videoWorkflowContent = await fs.readFile(videoTemplatePath, "utf-8");
      const videoWorkflow = JSON.parse(videoWorkflowContent);

      // Set resolution if custom width/height is specified
      if (targetWidth !== undefined) {
        if (videoWorkflow["320:312"]?.inputs) {
          videoWorkflow["320:312"].inputs.value = targetWidth;
        } else {
          throw new Error("Could not find width node '320:312' in video workflow.");
        }
      }
      if (targetHeight !== undefined) {
        if (videoWorkflow["320:299"]?.inputs) {
          videoWorkflow["320:299"].inputs.value = targetHeight;
        } else {
          throw new Error("Could not find height node '320:299' in video workflow.");
        }
      }

      // Set input image path
      if (videoWorkflow["269"]?.inputs) {
        videoWorkflow["269"].inputs.image = imagePath;
      } else {
        throw new Error("Could not find LoadImage node '269' in video workflow.");
      }

      // Set positive prompt text (include script/voiceover for character dialog/speech generation)
      let videoPrompt = scene.script 
        ? `${imagePrompt}\n\nAudio/Dialogue:\n${scene.script}`
        : scene.voiceover
          ? `${imagePrompt}\n\nAudio/Dialogue:\n${scene.voiceover}`
          : imagePrompt;

      // Add realistic movement modifiers
      videoPrompt += "\n\nRealistic, natural, lifelike movement speed for all characters and animals. They move naturally at real-time speeds, behave like living beings with realistic weight and physics. Camera movement is a handheld camera look, realistic lens breathing, natural subtle camera shake, professional documentary camera operator feel.";

      logInfo(`Video Prompt (with script): "${videoPrompt.substring(0, 100)}..."`);

      if (videoWorkflow["320:319"]?.inputs) {
        videoWorkflow["320:319"].inputs.value = videoPrompt;
      } else {
        throw new Error("Could not find prompt value node '320:319' in video workflow.");
      }

      // Set duration
      if (videoWorkflow["320:301"]?.inputs) {
        videoWorkflow["320:301"].inputs.value = duration;
      } else {
        throw new Error("Could not find duration node '320:301' in video workflow.");
      }

      // Randomize video seeds
      if (videoWorkflow["320:276"]?.inputs) {
        videoWorkflow["320:276"].inputs.noise_seed = Math.floor(Math.random() * 1000000000000000);
      }
      if (videoWorkflow["320:277"]?.inputs) {
        videoWorkflow["320:277"].inputs.noise_seed = Math.floor(Math.random() * 1000000000000000);
      }

      const videoPromptId = await queueWorkflow(videoWorkflow);
      logInfo(`Video generation queued (Prompt ID: ${videoPromptId}). Waiting for completion...`);

      const videoHistory = await pollPromptCompletion(videoPromptId);
      const videoResult = extractFileFromHistory(videoHistory, "75");
      logSuccess(`Video generated: ${videoResult.absolutePath}`);

      scene.videoPath = videoResult.absolutePath;

      // Save manifest progress immediately
      await fs.writeFile(manifestFilePath, JSON.stringify(storyData, null, 2), "utf-8");
      logInfo(`Saved progress to: ${manifestFilePath}`);
    } catch (err: any) {
      logError(`Failed to generate video for scene ${sceneNum}: ${err.message}`);
    }
  }

  // Write final updated manifest back
  logHeader("WRITING UPDATED MANIFEST");
  try {
    await fs.writeFile(manifestFilePath, JSON.stringify(storyData, null, 2), "utf-8");
    logSuccess(`Successfully saved story with assets to: ${manifestFilePath}`);
  } catch (err: any) {
    logError(`Failed to save updated story manifest: ${err.message}`);
  }

  // Call the external merge_videos.ts script
  try {
    logHeader("RUNNING STANDALONE VIDEO MERGE UTILITY");
    const mergeScriptPath = path.join(process.cwd(), "src", "merge_videos.ts");
    logInfo(`Executing: bun "${mergeScriptPath}"`);
    const { stdout, stderr } = await execAsync(`bun "${mergeScriptPath}"`);
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  } catch (err: any) {
    logError("Failed to execute merge_videos.ts script", err);
  }

  logHeader("VIDEO GENERATION COMPLETE");
}

main().catch((err) => {
  logError("Fatal error during video generation execution", err);
});
