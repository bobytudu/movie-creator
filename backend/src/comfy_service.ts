import * as fs from "fs/promises";
import * as path from "path";
import { config } from "dotenv";

import { spawn } from "child_process";

config(); // Load environment variables

export function getBaseDescription(desc: string): string {
  return (desc || "").replace(/\s*\(Part\s+\d+\)$/i, "").trim();
}

export function areScenesConnected(scene: any, prevScene: any): boolean {
  if (!prevScene) return false;
  return scene.sameCameraAngle === true;
}

export async function extractLastFrame(videoPath: string, outputPath: string): Promise<void> {
  console.log(`[Video Service] Extracting last frame of ${videoPath} to ${outputPath}...`);
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-sseof", "-0.1", "-i", videoPath, "-update", "1", "-q:v", "1", outputPath], {
      stdio: "inherit",
      shell: true
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg extraction exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

export const COMFYUI_URL = process.env.COMFYUI_URL || "http://127.0.0.1:8188";
export const outputDir = process.env.output_dir || "";

// Absolute paths to JSON manifests and templates
const imageTemplatePath = path.resolve(process.cwd(), "workflow", "image_flux2_text_to_image.json");
const videoTemplatePath = path.resolve(process.cwd(), "workflow", "video_ltx2_3_i2v.json");

/**
 * Checks if ComfyUI is reachable
 */
export async function checkComfyReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${COMFYUI_URL}/prompt`);
    return res.status === 405 || res.ok;
  } catch {
    return false;
  }
}

/**
 * Queues workflow json to ComfyUI
 */
export async function queueWorkflow(workflow: any, clientId?: string): Promise<string> {
  console.log(`[Server] Queueing workflow to ComfyUI with client_id: "${clientId || ""}"`);
  const payload: any = { prompt: workflow };
  if (clientId) {
    payload.client_id = clientId;
  }
  const response = await fetch(`${COMFYUI_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
 * Polls prompt ID until completion
 */
export async function pollPromptCompletion(promptId: string): Promise<any> {
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
              return entry;
            } else {
              throw new Error(`ComfyUI generation failed: ${JSON.stringify(status)}`);
            }
          }
          return entry;
        }
      }
    } catch (err: any) {
      if (err.message && err.message.includes("ComfyUI generation failed")) {
        throw err;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * Extracts output file path from completed history entry
 */
export function extractFileFromHistory(historyEntry: any, nodeId: string): { filename: string; absolutePath: string } {
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
 * Standard text-to-image Flux2 generation for a single scene
 */
export async function generateImageForScene(scene: any, style: string, width: number, height: number, clientId?: string): Promise<string> {
  const imageWorkflowContent = await fs.readFile(imageTemplatePath, "utf-8");
  const imageWorkflow = JSON.parse(imageWorkflowContent);

  // Set resolution
  if (imageWorkflow["98:48"]?.inputs) {
    imageWorkflow["98:48"].inputs.width = width;
    imageWorkflow["98:48"].inputs.height = height;
  }
  if (imageWorkflow["98:47"]?.inputs) {
    imageWorkflow["98:47"].inputs.width = width;
    imageWorkflow["98:47"].inputs.height = height;
  }

  // Set positive prompt text
  if (imageWorkflow["98:6"]?.inputs) {
    imageWorkflow["98:6"].inputs.text = scene.imagePrompt;
  } else {
    throw new Error("Could not find positive prompt node '98:6' in image workflow.");
  }

  // Randomize seed
  if (imageWorkflow["98:25"]?.inputs) {
    imageWorkflow["98:25"].inputs.noise_seed = Math.floor(Math.random() * 1000000000000000);
  }

  console.log(`[Server] Generating image for scene ${scene.sceneNumber}...`);
  const promptId = await queueWorkflow(imageWorkflow, clientId);
  const history = await pollPromptCompletion(promptId);
  const result = extractFileFromHistory(history, "9");
  return result.absolutePath;
}

/**
 * Image-to-video LTX2.3 generation for a single scene
 */
export async function generateVideoForScene(scene: any, style: string, width: number, height: number, clientId?: string): Promise<string> {
  const videoWorkflowContent = await fs.readFile(videoTemplatePath, "utf-8");
  const videoWorkflow = JSON.parse(videoWorkflowContent);

  // Set resolution
  if (videoWorkflow["320:312"]?.inputs) {
    videoWorkflow["320:312"].inputs.value = width;
  } else {
    throw new Error("Could not find width node '320:312' in video workflow.");
  }
  if (videoWorkflow["320:299"]?.inputs) {
    videoWorkflow["320:299"].inputs.value = height;
  } else {
    throw new Error("Could not find height node '320:299' in video workflow.");
  }

  // Set input image path
  if (videoWorkflow["269"]?.inputs) {
    videoWorkflow["269"].inputs.image = scene.imagePath;
  } else {
    throw new Error("Could not find LoadImage node '269' in video workflow.");
  }

  // Set positive prompt text (script/dialogue + realistic camera modifiers)
  let videoPrompt = scene.script 
    ? `${scene.imagePrompt}\n\nAudio/Dialogue:\n${scene.script}`
    : scene.voiceover
      ? `${scene.imagePrompt}\n\nAudio/Dialogue:\n${scene.voiceover}`
      : scene.imagePrompt;

  videoPrompt += "\n\nRealistic, natural, lifelike movement speed for all characters and animals. They move naturally at real-time speeds, behave like living beings with realistic weight and physics. Camera movement is a handheld camera look, realistic lens breathing, natural subtle camera shake, professional documentary camera operator feel.";
  videoPrompt += "\n\nadd some movement in the video/scene, characters, objects camera movements etc,";

  if (videoWorkflow["320:319"]?.inputs) {
    videoWorkflow["320:319"].inputs.value = videoPrompt;
  } else {
    throw new Error("Could not find prompt value node '320:319' in video workflow.");
  }

  // Set duration
  const duration = scene.duration || 6;
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

  console.log(`[Server] Generating video for scene ${scene.sceneNumber}...`);
  const promptId = await queueWorkflow(videoWorkflow, clientId);
  const history = await pollPromptCompletion(promptId);
  const result = extractFileFromHistory(history, "75");
  return result.absolutePath;
}
