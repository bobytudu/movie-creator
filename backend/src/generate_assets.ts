import * as fs from "fs/promises";
import * as path from "path";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { loadAppConfig, callOllama } from "./config.ts";

const execAsync = promisify(exec);

const COMFYUI_URL = process.env.COMFYUI_URL || "http://127.0.0.1:8188";
const outputDir = process.env.output_dir || "";

let clientId = "";
const runArgs = process.argv.slice(2);
for (let i = 0; i < runArgs.length; i++) {
  if (runArgs[i] === "--clientId" && i + 1 < runArgs.length) {
    clientId = runArgs[i + 1] ?? "";
    break;
  }
}

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

  const inputFileName = "C:/personal_projects/workflow/story_output.json"
  const inputFilePath = path.resolve(inputFileName);
  
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

  // Helper to get base description by stripping (Part X)
  function getBaseDescription(desc: string): string {
    return desc.replace(/\s*\(Part\s+\d+\)$/i, "").trim();
  }

  // Pre-pass simulation to calculate queue size and total images to generate
  let totalImagesToGenerate = 0;
  let simulatedBaseIdx = -1;
  const simulatedImagePaths = new Map<number, string>(); // index -> dummy path to simulate existence

  for (let idx = 0; idx < storyData.scenes.length; idx++) {
    const scene = storyData.scenes[idx];
    const imagePrompt = scene.imagePrompt;
    if (!imagePrompt) continue;

    const isSameSceneGroup = idx > 0 &&
      scene.setting === storyData.scenes[idx - 1].setting &&
      getBaseDescription(scene.description) === getBaseDescription(storyData.scenes[idx - 1].description);

    if (!isSameSceneGroup) {
      simulatedBaseIdx = idx;
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
      simulatedImagePaths.set(idx, scene.imagePath);
      continue;
    }

    if (isSameSceneGroup && simulatedBaseIdx !== -1) {
      // We do not reuse images. If the prompt is the same, we generate a new angle variation and edit.
      totalImagesToGenerate++;
      simulatedImagePaths.set(idx, "edit");
    } else {
      // First in group, will call ComfyUI text-to-image
      totalImagesToGenerate++;
      simulatedImagePaths.set(idx, "text2img");
    }
  }

  logInfo(`Total images that need to be generated via ComfyUI: ${totalImagesToGenerate}`);

  // 1. GENERATE IMAGES FOR ALL SCENES
  logHeader("GENERATING IMAGES FOR ALL SCENES");
  
  let baseSceneIdx = -1;
  let currentImageNum = 0;

  for (let idx = 0; idx < storyData.scenes.length; idx++) {
    const scene = storyData.scenes[idx];
    const sceneNum = scene.sceneNumber || (idx + 1);

    let imagePrompt = scene.imagePrompt;
    if (!imagePrompt) {
      logWarning(`Scene ${sceneNum} has no imagePrompt. Skipping image generation.`);
      continue;
    }

    // Determine if this scene is part of the same scene group as the previous one
    const isSameSceneGroup = idx > 0 &&
      scene.setting === storyData.scenes[idx - 1].setting &&
      getBaseDescription(scene.description) === getBaseDescription(storyData.scenes[idx - 1].description);

    if (!isSameSceneGroup) {
      baseSceneIdx = idx;
    }

    // Check if the current scene already has a valid image
    let hasValidImage = false;
    if (scene.imagePath) {
      try {
        await fs.access(scene.imagePath);
        hasValidImage = true;
      } catch {
        // Image doesn't exist on disk, we need to generate/reuse
      }
    }

    if (hasValidImage) {
      logInfo(`Scene ${sceneNum} already has a generated image at: ${scene.imagePath}. Skipping.`);
      continue;
    }

    // If it's in the same scene group, we check if we can reuse or need to generate using image edit
    if (isSameSceneGroup && baseSceneIdx !== -1) {
      const baseScene = storyData.scenes[baseSceneIdx]!;

      // If current imagePrompt is exactly the same as the base scene's imagePrompt:
      // generate a new camera angle/framing for it
      if (imagePrompt.trim() === baseScene.imagePrompt.trim()) {
        logInfo(`Scene ${sceneNum} has the same prompt as base Scene ${baseScene.sceneNumber}. Generating a different camera angle...`);
        imagePrompt = await generateAngleVariation(imagePrompt, appConfig.style);
        scene.imagePrompt = imagePrompt;
        await fs.writeFile(finalOutputPath, JSON.stringify(storyData, null, 2), "utf-8");
      }

      // Ensure the base scene has a valid image path. If not, generate/locate it first.
      let baseImagePath = baseScene.imagePath;
      let baseImageValid = false;
      if (baseImagePath) {
        try {
          await fs.access(baseImagePath);
          baseImageValid = true;
        } catch {}
      }

      if (baseImageValid) {

        // If the prompt is different, we use the image edit workflow!
        currentImageNum++;
        const queueRemaining = totalImagesToGenerate - currentImageNum;
        logHeader(`[${currentImageNum}/${totalImagesToGenerate} image] GENERATING VIA IMAGE-TO-IMAGE FOR SCENE ${sceneNum}/${storyData.scenes.length}`);
        logInfo(`Images remaining in queue: ${queueRemaining}`);
        logInfo(`Source Base Image: ${baseImagePath}`);
        logInfo(`Image Prompt (Angle/Edit): "${imagePrompt.substring(0, 100)}..."`);

        try {
          logInfo("Queueing image-to-image/edit generation...");
          const editTemplatePath = path.join(process.cwd(), "workflow", "image_flux2.json");
          const editWorkflowContent = await fs.readFile(editTemplatePath, "utf-8");
          const editWorkflow = JSON.parse(editWorkflowContent);

          // Configure custom resolution
          if (editWorkflow["45"]?.inputs) {
            editWorkflow["45"] = {
              inputs: {
                resize_type: "scale dimensions",
                "resize_type.width": appConfig.width,
                "resize_type.height": appConfig.height,
                "resize_type.crop": "center",
                scale_method: "lanczos",
                input: [
                  "46",
                  0
                ]
              },
              class_type: "ResizeImageMaskNode",
              _meta: {
                title: "Resize Image/Mask"
              }
            };
          }

          // Set source image in LoadImage node "46"
          if (editWorkflow["46"]?.inputs) {
            editWorkflow["46"].inputs.image = baseImagePath;
          } else {
            throw new Error("Could not find LoadImage node '46' in image edit workflow.");
          }

          // Set prompt text in CLIPTextEncode positive prompt node "68:6"
          if (editWorkflow["68:6"]?.inputs) {
            editWorkflow["68:6"].inputs.text = imagePrompt;
          } else {
            throw new Error("Could not find positive prompt node '68:6' in image edit workflow.");
          }

          // Randomize seed in RandomNoise node "68:25"
          if (editWorkflow["68:25"]?.inputs) {
            editWorkflow["68:25"].inputs.noise_seed = Math.floor(Math.random() * 1000000000000000);
          }

          const editPromptId = await queueWorkflow(editWorkflow);
          logInfo(`Image-to-image generation queued (Prompt ID: ${editPromptId}). Waiting for completion...`);

          const editHistory = await pollPromptCompletion(editPromptId);
          const editResult = extractFileFromHistory(editHistory, "9");
          logSuccess(`Image generated via edit workflow: ${editResult.absolutePath}`);

          scene.imagePath = editResult.absolutePath;

          // Save manifest progress immediately
          await fs.writeFile(finalOutputPath, JSON.stringify(storyData, null, 2), "utf-8");
          logInfo(`Saved progress to: ${finalOutputPath}`);
          continue;
        } catch (err: any) {
          logError(`Failed to generate image-to-image for scene ${sceneNum}: ${err.message}. Falling back to standard generation.`);
          // If edit fails, we fall through to standard generation so that we don't block the pipeline
        }
      } else {
        logWarning(`Base scene ${baseScene.sceneNumber} does not have a valid image. Falling back to standard text-to-image.`);
      }
    }

    currentImageNum++;
    const queueRemaining = totalImagesToGenerate - currentImageNum;
    logHeader(`[${currentImageNum}/${totalImagesToGenerate} image] GENERATING VIA TEXT-TO-IMAGE FOR SCENE ${sceneNum}/${storyData.scenes.length}`);
    logInfo(`Images remaining in queue: ${queueRemaining}`);
    logInfo(`Image Prompt: "${imagePrompt.substring(0, 100)}..."`);

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
        imageWorkflow["98:6"].inputs.text = imagePrompt;
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

      // Save manifest progress immediately
      await fs.writeFile(finalOutputPath, JSON.stringify(storyData, null, 2), "utf-8");
      logInfo(`Saved progress to: ${finalOutputPath}`);
    } catch (err: any) {
      logError(`Failed to generate image for scene ${sceneNum}: ${err.message}`);
    }
  }

  // 2. GENERATE VIDEOS FOR ALL SCENES
  logHeader("GENERATING VIDEOS FOR ALL SCENES");
  for (let idx = 0; idx < storyData.scenes.length; idx++) {
    const scene = storyData.scenes[idx];
    const sceneNum = scene.sceneNumber || (idx + 1);

    const imagePath = scene.imagePath;
    if (!imagePath) {
      logWarning(`Scene ${sceneNum} has no imagePath. Skipping video generation.`);
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
    logInfo(`Duration: ${duration}s, Resolution: ${appConfig.width}x${appConfig.height}`);

    try {
      logInfo("Queueing video generation...");
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
      await fs.writeFile(finalOutputPath, JSON.stringify(storyData, null, 2), "utf-8");
      logInfo(`Saved progress to: ${finalOutputPath}`);
    } catch (err: any) {
      logError(`Failed to generate video for scene ${sceneNum}: ${err.message}`);
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
