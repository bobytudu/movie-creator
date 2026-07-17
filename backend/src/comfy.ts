import * as fs from "fs/promises";
import * as path from "path";

// State variables for tracking index of generated images
let nextImageIndex = 1;
const namingPattern = {
  hasLeadingUnderscore: true,
  hasTrailingUnderscore: true
};

const outputDir = process.env.output_dir || "";

/**
 * Scan the ComfyUI output directory to detect the highest index and pattern
 * for files matching 'Flux2_dev*.png'.
 */
export async function initializeImageCounter(): Promise<void> {
  if (!outputDir) {
    console.warn("\x1b[33m[ComfyUI] Warning: output_dir is not defined in .env file. Defaulting to index 1.\x1b[0m");
    nextImageIndex = 1;
    return;
  }

  try {
    const files = await fs.readdir(outputDir);
    let maxIndex = 0;

    for (const file of files) {
      const match = file.match(/^Flux2_dev(_?)(\d+)(_?)\.png$/i);
      if (match) {
        const num = parseInt(match[2]!, 10);
        if (num > maxIndex) {
          maxIndex = num;
          namingPattern.hasLeadingUnderscore = match[1] === "_";
          namingPattern.hasTrailingUnderscore = match[3] === "_";
        }
      }
    }

    nextImageIndex = maxIndex + 1;
    console.log(
      `\x1b[34m[ComfyUI] Detected highest existing image index: ${maxIndex}. Next image will be index ${nextImageIndex} using pattern: Flux2_dev${namingPattern.hasLeadingUnderscore ? "_" : ""}[number]${namingPattern.hasTrailingUnderscore ? "_" : ""}.png\x1b[0m`
    );
  } catch (error: any) {
    console.error(`\x1b[33m[ComfyUI] Failed to read output directory for image counter: ${error.message || error}\x1b[0m`);
    nextImageIndex = 1;
  }
}

/**
 * Helper to queue a video generation prompt to ComfyUI.
 */
export async function sendVideoPrompt(imagePath: string, promptText: string, duration: number): Promise<void> {
  try {
    const templatePath = path.join(process.cwd(), "workflow", "video_ltx2_3_i2v.json");
    const templateContent = await fs.readFile(templatePath, "utf-8");
    const workflow = JSON.parse(templateContent);

    // Set image path in node "269" (LoadImage)
    if (workflow["269"] && workflow["269"].inputs) {
      workflow["269"].inputs.image = imagePath;
    } else {
      console.warn("\x1b[33m[ComfyUI] Warning: Node '269' with 'inputs.image' not found in template workflow JSON.\x1b[0m");
    }

    // Set the prompt text in node "320:319" (PrimitiveStringMultiline)
    if (workflow["320:319"] && workflow["320:319"].inputs) {
      workflow["320:319"].inputs.value = promptText + "\n\nRealistic, natural, lifelike movement speed for all characters and animals. They move naturally at real-time speeds, behave like living beings with realistic weight and physics. Camera movement is a handheld camera look, realistic lens breathing, natural subtle camera shake, professional documentary camera operator feel.";
    } else {
      console.warn("\x1b[33m[ComfyUI] Warning: Node '320:319' with 'inputs.value' not found in template workflow JSON.\x1b[0m");
    }

    // Set the duration in node "320:301" (PrimitiveInt)
    if (workflow["320:301"] && workflow["320:301"].inputs) {
      workflow["320:301"].inputs.value = duration;
    } else {
      console.warn("\x1b[33m[ComfyUI] Warning: Node '320:301' with 'inputs.value' not found in template workflow JSON.\x1b[0m");
    }

    // Randomize seeds in "320:276" and "320:277" (RandomNoise)
    const randomSeed1 = Math.floor(Math.random() * 1000000000000000);
    const randomSeed2 = Math.floor(Math.random() * 1000000000000000);
    if (workflow["320:276"] && workflow["320:276"].inputs) {
      workflow["320:276"].inputs.noise_seed = randomSeed1;
    }
    if (workflow["320:277"] && workflow["320:277"].inputs) {
      workflow["320:277"].inputs.noise_seed = randomSeed2;
    }

    const payload = {
      prompt: workflow
    };

    console.log(`\x1b[34m[ComfyUI] Queueing video prompt for image: "${imagePath}" (duration: ${duration}s)\x1b[0m`);

    const response = await fetch("http://127.0.0.1:8188/prompt", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! Status: ${response.status} - ${errorText}`);
    }

    const result = (await response.json()) as { prompt_id: string };
    console.log(`\x1b[32m[ComfyUI] Video prompt successfully queued. Prompt ID: ${result.prompt_id}\x1b[0m`);
  } catch (error: any) {
    console.error(`\x1b[33m[ComfyUI] Could not send video prompt to ComfyUI:\x1b[0m`, error.message || error);
  }
}

/**
 * Helper to queue an image prompt to ComfyUI.
 * It reads the workflow template, replaces the positive prompt text,
 * randomizes the seed, and POSTs to the ComfyUI API.
 * Then it automatically calculates the output filename and queues
 * a corresponding video generation.
 * 
 * @param promptText The image description prompt to generate
 * @param duration Duration of the generated video in seconds (default: 6)
 */
export async function sendImagePrompt(promptText: string, duration: number = 6): Promise<void> {
  try {
    const templatePath = path.join(process.cwd(), "workflow", "image_flux2_text_to_image.json");
    const templateContent = await fs.readFile(templatePath, "utf-8");
    const workflow = JSON.parse(templateContent);

    // Set the prompt text in node "98:6" (CLIPTextEncode positive prompt)
    if (workflow["98:6"] && workflow["98:6"].inputs) {
      workflow["98:6"].inputs.text = promptText;
    } else {
      console.warn("\x1b[33m[ComfyUI] Warning: Node '98:6' with 'inputs.text' not found in template workflow JSON.\x1b[0m");
    }

    // Randomize the image seed in node "98:25"
    if (workflow["98:25"] && workflow["98:25"].inputs) {
      workflow["98:25"].inputs.noise_seed = Math.floor(Math.random() * 1000000000000000);
    }

    const payload = {
      prompt: workflow
    };

    console.log(`\x1b[34m[ComfyUI] Queueing prompt: "${promptText.substring(0, 70)}..."\x1b[0m`);
    
    const response = await fetch("http://127.0.0.1:8188/prompt", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! Status: ${response.status} - ${errorText}`);
    }

    const result = (await response.json()) as { prompt_id: string };
    console.log(`\x1b[32m[ComfyUI] Prompt successfully queued. Prompt ID: ${result.prompt_id}\x1b[0m`);

    // Determine the expected image filename that ComfyUI will write
    const currentIndex = nextImageIndex;
    nextImageIndex++;

    const leading = namingPattern.hasLeadingUnderscore ? "_" : "";
    const trailing = namingPattern.hasTrailingUnderscore ? "_" : "";
    const pad = (num: number, size: number) => num.toString().padStart(size, '0');
    const imageName = `Flux2_dev${leading}${pad(currentIndex, 5)}${trailing}.png`;
    const imagePath = path.join(outputDir, imageName);

    // Queue the video prompt referencing this filename
    await sendVideoPrompt(imagePath, promptText, duration);
  } catch (error: any) {
    console.error(`\x1b[33m[ComfyUI] Could not send prompt to ComfyUI (is it running at 127.0.0.1:8188?):\x1b[0m`, error.message || error);
  }
}

/**
 * Helper to queue a BGM generation prompt to ComfyUI.
 * It reads the audio workflow template, replaces the tags text,
 * clears the lyrics text, randomizes the seeds, and POSTs to the ComfyUI API.
 * 
 * @param bgmPromptText The background music description/prompt to generate
 */
export async function sendBgmPrompt(bgmPromptText: string, duration: number): Promise<void> {
  try {
    const templatePath = path.join(process.cwd(), "workflow", "audio_ace_step_1_5_checkpoint.json");
    const templateContent = await fs.readFile(templatePath, "utf-8");
    const workflow = JSON.parse(templateContent);

    // Set the BGM description prompt text in node "94" inputs.tags, and clear lyrics
    if (workflow["94"] && workflow["94"].inputs) {
      workflow["94"].inputs.tags = bgmPromptText;
      workflow["94"].inputs.lyrics = "";
      workflow["94"].inputs.duration = duration;
      
      // Randomize the seeds
      const randomSeed = Math.floor(Math.random() * 1000000000000000);
      workflow["94"].inputs.seed = randomSeed;
      if (workflow["3"] && workflow["3"].inputs) {
        workflow["3"].inputs.seed = randomSeed;
      }
    } else {
      console.warn("\x1b[33m[ComfyUI] Warning: Node '94' with 'inputs.tags' not found in template workflow JSON.\x1b[0m");
    }

    const payload = {
      prompt: workflow
    };

    console.log(`\x1b[34m[ComfyUI] Queueing BGM prompt: "${bgmPromptText.substring(0, 70)}..."\x1b[0m`);
    
    const response = await fetch("http://127.0.0.1:8188/prompt", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! Status: ${response.status} - ${errorText}`);
    }

    const result = (await response.json()) as { prompt_id: string };
    console.log(`\x1b[32m[ComfyUI] BGM prompt successfully queued. Prompt ID: ${result.prompt_id}\x1b[0m`);
  } catch (error: any) {
    console.error(`\x1b[33m[ComfyUI] Could not send BGM prompt to ComfyUI (is it running at 127.0.0.1:8188?):\x1b[0m`, error.message || error);
  }
}

