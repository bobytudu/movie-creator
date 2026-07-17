import { serve } from "bun";
import * as fs from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";
import { config } from "dotenv";

config(); // Load environment variables

const PORT = 3001;
const COMFYUI_URL = process.env.COMFYUI_URL || "http://127.0.0.1:8188";
const outputDir = process.env.output_dir || "";

// Absolute paths to JSON manifests and templates
const storyAssetsPath = path.resolve(process.cwd(), "story_output_assets.json");
const storyPath = path.resolve(process.cwd(), "story_output.json");
const imageTemplatePath = path.resolve(process.cwd(), "workflow", "image_flux2_text_to_image.json");
const videoTemplatePath = path.resolve(process.cwd(), "workflow", "video_ltx2_3_i2v.json");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Checks if ComfyUI is reachable
 */
async function checkComfyReachable(): Promise<boolean> {
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
async function queueWorkflow(workflow: any, clientId?: string): Promise<string> {
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
async function pollPromptCompletion(promptId: string): Promise<any> {
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
 * Triggers video merge script (merge_videos.ts)
 */
async function runVideoMerge(): Promise<void> {
  console.log("[Server] Running video merge script...");
  return new Promise<void>((resolve, reject) => {
    const child = spawn("bun", ["src/merge_videos.ts"], { stdio: "inherit", shell: true });
    child.on("close", (code) => {
      if (code === 0) {
        console.log("[Server] Video merge successfully completed.");
        resolve();
      } else {
        reject(new Error(`Video merge exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

/**
 * Standard text-to-image Flux2 generation for a single scene
 */
async function generateImageForScene(scene: any, style: string, width: number, height: number, clientId?: string): Promise<string> {
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
async function generateVideoForScene(scene: any, style: string, width: number, height: number, clientId?: string): Promise<string> {
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

// Start Server
serve({
  port: PORT,
  idleTimeout: 255, // 255 seconds max supported by Bun
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 1. GET /api/story
      if (req.method === "GET" && pathname === "/api/story") {
        try {
          const fileContent = await fs.readFile(storyAssetsPath, "utf-8");
          const storyData = JSON.parse(fileContent);
          storyData.outputDir = outputDir;
          storyData.mergedVideoPath = `${outputDir}/video/merged_output.mp4`.replace(/\\/g, "/");
          return new Response(JSON.stringify(storyData), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: `Failed to load story assets: ${err.message}` }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
      }

      // 2. POST /api/scene/update
      if (req.method === "POST" && pathname === "/api/scene/update") {
        const body = await req.json();
        const { sceneNumber, script, description } = body;
        if (sceneNumber === undefined || (script === undefined && description === undefined)) {
          return new Response(JSON.stringify({ error: "Missing sceneNumber, script, or description" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        const fileContent = await fs.readFile(storyAssetsPath, "utf-8");
        const storyData = JSON.parse(fileContent);

        const scene = storyData.scenes.find((s: any) => s.sceneNumber === sceneNumber);
        if (!scene) {
          return new Response(JSON.stringify({ error: `Scene ${sceneNumber} not found` }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        if (script !== undefined) scene.script = script;
        if (description !== undefined) scene.description = description;

        // Save updated assets
        await fs.writeFile(storyAssetsPath, JSON.stringify(storyData, null, 2), "utf-8");

        // Try updating main story manifest (story_output.json) to keep in sync
        try {
          const mainContent = await fs.readFile(storyPath, "utf-8");
          const mainStory = JSON.parse(mainContent);
          const mainScene = mainStory.scenes.find((s: any) => s.sceneNumber === sceneNumber);
          if (mainScene) {
            if (script !== undefined) mainScene.script = script;
            if (description !== undefined) mainScene.description = description;
            await fs.writeFile(storyPath, JSON.stringify(mainStory, null, 2), "utf-8");
          }
        } catch {
          // Non-fatal if story_output.json doesn't exist/fails
        }

        return new Response(JSON.stringify({ success: true, story: storyData }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // 3. POST /api/scene/regenerate
      if (req.method === "POST" && pathname === "/api/scene/regenerate") {
        const body = await req.json();
        const { sceneNumber, type, clientId } = body; // type is 'image' | 'video' | 'both'
        if (sceneNumber === undefined || !type) {
          return new Response(JSON.stringify({ error: "Missing sceneNumber or type" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // Verify ComfyUI is up
        const isComfyRunning = await checkComfyReachable();
        if (!isComfyRunning) {
          return new Response(
            JSON.stringify({ error: `ComfyUI is unreachable at ${COMFYUI_URL}. Please ensure ComfyUI is running.` }),
            {
              status: 503,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            }
          );
        }

        const fileContent = await fs.readFile(storyAssetsPath, "utf-8");
        const storyData = JSON.parse(fileContent);

        const scene = storyData.scenes.find((s: any) => s.sceneNumber === sceneNumber);
        if (!scene) {
          return new Response(JSON.stringify({ error: `Scene ${sceneNumber} not found` }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // Get application resolution settings from config.json
        let configData = { style: "realistic", width: 1280, height: 720 };
        try {
          const confContent = await fs.readFile(path.resolve(process.cwd(), "config.json"), "utf-8");
          const parsed = JSON.parse(confContent);
          configData.style = parsed.style || configData.style;
          if (parsed.resolution) {
            const match = parsed.resolution.match(/^(\d+)x(\d+)$/i);
            if (match && match[1] && match[2]) {
              configData.width = parseInt(match[1], 10);
              configData.height = parseInt(match[2], 10);
            }
          }
        } catch {}

        let regeneratedImage = false;
        let regeneratedVideo = false;

        if (type === "image" || type === "both") {
          const newImagePath = await generateImageForScene(scene, configData.style, configData.width, configData.height, clientId);
          scene.imagePath = newImagePath;
          regeneratedImage = true;
        }

        if (type === "video" || type === "both") {
          if (!scene.imagePath) {
            return new Response(
              JSON.stringify({ error: `Scene ${sceneNumber} has no generated image. Generate image first.` }),
              {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders },
              }
            );
          }
          const newVideoPath = await generateVideoForScene(scene, configData.style, configData.width, configData.height, clientId);
          scene.videoPath = newVideoPath;
          regeneratedVideo = true;
        }

        // Write assets back to disk
        await fs.writeFile(storyAssetsPath, JSON.stringify(storyData, null, 2), "utf-8");

        // Sync with story_output.json if present
        try {
          const mainContent = await fs.readFile(storyPath, "utf-8");
          const mainStory = JSON.parse(mainContent);
          const mainScene = mainStory.scenes.find((s: any) => s.sceneNumber === sceneNumber);
          if (mainScene) {
            if (regeneratedImage) mainScene.imagePath = scene.imagePath;
            if (regeneratedVideo) mainScene.videoPath = scene.videoPath;
            await fs.writeFile(storyPath, JSON.stringify(mainStory, null, 2), "utf-8");
          }
        } catch {}

        // If a video is regenerated, update the final movie merge file automatically
        if (regeneratedVideo) {
          try {
            await runVideoMerge();
          } catch (mergeErr: any) {
            console.error(`[Server] Automerging videos failed: ${mergeErr.message}`);
          }
        }

        return new Response(JSON.stringify({ success: true, story: storyData }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // 4. GET /api/generate/stream
      if (req.method === "GET" && pathname === "/api/generate/stream") {
        const topic = url.searchParams.get("topic") || "";
        const style = url.searchParams.get("style") || "";
        const clientId = url.searchParams.get("clientId") || "";

        const args = ["index.ts"];
        if (style) {
          args.push("--style", style);
        }
        if (topic) {
          args.push(topic);
        }
        if (clientId) {
          args.push("--clientId", clientId);
        }

        console.log(`[Server] Starting full generation with args: ${args.join(" ")}`);

        // Spawn bun index.ts process
        const child = spawn("bun", args, {
          stdout: "pipe",
          stderr: "pipe",
        });

        const stream = new ReadableStream({
          start(controller) {
            let isClosed = false;
            const sendEvent = (event: string, data: string) => {
              if (isClosed) return;
              try {
                controller.enqueue(`event: ${event}\ndata: ${data}\n\n`);
              } catch {
                isClosed = true;
              }
            };

            let stdoutDecoder = new TextDecoder();
            let stderrDecoder = new TextDecoder();

            child.stdout?.on("data", (chunk) => {
              const text = stdoutDecoder.decode(chunk);
              sendEvent("log", JSON.stringify({ type: "stdout", text }));
            });

            child.stderr?.on("data", (chunk) => {
              const text = stderrDecoder.decode(chunk);
              sendEvent("log", JSON.stringify({ type: "stderr", text }));
            });

            child.on("close", (code) => {
              if (!isClosed) {
                sendEvent("complete", JSON.stringify({ code }));
                try {
                  controller.close();
                } catch {}
                isClosed = true;
              }
            });

            child.on("error", (err) => {
              if (!isClosed) {
                sendEvent("error", JSON.stringify({ message: err.message }));
                try {
                  controller.close();
                } catch {}
                isClosed = true;
              }
            });
          },
          cancel() {
            child.kill();
          }
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            ...corsHeaders,
          },
        });
      }

      // 5. GET /api/media?path=...
      if (req.method === "GET" && pathname === "/api/media") {
        const filePath = url.searchParams.get("path");
        if (!filePath) {
          return new Response("Missing path query parameter", { status: 400, headers: corsHeaders });
        }

        const file = Bun.file(filePath);
        if (!(await file.exists())) {
          return new Response("File not found", { status: 404, headers: corsHeaders });
        }

        // Set MIME type
        const ext = path.extname(filePath).toLowerCase();
        let contentType = "application/octet-stream";
        if (ext === ".png") contentType = "image/png";
        else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
        else if (ext === ".mp4") contentType = "video/mp4";
        else if (ext === ".gif") contentType = "image/gif";

        // Enable byte range requests and set correct headers
        return new Response(file, {
          headers: {
            "Content-Type": contentType,
            ...corsHeaders,
          },
        });
      }

      // Default fallback
      return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (e: any) {
      console.error(`[Server] Error processing request ${pathname}:`, e);
      return new Response(JSON.stringify({ error: e.message || "Internal Server Error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  },
});

console.log(`[Server] Bun story assets editor backend listening on port ${PORT}...`);
