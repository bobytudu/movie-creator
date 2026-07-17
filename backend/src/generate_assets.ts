import * as fs from "fs/promises";
import * as path from "path";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { loadAppConfig, callOllama } from "./config.ts";
import { getBaseDescription, areScenesConnected, extractLastFrame } from "./comfy_service.ts";

const execAsync = promisify(exec);

const COMFYUI_URL = process.env.COMFYUI_URL || "http://127.0.0.1:8188";
const outputDir = process.env.output_dir || "";

let clientId = "";
const runArgs = process.argv.slice(2);
for (let i = 0; i < runArgs.length; i++) {
  if ((runArgs[i] === "--clientId" || runArgs[i] === "--client_id") && i + 1 < runArgs.length) {
    clientId = runArgs[i + 1] ?? "";
    break;
  }
}
console.log(`[generate_assets.ts] Initializing with ComfyUI client_id: "${clientId || "none"}"`);

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
  const payload: any = { prompt: workflow };
  if (clientId) {
    payload.client_id = clientId;
  }
  const response = await fetch(`${COMFYUI_URL}/prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  const result = (await response.json()) as { prompt_id: string };
  return result.prompt_id;
}

/**
 * Gets ComfyUI's current system queue size.
 */
async function getComfyQueueSize(): Promise<number> {
  try {
    const res = await fetch(`${COMFYUI_URL}/queue`);
    if (res.ok) {
      const data = await res.json() as { queue_running: any[]; queue_pending: any[] };
      return (data.queue_running?.length || 0) + (data.queue_pending?.length || 0);
    }
  } catch {}
  return 0;
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
              // Clear progress line
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
      // Silently ignore temporary network errors or polling before entry is created
    }

    dots = dots.length >= 5 ? "." : dots + ".";
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const queueSize = await getComfyQueueSize();
    process.stdout.write(`\r\x1b[K\x1b[36m[ComfyUI] Generating${dots} (${elapsed}s elapsed, Server Queue: ${queueSize})\x1b[0m`);
    
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

/**
 * Generates a camera angle variation for a prompt using Ollama.
 */
async function generateAngleVariation(basePrompt: string, style: string): Promise<string> {
  const systemPrompt = `You are a cinematic storyboard director.
You will be given a base image generation prompt for a scene.
Your task is to rewrite the prompt to represent a DIFFERENT cinematic camera angle or framing of the SAME scene.

The visual style parameter of this storyboard is: "${style}".
Your rewritten prompt must:
1. Keep the exact same characters, character looks, clothing, setting, style, and lighting to maintain absolute visual consistency.
2. Only change the camera angle/framing (e.g. close-up, medium shot, wide shot, over-the-shoulder, low angle, high angle) and the corresponding poses/expressions/focus of the characters.
3. CRITICAL: Characters MUST NEVER look directly at the camera or viewer. They do not know a camera exists.
4. Be written as a single paragraph, similar to the base prompt.

Return ONLY the rewritten prompt. Do not add any explanation, JSON, markdown formatting, or introductory text. Just output the raw prompt string.`;

  try {
    const response = await callOllama([
      { role: "system", content: systemPrompt },
      { role: "user", content: `Base Prompt: ${basePrompt}` }
    ], false);
    return typeof response === "string" ? response.trim() : basePrompt;
  } catch (err: any) {
    logWarning(`Failed to generate camera angle variation via Ollama: ${err.message}. Using base prompt.`);
    return basePrompt;
  }
}

async function main() {
  logHeader("COMFYUI ASSET GENERATION SYSTEM");

  const appConfig = loadAppConfig();
  logInfo(`Configuration - Style: "${appConfig.style}", Resolution: ${appConfig.width}x${appConfig.height}`);

  const inputFileName = path.resolve(process.cwd(), "story_output.json");
  const inputFilePath = inputFileName;
  
  const outputFileName = inputFileName.endsWith(".json")
    ? inputFileName.substring(0, inputFileName.length - 5) + "_assets.json"
    : inputFileName + "_assets.json";
  const finalOutputPath = path.resolve(outputFileName);

  logInfo(`Target story manifest: ${inputFilePath}`);

  // Check if target file exists
  try {
    await fs.access(inputFilePath);
  } catch {
    logError(`Story file not found at ${inputFilePath}. Please specify a valid file path.`);
    process.exit(1);
  }

  // Load and parse story file (resume from assets manifest if available)
  let storyData: any;
  let manifestPathToLoad = inputFilePath;

  try {
    await fs.access(finalOutputPath);
    manifestPathToLoad = finalOutputPath;
    logInfo(`Resuming from existing asset manifest: ${finalOutputPath}`);
  } catch {
    logInfo(`Starting fresh from story manifest: ${inputFilePath}`);
  }

  try {
    const fileContent = await fs.readFile(manifestPathToLoad, "utf-8");
    storyData = JSON.parse(fileContent);
  } catch (err: any) {
    if (manifestPathToLoad === finalOutputPath) {
      logWarning(`Failed to read asset manifest: ${err.message}. Falling back to base story manifest.`);
      try {
        const fileContent = await fs.readFile(inputFilePath, "utf-8");
        storyData = JSON.parse(fileContent);
        manifestPathToLoad = inputFilePath;
      } catch (innerErr: any) {
        logError(`Failed to read fallback story manifest: ${innerErr.message}`);
        process.exit(1);
      }
    } else {
      logError(`Failed to read or parse story JSON: ${err.message}`);
      process.exit(1);
    }
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
  const imageTemplatePath = path.join(process.cwd(), "workflow", "image_flux2_text_to_image.json");
  const videoTemplatePath = path.join(process.cwd(), "workflow", "video_ltx2_3_i2v.json");

  // Verify templates exist
  try {
    await fs.access(imageTemplatePath);
    await fs.access(videoTemplatePath);
  } catch (err: any) {
    logError(`Required workflow templates are missing in 'workflow' folder: ${err.message}`);
    process.exit(1);
  }

  // Pre-pass simulation to calculate queue size and total images to generate
  let totalImagesToGenerate = 0;

  for (let idx = 0; idx < storyData.scenes.length; idx++) {
    const scene = storyData.scenes[idx];
    const imagePrompt = scene.imagePrompt;
    if (!imagePrompt) continue;

    const isSameSceneGroup = idx > 0 && areScenesConnected(scene, storyData.scenes[idx - 1]);

    if (isSameSceneGroup) {
      // Connected scene: start frame will be extracted from previous video
      continue;
    }

    // Check if the current scene already has a valid image
    let hasValidImage = false;
    if (scene.imagePath) {
      try {
        await fs.access(scene.imagePath);
        hasValidImage = true;
      } catch {}
    }

    if (hasValidImage) {
      continue;
    }

    totalImagesToGenerate++;
  }

  logInfo(`Total images that need to be generated via ComfyUI: ${totalImagesToGenerate}`);

  // Helper for Flux Text-to-Image generation
  let currentImageNum = 0;
  async function generateImageFlux(scene: any, sceneNum: number) {
    currentImageNum++;
    const queueRemaining = totalImagesToGenerate - currentImageNum;
    logHeader(`[${currentImageNum}/${totalImagesToGenerate} image] GENERATING VIA TEXT-TO-IMAGE FOR SCENE ${sceneNum}/${storyData.scenes.length}`);
    logInfo(`Images remaining in queue: ${queueRemaining}`);
    logInfo(`Image Prompt: "${scene.imagePrompt.substring(0, 100)}..."`);

    try {
      logInfo("Queueing image generation...");
      const imageWorkflowContent = await fs.readFile(imageTemplatePath, "utf-8");
      const imageWorkflow = JSON.parse(imageWorkflowContent);

      // Set resolution in Scheduler node "98:48"
      if (imageWorkflow["98:48"]?.inputs) {
        imageWorkflow["98:48"].inputs.width = appConfig.width;
        imageWorkflow["98:48"].inputs.height = appConfig.height;
      }

      // Set resolution in Latent node "98:47"
      if (imageWorkflow["98:47"]?.inputs) {
        imageWorkflow["98:47"].inputs.width = appConfig.width;
        imageWorkflow["98:47"].inputs.height = appConfig.height;
      }

      // Modify image positive prompt text
      if (imageWorkflow["98:6"]?.inputs) {
        imageWorkflow["98:6"].inputs.text = scene.imagePrompt;
      } else {
        throw new Error("Could not find positive prompt node '98:6' in image workflow.");
      }

      // Randomize image seed
      if (imageWorkflow["98:25"]?.inputs) {
        imageWorkflow["98:25"].inputs.noise_seed = Math.floor(Math.random() * 1000000000000000);
      }

      const imagePromptId = await queueWorkflow(imageWorkflow);
      logInfo(`Image generation queued (Prompt ID: ${imagePromptId}). Waiting for completion...`);

      const imageHistory = await pollPromptCompletion(imagePromptId);
      const imageResult = extractFileFromHistory(imageHistory, "9");
      logSuccess(`Image generated: ${imageResult.absolutePath}`);

      scene.imagePath = imageResult.absolutePath;
    } catch (err: any) {
      logError(`Failed to generate image for scene ${sceneNum}: ${err.message}`);
    }
  }

  // 1. GENERATE IMAGES & VIDEOS SEQUENTIALLY PER SCENE
  logHeader("GENERATING IMAGES AND VIDEOS FOR ALL SCENES");
  
  for (let idx = 0; idx < storyData.scenes.length; idx++) {
    const scene = storyData.scenes[idx];
    const sceneNum = scene.sceneNumber || (idx + 1);

    logHeader(`PROCESSING SCENE ${sceneNum}/${storyData.scenes.length}`);

    // --- STEP 1: IMAGE SETTING/GENERATION ---
    const imagePrompt = scene.imagePrompt;
    if (!imagePrompt) {
      logWarning(`Scene ${sceneNum} has no imagePrompt. Skipping asset generation.`);
      continue;
    }

    const isSameSceneGroup = idx > 0 && areScenesConnected(scene, storyData.scenes[idx - 1]);

    let hasValidImage = false;
    if (scene.imagePath) {
      try {
        await fs.access(scene.imagePath);
        hasValidImage = true;
      } catch {}
    }

    if (!hasValidImage) {
      if (isSameSceneGroup) {
        // Connected scene: extract last frame of the previous video
        const prevScene = storyData.scenes[idx - 1];
        if (prevScene.videoPath) {
          try {
            await fs.access(prevScene.videoPath);
            logInfo(`Scene ${sceneNum} is connected to Scene ${prevScene.sceneNumber}. Extracting start frame from last frame of previous video: ${prevScene.videoPath}`);
            
            const videoDir = path.dirname(prevScene.videoPath);
            const extFramePath = path.join(videoDir, `scene_${sceneNum}_start_frame.png`).replace(/\\/g, "/");
            
            await extractLastFrame(prevScene.videoPath, extFramePath);
            scene.imagePath = extFramePath;
            logSuccess(`Extracted last frame to: ${extFramePath}`);
          } catch (err: any) {
            logError(`Failed to extract last frame for scene ${sceneNum}: ${err.message}. Falling back to standard text-to-image.`);
            await generateImageFlux(scene, sceneNum);
          }
        } else {
          logWarning(`Previous scene ${prevScene.sceneNumber} does not have a video. Falling back to standard text-to-image.`);
          await generateImageFlux(scene, sceneNum);
        }
      } else {
        // First in group or independent scene
        await generateImageFlux(scene, sceneNum);
      }
      
      // Save manifest progress immediately
      await fs.writeFile(finalOutputPath, JSON.stringify(storyData, null, 2), "utf-8");
    } else {
      logInfo(`Scene ${sceneNum} already has a generated image at: ${scene.imagePath}. Skipping image generation.`);
    }

    // --- STEP 2: VIDEO GENERATION ---
    const imagePath = scene.imagePath;
    if (!imagePath) {
      logWarning(`Scene ${sceneNum} has no imagePath. Skipping video generation.`);
      continue;
    }

    let hasValidVideo = false;
    if (scene.videoPath) {
      try {
        await fs.access(scene.videoPath);
        hasValidVideo = true;
      } catch {}
    }

    if (!hasValidVideo) {
      const duration = scene.duration || 6;
      logInfo(`Queueing video generation for Scene ${sceneNum} (Duration: ${duration}s)...`);
      try {
        const videoWorkflowContent = await fs.readFile(videoTemplatePath, "utf-8");
        const videoWorkflow = JSON.parse(videoWorkflowContent);

        // Set resolution if custom width/height is specified
        if (videoWorkflow["320:312"]?.inputs) {
          videoWorkflow["320:312"].inputs.value = appConfig.width;
        } else {
          throw new Error("Could not find width node '320:312' in video workflow.");
        }
        if (videoWorkflow["320:299"]?.inputs) {
          videoWorkflow["320:299"].inputs.value = appConfig.height;
        } else {
          throw new Error("Could not find height node '320:299' in video workflow.");
        }

        // Set input image path
        if (videoWorkflow["269"]?.inputs) {
          videoWorkflow["269"].inputs.image = imagePath;
        } else {
          throw new Error("Could not find LoadImage node '269' in video workflow.");
        }

        // Set positive prompt text
        let videoPrompt = scene.script 
          ? `${imagePrompt}\n\nAudio/Dialogue:\n${scene.script}`
          : scene.voiceover
            ? `${imagePrompt}\n\nAudio/Dialogue:\n${scene.voiceover}`
            : imagePrompt;

        // Add realistic movement modifiers and requested suffix
        videoPrompt += "\n\nRealistic, natural, lifelike movement speed for all characters and animals. They move naturally at real-time speeds, behave like living beings with realistic weight and physics. Camera movement is a handheld camera look, realistic lens breathing, natural subtle camera shake, professional documentary camera operator feel.";
        videoPrompt += "\n\nadd some movement in the video/scene, characters, objects camera movements etc,";

        logInfo(`Video Prompt: "${videoPrompt.substring(0, 100)}..."`);

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
        await fs.writeFile(finalOutputPath, JSON.stringify(storyData, null, 2), "utf-8");
        logInfo(`Saved progress to: ${finalOutputPath}`);
      } catch (err: any) {
        logError(`Failed to generate video for scene ${sceneNum}: ${err.message}`);
      }
    } else {
      logInfo(`Scene ${sceneNum} already has a generated video at: ${scene.videoPath}. Skipping.`);
    }
  }

  // Write updated manifest back
  logHeader("WRITING UPDATED MANIFEST");
  try {
    await fs.writeFile(finalOutputPath, JSON.stringify(storyData, null, 2), "utf-8");
    logSuccess(`Successfully saved story with assets to: ${finalOutputPath}`);
  } catch (err: any) {
    logError(`Failed to save updated story manifest: ${err.message}`);
  }

  // Call the external merge_videos.ts script
  try {
    logHeader("RUNNING STANDALONE VIDEO MERGE UTILITY");
    const mergeScriptPath = path.join(process.cwd(), "src", "merge_videos.ts");
    logInfo(`Executing: bun "${mergeScriptPath}"`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("bun", [mergeScriptPath], { stdio: "inherit", shell: true });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Video merge exited with code ${code}`));
      });
      child.on("error", reject);
    });
  } catch (err: any) {
    logError("Failed to execute merge_videos.ts script", err);
  }

  logHeader("ASSET GENERATION COMPLETE");
}

main().catch((err) => {
  logError("Fatal error during asset generation execution", err);
});
