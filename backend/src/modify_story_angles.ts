import * as fs from "fs/promises";
import * as path from "path";
import { callOllama } from "./config.ts";

function getBaseDescription(desc: string): string {
  return desc.replace(/\s*\(Part\s+\d+\)$/i, "").trim();
}

async function modifyManifest(filePath: string) {
  try {
    await fs.access(filePath);
  } catch {
    console.log(`Manifest not found at ${filePath}. Skipping.`);
    return;
  }

  console.log(`Modifying manifest: ${filePath}`);
  const content = await fs.readFile(filePath, "utf-8");
  const storyData = JSON.parse(content);

  if (!storyData.scenes || !Array.isArray(storyData.scenes)) {
    console.error("Invalid story structure.");
    return;
  }

  // Group scenes by setting and base description
  const groups: { baseIdx: number; indices: number[] }[] = [];
  let currentGroup: { baseIdx: number; indices: number[] } | null = null;

  for (let idx = 0; idx < storyData.scenes.length; idx++) {
    const scene = storyData.scenes[idx];
    if (!scene) continue;
    const isSame = idx > 0 &&
      scene.setting === storyData.scenes[idx - 1]?.setting &&
      getBaseDescription(scene.description) === getBaseDescription(storyData.scenes[idx - 1]?.description || "");

    if (!isSame) {
      currentGroup = { baseIdx: idx, indices: [idx] };
      groups.push(currentGroup);
    } else {
      currentGroup!.indices.push(idx);
    }
  }

  console.log(`Found ${groups.length} scene groups in the story.`);

  for (const group of groups) {
    const M = group.indices.length;
    const baseScene = storyData.scenes[group.baseIdx]!;
    
    if (M <= 1) {
      console.log(`Scene Group starting at index ${group.baseIdx} (Scene ${baseScene.sceneNumber}) has only 1 part. Skipping.`);
      continue;
    }

    console.log(`Processing scene group starting at Scene ${baseScene.sceneNumber} (${M} parts)...`);
    const basePrompt = baseScene.imagePrompt;

    if (!basePrompt) {
      console.warn(`No imagePrompt for base scene ${baseScene.sceneNumber}. Skipping.`);
      continue;
    }

    // Call Ollama to generate variations
    console.log(`Generating camera angle variations for Scene ${baseScene.sceneNumber}...`);
    const manifestStyle = storyData.style || "anime";
    const systemPrompt = `You are a cinematic storyboard director.
You will be given a base image generation prompt for a scene.
Your task is to generate 4 alternative versions of this prompt, each representing a DIFFERENT cinematic camera angle or framing of the SAME scene.

The visual style parameter of this storyboard is: "${manifestStyle}".
The alternative prompts must:
1. Keep the exact same characters, character looks, clothing, setting, style, and lighting to maintain absolute visual consistency. Ensure they strictly align with the visual style: "${manifestStyle}".
2. Only change the camera angle/framing (e.g., close-up on Captain Mara Kellan, close-up on Mr. Vane, over-the-shoulder shot, high-angle wide shot) and the corresponding poses/expressions/focus of the characters.
3. CRITICAL: Characters MUST NEVER look directly at the camera or viewer. They do not know a camera exists. They should look at each other, look into the surrounding area, or look away from the camera.
4. Be written as a single paragraph, similar to the base prompt.

Generate a JSON object containing an array of 4 strings:
{
  "variations": [
    "Variation 1: Close-up on Captain Mara Kellan...",
    "Variation 2: Close-up on Mr. Vane...",
    "Variation 3: Over-the-shoulder shot looking at the holo-contract...",
    "Variation 4: High-angle wide shot of the cluttered quarters..."
  ]
}

Only return a raw, valid JSON object.`;

    const userPrompt = `Base Prompt: ${basePrompt}`;

    let variations: string[] = [];
    try {
      const response = await callOllama([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ], true);
      variations = response.variations || [];
    } catch (err: any) {
      console.error(`Failed to generate variations via Ollama for Scene ${baseScene.sceneNumber}: ${err.message}`);
      continue;
    }

    if (variations.length < 4) {
      console.warn(`Ollama returned less than 4 variations. Using fallback list.`);
      variations = [basePrompt, basePrompt, basePrompt, basePrompt];
    }

    const pool = [basePrompt, ...variations];

    // Update scenes in the group
    for (let i = 0; i < M; i++) {
      const idx = group.indices[i]!;
      const scene = storyData.scenes[idx]!;
      const originalPrompt = scene.imagePrompt;
      const newPrompt = pool[i % pool.length]!;

      scene.imagePrompt = newPrompt;

      // For subsequent parts, clear assets to trigger regeneration with new angles
      if (i > 0) {
        if (originalPrompt !== newPrompt) {
          console.log(`  Updating Part ${i + 1} (Scene ${scene.sceneNumber}) with new camera angle.`);
          delete scene.imagePath;
          delete scene.videoPath;
        }
      }
    }
  }

  await fs.writeFile(filePath, JSON.stringify(storyData, null, 2), "utf-8");
  console.log(`Saved modified manifest: ${filePath}\n`);
}

async function main() {
  const file1 = path.resolve("C:/personal_projects/workflow/story_output.json");
  const file2 = path.resolve("C:/personal_projects/workflow/story_output_assets.json");

  await modifyManifest(file1);
  await modifyManifest(file2);

  console.log("Story modification complete!");
}

main().catch(err => {
  console.error("Fatal error: ", err);
});
