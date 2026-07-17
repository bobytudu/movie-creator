/**
 * websockets_api_example.ts — Monitor execution via WebSocket, download via /history.
 * 
 * TypeScript implementation of the ComfyUI WebSocket API client example.
 */

import { Buffer } from "buffer";
import * as fs from "fs/promises";
import * as path from "path";

const SERVER_ADDRESS = "127.0.0.1:8188";
const clientId = crypto.randomUUID();

/**
 * Queue a prompt workflow to the ComfyUI server.
 */
async function queuePrompt(prompt: any, promptId: string): Promise<void> {
  const payload = {
    prompt,
    client_id: clientId,
    prompt_id: promptId
  };

  const response = await fetch(`http://${SERVER_ADDRESS}/prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP error queueing prompt: ${response.status} - ${errorText}`);
  }
}

/**
 * Get binary image data from the ComfyUI view API.
 */
async function getImage(filename: string, subfolder: string, folderType: string): Promise<Buffer> {
  const params = new URLSearchParams({
    filename,
    subfolder,
    type: folderType
  });

  const response = await fetch(`http://${SERVER_ADDRESS}/view?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`HTTP error downloading image: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Get prompt history containing details about the outputs.
 */
async function getHistory(promptId: string): Promise<any> {
  const response = await fetch(`http://${SERVER_ADDRESS}/history/${promptId}`);
  if (!response.ok) {
    throw new Error(`HTTP error getting history: ${response.status}`);
  }
  return await response.json();
}

/**
 * Wait for prompt execution using the WebSocket, then retrieve and return generated images.
 */
async function getImages(ws: WebSocket, prompt: any): Promise<Record<string, Buffer[]>> {
  const promptId = crypto.randomUUID();
  
  // Register message listener to track execution status
  const executionFinished = new Promise<void>((resolve, reject) => {
    const handleMessage = (event: MessageEvent) => {
      // event.data can be a string (JSON progress/status) or binary (previews)
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "executing") {
            const data = message.data;
            // Node being null indicates execution is complete
            if (data.node === null && data.prompt_id === promptId) {
              cleanup();
              resolve();
            }
          }
        } catch (e) {
          // Ignore parse errors for non-JSON text messages
        }
      }
    };

    const handleError = (error: Event) => {
      cleanup();
      reject(new Error("WebSocket error during execution"));
    };

    const handleClose = () => {
      cleanup();
      reject(new Error("WebSocket closed during execution"));
    };

    const cleanup = () => {
      ws.removeEventListener("message", handleMessage);
      ws.removeEventListener("error", handleError);
      ws.removeEventListener("close", handleClose);
    };

    ws.addEventListener("message", handleMessage);
    ws.addEventListener("error", handleError);
    ws.addEventListener("close", handleClose);
  });

  // Queue prompt after registering the listener to avoid missing any websocket events
  await queuePrompt(prompt, promptId);

  // Wait for the websocket to signal completion
  await executionFinished;

  // Retrieve results from history
  const historyData = await getHistory(promptId);
  const history = historyData[promptId];
  if (!history) {
    throw new Error(`No history found for prompt_id: ${promptId}`);
  }

  const outputImages: Record<string, Buffer[]> = {};
  const outputs = history.outputs || {};

  for (const nodeId of Object.keys(outputs)) {
    const nodeOutput = outputs[nodeId];
    const imagesOutput: Buffer[] = [];

    if (nodeOutput && Array.isArray(nodeOutput.images)) {
      for (const image of nodeOutput.images) {
        const imageData = await getImage(
          image.filename,
          image.subfolder || "",
          image.type || ""
        );
        imagesOutput.push(imageData);
      }
    }
    outputImages[nodeId] = imagesOutput;
  }

  return outputImages;
}

/**
 * Connect to the ComfyUI WebSocket endpoint and return the connected socket.
 */
function connectWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);

    const handleOpen = () => {
      cleanup();
      resolve(ws);
    };

    const handleError = (error: Event) => {
      cleanup();
      reject(new Error(`Failed to connect to WebSocket`));
    };

    const cleanup = () => {
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("error", handleError);
    };

    ws.addEventListener("open", handleOpen);
    ws.addEventListener("error", handleError);
  });
}

// Main execution flow
async function main() {
  // A template schema matching the Python script structure.
  // In usage, replace this with your actual ComfyUI API JSON workflow prompt.
  const promptText = `{
    "3": {
      "inputs": {
        "seed": 0
      }
    },
    "6": {
      "inputs": {
        "text": ""
      }
    },
    "9": {
      "class_type": "SaveImage",
      "inputs": {}
    }
  }`;

  const prompt = JSON.parse(promptText);
  if (prompt["3"]?.inputs) {
    prompt["3"].inputs.seed = 5;
  }
  if (prompt["6"]?.inputs) {
    prompt["6"].inputs.text = "masterpiece best quality man";
  }

  console.log(`Connecting to WebSocket at ws://${SERVER_ADDRESS}/ws?clientId=${clientId}...`);
  const ws = await connectWebSocket(`ws://${SERVER_ADDRESS}/ws?clientId=${clientId}`);
  console.log("WebSocket connected. Queueing workflow and waiting for images...");

  try {
    const images = await getImages(ws, prompt);
    console.log(`Got ${Object.keys(images).length} output node(s) with images.`);

    // Display / save the images (equivalent to PIL image.show() in Python):
    /*
    for (const nodeId of Object.keys(images)) {
      const nodeImages = images[nodeId]!;
      for (let i = 0; i < nodeImages.length; i++) {
        const filename = `node_${nodeId}_output_${i}.png`;
        await fs.writeFile(filename, nodeImages[i]!);
        console.log(`Saved output image to ${filename}`);
      }
    }
    */
  } catch (error) {
    console.error("Error during execution:", error);
  } finally {
    ws.close();
    console.log("WebSocket connection closed.");
  }
}

// Run the script
main().catch((err) => {
  console.error("Fatal error:", err);
});
