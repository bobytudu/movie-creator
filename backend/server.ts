import { serve } from "bun";

import * as fs from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";
import { config } from "dotenv";
import { Server as SocketIOServer } from "socket.io";
import { Server as BunEngine } from "@socket.io/bun-engine";
import { callOllama, loadAppConfig } from "./src/config.ts";
import {
  checkComfyReachable,
  generateImageForScene,
  generateVideoForScene,
  COMFYUI_URL,
  outputDir,
  areScenesConnected,
  extractLastFrame,
} from "./src/comfy_service.ts";
import { runVideoMerge } from "./src/video_service.ts";
import { estimateDuration } from "./src/nodes/scriptNode.ts";

config(); // Load environment variables

const PORT = 3001;

// Absolute paths to JSON manifests
const storyAssetsPath = path.resolve(process.cwd(), "story_output_assets.json");
const storyPath = path.resolve(process.cwd(), "story_output.json");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Initialize Socket.io server and bind it to Bun Engine
const io = new SocketIOServer({
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const engine = new BunEngine({
  path: "/socket.io/",
});
io.bind(engine);

io.on("connection", (socket) => {
  const clientId = (socket.handshake.query.clientId as string) || "";
  console.log(`[SocketIO] Client connected, clientId: ${clientId}, socketId: ${socket.id}`);
  
  if (!clientId) {
    console.log(`[SocketIO] Disconnecting socket ${socket.id} due to missing clientId`);
    socket.disconnect(true);
    return;
  }

  const comfyWsUrl = `${COMFYUI_URL.replace(/^http/, "ws")}/ws?clientId=${clientId}`;
  console.log(`[SocketIO] Connecting to ComfyUI WS: ${comfyWsUrl}`);

  try {
    const comfyWs = new WebSocket(comfyWsUrl);
    comfyWs.binaryType = "arraybuffer";

    comfyWs.onopen = () => {
      console.log(`[SocketIO] Connected to ComfyUI WebSocket for clientId: ${clientId}`);
    };

    comfyWs.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "progress") {
            console.log(`[SocketIO WS Progress] Node: ${msg.data?.node || ""}, Step: ${msg.data?.value || 0}/${msg.data?.max || 0}`);
          } else if (msg.type === "executing") {
            console.log(`[SocketIO WS Executing] Node: ${msg.data?.node || "Finished/None"}`);
          } else if (msg.type === "status") {
            console.log(`[SocketIO WS Status] Queue remaining: ${msg.data?.status?.exec_info?.queue_remaining ?? 0}`);
          } else {
            console.log(`[SocketIO WS Message] Type: ${msg.type}`, JSON.stringify(msg.data));
          }
        } catch (e) {
          console.log(`[SocketIO WS Text Message]`, event.data);
        }
      } else {
        const len = event.data instanceof ArrayBuffer ? event.data.byteLength : (event.data as any).size || 0;
        console.log(`[SocketIO WS Binary Message] size: ${len} bytes`);
      }
      
      // Emit event.data to the frontend client
      socket.emit("message", event.data);
    };

    comfyWs.onerror = (err) => {
      console.error(`[SocketIO] ComfyUI WS error for clientId: ${clientId}`, err);
    };

    comfyWs.onclose = () => {
      console.log(`[SocketIO] ComfyUI WS closed for clientId: ${clientId}`);
      socket.disconnect(true);
    };

    socket.on("message", (message) => {
      if (comfyWs.readyState === WebSocket.OPEN) {
        comfyWs.send(message);
      }
    });

    socket.on("disconnect", () => {
      console.log(`[SocketIO] Client disconnected: ${socket.id}, closing ComfyUI WS`);
      if (comfyWs.readyState === WebSocket.OPEN || comfyWs.readyState === WebSocket.CONNECTING) {
        comfyWs.close();
      }
    });

  } catch (err) {
    console.error(`[SocketIO] Failed to connect to ComfyUI WS for clientId: ${clientId}`, err);
    socket.disconnect(true);
  }
});

const { websocket } = engine.handler();

// Start Server
serve({
  port: PORT,
  idleTimeout: 255, // 255 seconds max supported by Bun
  async fetch(req, server) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Handle Socket.IO connection requests
    if (pathname.startsWith("/socket.io/")) {
      return engine.handleRequest(req, server);
    }

    // Commented out native WebSocket upgrade request
    /*
    if (pathname === "/ws") {
      const clientId = url.searchParams.get("clientId") || url.searchParams.get("client_id") || "";
      const success = server.upgrade(req, {
        data: { clientId }
      });
      if (success) return undefined; // Handled by Bun WebSocket server
    }
    */

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

        // Recalculate duration automatically when manually editing script or description
        scene.duration = estimateDuration(scene.script || "", scene.description || "");

        // Recalculate story duration
        const storyDuration = storyData.scenes?.reduce((acc: number, s: any) => acc + (s.duration || 0), 0) || 0;
        storyData.storyDuration = storyDuration;

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
            mainScene.duration = scene.duration;
            mainStory.storyDuration = storyDuration;
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
Your task is to take an existing dialogue script and enhance it to make it more natural, engaging, and dialogue-appropriate for the scene.
Ensure it is written in speaker format, e.g. [Character Name]: Dialogue. Do NOT use narrator voice/narration. ONLY characters should speak.
Keep it brief and dialogue-appropriate (at most 2-3 short sentences, maximum 30 words) so that it can be spoken in under 6 to 16 seconds.
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

Your task is to modify the scene's Visual Action Description and/or Dialogue Script to incorporate the user's requested instruction while maintaining consistency with characters, setting, and style.
Keep the updated Visual Action Description detailed but concise.
Keep the updated Dialogue Script brief (under 30 words), ensuring that only characters speak (do NOT use narrator voice/narration), and format it as speaker lines like [Character Name]: Dialogue.

You must output a JSON object adhering strictly to this schema:
{
  "description": "The updated cinematic visual action description",
  "script": "The updated dialogue or narration script",
  "duration": A number between 6 and 16 representing the updated scene duration in seconds based on dialogue and action
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
            scene.duration = typeof response.duration === 'number' && response.duration >= 6 && response.duration <= 16
              ? Math.round(response.duration)
              : estimateDuration(scene.script || "", scene.description || "");

            // Recalculate story duration
            const storyDuration = storyData.scenes?.reduce((acc: number, s: any) => acc + (s.duration || 0), 0) || 0;
            storyData.storyDuration = storyDuration;

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
                mainScene.duration = scene.duration;
                mainStory.storyDuration = storyDuration;
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
        const sceneNumber = body.sceneNumber;
        const type = body.type;
        const clientId = body.clientId || body.client_id || "";
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

        // Get application resolution settings
        const configData = loadAppConfig();

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

          // Check if next scene is connected and update its start frame
          const idx = storyData.scenes.findIndex((s: any) => s.sceneNumber === sceneNumber);
          if (idx !== -1 && idx + 1 < storyData.scenes.length) {
            const nextScene = storyData.scenes[idx + 1];
            if (areScenesConnected(nextScene, scene)) {
              try {
                console.log(`[Server] Next scene ${nextScene.sceneNumber} is connected. Updating its start frame from the new video last frame...`);
                const videoDir = path.dirname(newVideoPath);
                const extFramePath = path.join(videoDir, `scene_${nextScene.sceneNumber}_start_frame.png`).replace(/\\/g, "/");
                await extractLastFrame(newVideoPath, extFramePath);
                nextScene.imagePath = extFramePath;
                console.log(`[Server] Extracted and updated next scene imagePath: ${extFramePath}`);
              } catch (err: any) {
                console.error(`[Server] Failed to extract last frame for next scene: ${err.message}`);
              }
            }
          }
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
            
            // Sync next scene imagePath if updated
            const idx = storyData.scenes.findIndex((s: any) => s.sceneNumber === sceneNumber);
            if (idx !== -1 && idx + 1 < storyData.scenes.length) {
              const nextScene = storyData.scenes[idx + 1];
              if (areScenesConnected(nextScene, scene)) {
                const mainNextScene = mainStory.scenes.find((s: any) => s.sceneNumber === nextScene.sceneNumber);
                if (mainNextScene) {
                  mainNextScene.imagePath = nextScene.imagePath;
                }
              }
            }
            
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
        const clientId = url.searchParams.get("clientId") || url.searchParams.get("client_id") || "";

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
        const child = spawn("bun", args);

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
  /*
  websocket: {
    open(ws: ServerWebSocket<WebSocketData>) {
      const clientId = ws.data?.clientId || "";
      console.log(`[Proxy] Client connected, clientId: ${clientId}`);
      
      const comfyWsUrl = `${COMFYUI_URL.replace(/^http/, "ws")}/ws?clientId=${clientId}`;
      console.log(`[Proxy] Connecting to ComfyUI WS: ${comfyWsUrl}`);
      
      try {
        const comfyWs = new WebSocket(comfyWsUrl);
        comfyWs.binaryType = "arraybuffer";
        
        comfyWs.onopen = () => {
          console.log(`[Proxy] Connected to ComfyUI WebSocket for clientId: ${clientId}`);
        };

        comfyWs.addEventListener('progress ', (event) => {
          console.log(`------------------------------------`, event);
        });
        
        comfyWs.onmessage = (event) => {
          if (typeof event.data === "string") {
            try {
              const msg = JSON.parse(event.data);
              if (msg.type === "progress") {
                console.log(`[Proxy WS Progress] Node: ${msg.data?.node || ""}, Step: ${msg.data?.value || 0}/${msg.data?.max || 0}`);
              } else if (msg.type === "executing") {
                console.log(`[Proxy WS Executing] Node: ${msg.data?.node || "Finished/None"}`);
              } else if (msg.type === "status") {
                console.log(`[Proxy WS Status] Queue remaining: ${msg.data?.status?.exec_info?.queue_remaining ?? 0}`);
              } else {
                console.log(`[Proxy WS Message] Type: ${msg.type}`, JSON.stringify(msg.data));
              }
            } catch (e) {
              console.log(`[Proxy WS Text Message]`, event.data);
            }
          } else {
            const len = event.data instanceof ArrayBuffer ? event.data.byteLength : (event.data as any).size || 0;
            console.log(`[Proxy WS Binary Message] size: ${len} bytes`);
          }
          ws.send(event.data);
        };
        
        comfyWs.onerror = (err) => {
          console.error(`[Proxy] ComfyUI WS error for clientId: ${clientId}`, err);
        };
        
        comfyWs.onclose = () => {
          console.log(`[Proxy] ComfyUI WS closed for clientId: ${clientId}`);
          ws.close();
        };
        
        if (ws.data) {
          ws.data.comfyWs = comfyWs;
        }
      } catch (err) {
        console.error(`[Proxy] Failed to connect to ComfyUI WS for clientId: ${clientId}`, err);
        ws.close();
      }
    },
    message(ws: ServerWebSocket<WebSocketData>, message) {
      const comfyWs = ws.data?.comfyWs;
      if (comfyWs && comfyWs.readyState === WebSocket.OPEN) {
        comfyWs.send(message);
      }
    },
    close(ws: ServerWebSocket<WebSocketData>) {
      console.log(`[Proxy] Client disconnected, closing ComfyUI WebSocket`);
      const comfyWs = ws.data?.comfyWs;
      if (comfyWs) {
        comfyWs.close();
      }
    }
  }
  */
  websocket
});

console.log(`[Server] Bun story assets editor backend listening on port ${PORT}...`);
