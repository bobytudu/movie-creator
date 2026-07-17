import { serve } from "bun";
import * as fs from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";
import { config } from "dotenv";
import { callOllama } from "./src/config.ts";

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
        const body = (await req.json()) as any;
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
        if (description !== undefined) {
          scene.description = description;

          // Regenerate imagePrompt using Ollama based on the updated scene description
          try {
            const characters = JSON.stringify(storyData.characters, null, 2);
            const style = storyData.style || "realistic";
            const setting = scene.setting || "";
            const systemPrompt = `You are a professional storyboard artist.
Given the following scene setting, scene action description, visual style, and character profiles, generate a highly detailed, single-paragraph image generation prompt containing camera direction, lighting, setting details, character names with their exact looks, poses, and expressions.
Visual style: ${style}
Characters: ${characters}
Scene Setting: ${setting}
Scene Action Description: ${description}

CRITICAL Instructions:
1. The prompt must be a single paragraph.
2. Incorporate character looks and style-specific descriptors.
3. Characters MUST NEVER look directly at the camera or viewer.
4. Return ONLY the raw image generation prompt paragraph. Do not add explanation, JSON, markdown formatting, or intro text.`;

            console.log(`[Server] Generating new imagePrompt for scene ${sceneNumber} due to description update...`);
            const responsePrompt = await callOllama([
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Generate the image prompt.` }
            ], false);
            if (responsePrompt && typeof responsePrompt === "string") {
              scene.imagePrompt = responsePrompt.trim();
              console.log(`[Server] New imagePrompt generated: "${scene.imagePrompt.substring(0, 100)}..."`);
            }
          } catch (err: any) {
            console.error(`[Server] Failed to regenerate imagePrompt after description update: ${err.message}`);
          }
        }

        // Save updated assets
        await fs.writeFile(storyAssetsPath, JSON.stringify(storyData, null, 2), "utf-8");

        // Try updating main story manifest (story_output.json) to keep in sync
        try {
          const mainContent = await fs.readFile(storyPath, "utf-8");
          const mainStory = JSON.parse(mainContent);
          const mainScene = mainStory.scenes.find((s: any) => s.sceneNumber === sceneNumber);
          if (mainScene) {
            if (script !== undefined) mainScene.script = script;
            if (description !== undefined) {
              mainScene.description = description;
              mainScene.imagePrompt = scene.imagePrompt;
            }
            await fs.writeFile(storyPath, JSON.stringify(mainStory, null, 2), "utf-8");
          }
        } catch {
          // Non-fatal if story_output.json doesn't exist/fails
        }

        return new Response(JSON.stringify({ success: true, story: storyData }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // 2.5 POST /api/scene/enhance
      if (req.method === "POST" && pathname === "/api/scene/enhance") {
        const body = (await req.json()) as any;
        const { sceneNumber, type, text } = body; // type is 'script' | 'description'
        if (sceneNumber === undefined || !type || text === undefined) {
          return new Response(JSON.stringify({ error: "Missing sceneNumber, type, or text" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        console.log(`[Server] Enhancing ${type} for scene ${sceneNumber} using Ollama...`);

        let systemPrompt = "";
        if (type === "description") {
          systemPrompt = `You are a professional cinematic director and screenwriter.
Your task is to take an existing scene action description and enhance it with vivid, sensory, and cinematic details to make it highly evocative, dramatic, and clear.
Keep it relatively concise (1-3 sentences) but highly descriptive.
Do not describe camera angles or technical camera terms here, just focus on the action, environment, emotions, and character poses.
Return ONLY the raw enhanced description. Do not add explanations, intro text, markdown formatting, or JSON. Just return the enhanced text.`;
        } else if (type === "script") {
          systemPrompt = `You are a professional screenwriter.
Your task is to take an existing dialogue or narration script and enhance it to make it more natural, engaging, and dialogue-appropriate for the scene.
Ensure it is written in speaker format, e.g. [Character Name]: Dialogue. Or [Narrator]: Dialogue/Text.
Keep it extremely short and concise (at most 1-2 short sentences, maximum 15 words) so that it can be spoken in under 5-8 seconds.
Return ONLY the raw enhanced script. Do not add explanations, intro text, markdown formatting, or JSON. Just return the enhanced text.`;
        } else {
          return new Response(JSON.stringify({ error: `Invalid type: ${type}` }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        try {
          const responseText = await callOllama([
            { role: "system", content: systemPrompt },
            { role: "user", content: `Original ${type}: "${text}"` }
          ], false);

          if (responseText && typeof responseText === "string") {
            const enhancedText = responseText.trim().replace(/^"|"$/g, ""); // Strip surrounding quotes if any
            return new Response(JSON.stringify({ success: true, enhancedText }), {
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          } else {
            throw new Error("Ollama returned an empty response.");
          }
        } catch (err: any) {
          console.error(`[Server] Failed to enhance ${type} via Ollama: ${err.message}`);
          return new Response(JSON.stringify({ error: `Failed to enhance via Ollama: ${err.message}` }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
      }

      // 2.7 POST /api/scene/chat
      if (req.method === "POST" && pathname === "/api/scene/chat") {
        const body = (await req.json()) as any;
        const { sceneNumber, instruction } = body;
        if (sceneNumber === undefined || !instruction) {
          return new Response(JSON.stringify({ error: "Missing sceneNumber or instruction" }), {
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

        console.log(`[Server] Modifying scene ${sceneNumber} with instruction: "${instruction}"`);

        const style = storyData.style || "realistic";
        const systemPrompt = `You are a professional screenwriter and storyboard script editor.
You will be given:
1. The overall story premise and characters.
2. The visual style of the story: "${style}".
3. The current details of a specific scene (Setting, Visual Action Description, and Dialogue/Narration Script).
4. An instruction from the user specifying modifications they want to make to this specific scene (e.g. adding objects, modifying actions, changing dialogue).

Your task is to modify the scene's Visual Action Description and/or Dialogue/Narration Script to incorporate the user's requested instruction while maintaining consistency with characters, setting, and style.
Keep the updated Visual Action Description detailed but concise.
Keep the updated Dialogue/Narration Script extremely short (under 15 words) and formatted as speaker lines like [Character Name]: Dialogue or [Narrator]: Narration.

You must output a JSON object adhering strictly to this schema:
{
  "description": "The updated cinematic visual action description",
  "script": "The updated dialogue or narration script"
}

Only return a raw, valid JSON object.`;

        const userPrompt = `Story Premise: ${storyData.premise || ""}
Characters: ${JSON.stringify(storyData.characters || [], null, 2)}
Scene Number: ${sceneNumber}
Scene Setting: ${scene.setting || ""}
Current Visual Action Description: "${scene.description || ""}"
Current Dialogue/Narration Script: "${scene.script || ""}"

User Edit Request Instruction: "${instruction}"`;

        try {
          const response = await callOllama([
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ], true); // jsonMode = true

          if (response && response.description !== undefined && response.script !== undefined) {
            scene.description = response.description;
            scene.script = response.script;

            // Regenerate imagePrompt using Ollama based on the updated scene description
            try {
              const systemPromptImage = `You are a professional storyboard artist.
Given the following scene setting, scene action description, visual style, and character profiles, generate a highly detailed, single-paragraph image generation prompt containing camera direction, lighting, setting details, character names with their exact looks, poses, and expressions.
Visual style: ${style}
Characters: ${JSON.stringify(storyData.characters || [], null, 2)}
Scene Setting: ${scene.setting || ""}
Scene Action Description: ${scene.description}

CRITICAL Instructions:
1. The prompt must be a single paragraph.
2. Incorporate character looks and style-specific descriptors.
3. Characters MUST NEVER look directly at the camera or viewer.
4. Return ONLY the raw image generation prompt paragraph. Do not add explanation, JSON, markdown formatting, or intro text.`;

              console.log(`[Server] Generating new imagePrompt for scene ${sceneNumber} due to AI chat update...`);
              const responsePrompt = await callOllama([
                { role: 'system', content: systemPromptImage },
                { role: 'user', content: `Generate the image prompt.` }
              ], false);
              if (responsePrompt && typeof responsePrompt === "string") {
                scene.imagePrompt = responsePrompt.trim();
                console.log(`[Server] New imagePrompt generated: "${scene.imagePrompt.substring(0, 100)}..."`);
              }
            } catch (err: any) {
              console.error(`[Server] Failed to regenerate imagePrompt after AI chat update: ${err.message}`);
            }

            // Save updated assets
            await fs.writeFile(storyAssetsPath, JSON.stringify(storyData, null, 2), "utf-8");

            // Sync with story_output.json
            try {
              const mainContent = await fs.readFile(storyPath, "utf-8");
              const mainStory = JSON.parse(mainContent);
              const mainScene = mainStory.scenes.find((s: any) => s.sceneNumber === sceneNumber);
              if (mainScene) {
                mainScene.description = scene.description;
                mainScene.script = scene.script;
                mainScene.imagePrompt = scene.imagePrompt;
                await fs.writeFile(storyPath, JSON.stringify(mainStory, null, 2), "utf-8");
              }
            } catch {}

            return new Response(JSON.stringify({ success: true, story: storyData }), {
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          } else {
            throw new Error("Invalid response format from Ollama.");
          }
        } catch (err: any) {
          console.error(`[Server] Failed to process AI chat instruction for scene ${sceneNumber}: ${err.message}`);
          return new Response(JSON.stringify({ error: `Failed to process AI chat instruction: ${err.message}` }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
      }

      // 3. POST /api/scene/regenerate
      if (req.method === "POST" && pathname === "/api/scene/regenerate") {
        const body = (await req.json()) as any;
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

      // 3.5 POST /api/story/merge
      if (req.method === "POST" && pathname === "/api/story/merge") {
        console.log("[Server] Manual video merge requested.");
        try {
          await runVideoMerge();
          const fileContent = await fs.readFile(storyAssetsPath, "utf-8");
          const storyData = JSON.parse(fileContent);
          storyData.outputDir = outputDir;
          storyData.mergedVideoPath = `${outputDir}/video/merged_output.mp4`.replace(/\\/g, "/");
          return new Response(JSON.stringify({ success: true, story: storyData }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        } catch (err: any) {
          console.error(`[Server] Manual video merge failed: ${err.message}`);
          return new Response(JSON.stringify({ error: `Manual video merge failed: ${err.message}` }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
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
