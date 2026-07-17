import { callOllama } from "../config.ts";
import type { StoryStateType, Scene } from "../state.ts";

function estimateDuration(text: string): number {
  const words = text
    .replace(/\[[^\]]+\]/g, "") // remove speaker tags
    .replace(/\([^)]+\)/g, "") // remove stage directions
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const wordCount = words.length;
  const calculated = wordCount > 0 ? Math.ceil(wordCount / 2.5) + 2 : 5;
  // Strictly enforce/cap duration between 5 and 10 seconds
  return Math.min(10, Math.max(5, calculated));
}

export async function scriptNode(state: StoryStateType): Promise<Partial<StoryStateType>> {
  console.log(`\n\x1b[35m=== RUNNING SCRIPT & SCENE NODE (Sequential) ===\x1b[0m`);
  
  if (!state.outline || !state.characters) {
    throw new Error("Outline and Character data must be generated first.");
  }

  const premise = state.outline.premise;
  const characters = JSON.stringify(state.characters, null, 2);
  const generatedScenes: Scene[] = [];

  for (const sceneOutline of state.outline.sceneOutlines) {
    console.log(`[Script Node] Writing script & image prompt for Scene ${sceneOutline.sceneNumber}/${state.outline.sceneOutlines.length}...`);

    const systemPrompt = `You are a professional screenwriter and storyboarding artist.
Your job is to write a detailed script and design a detailed image generation prompt for a SPECIFIC scene in the story.

You will be given the story premise, character profiles, and the outline of the scene to write.

The overall visual style of the story is: ${state.style || "realistic"}.
You MUST ensure that the "imagePrompt" matches this style. Explicitly add style-specific descriptors (e.g. 'anime style, cel-shaded, studio ghibli-like' for anime, 'realistic photography style, cinematic lighting, photorealistic' for realistic, 'stylized 3d model, 3d render, blender render' for 3d, 'cartoon style, vector art, 2d animation look' for cartoon, or 'line-drawing style, only black lines with white background, clean line art, minimalist black and white sketch, no color, no shading' for line-drawing).

Instructions:
1. Write the script for this scene. Format speaker lines as: [Character Name]: Dialogue. You can also write narrator lines as [Narrator]: Dialogue/Text. Any actions or non-verbal details should be written in parentheses, e.g. ([Character Name] looks up in fear).
2. Keep the script (dialogue and narration) extremely brief and short. It should have at most 1 short sentence (maximum 10 words in total for the entire script of this scene) so that the scene can easily be spoken/narrated in under 5-8 seconds.
3. Generate a highly detailed image generation prompt for this scene. This prompt will be used with AI image generators (like Midjourney or Stable Diffusion) to create a visual representation of this scene.
   - You MUST incorporate the specific physical looks and clothing of the characters present in the scene from their character descriptions.
   - You MUST specify a distinct and authentic camera angle/shot type (e.g., low-angle shot, extreme close-up, high-angle bird's-eye view, wide establishing shot, over-the-shoulder shot, dynamic dutch angle, tracking medium shot) to ensure the scene looks authentic and cinematic.
   - You MUST ensure the camera/framing and focus align with the scene action:
     * If a character is speaking in the script, focus the camera on them (e.g., close-up or medium shot of the speaker).
     * If nobody is speaking, focus the camera on another area of the scene, such as a reaction shot of another character's face (listening or reacting) or details of the environment.
   - CRITICAL: Characters MUST NEVER look directly at the camera or viewer. They do not know a camera exists. They should look at each other, look into the surrounding area, or look away from the camera.
   - Describe the environment setting, the action being performed, facial expressions, lighting (e.g., low-key lighting, neon glow, sunset warm light), and cinematic style (e.g., cinematic, realistic, photorealistic, animated).
   - Maintain character appearance consistency.

Generate a JSON object that strictly adheres to this structure:
{
  "setting": "Setting description for this scene",
  "description": "Brief summary of the scene's action",
  "script": "The full detailed script of the scene containing dialogues and/or narration.",
  "imagePrompt": "A highly detailed, single-paragraph image generation prompt containing camera direction, lighting, setting details, character names with their exact looks, poses, and expressions."
}

Only return a raw, valid JSON object.`;

    const userPrompt = `Story Premise: ${premise}

Characters:
${characters}

Current Scene to Write:
Scene Number: ${sceneOutline.sceneNumber}
Setting: ${sceneOutline.setting}
Outline Description: ${sceneOutline.description}`;

    const response = await callOllama([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], true);

    const imagePrompt = response.imagePrompt || "";
    
    // Create the raw scene
    const rawScene: Scene = {
      sceneNumber: sceneOutline.sceneNumber,
      setting: response.setting || sceneOutline.setting,
      description: response.description || sceneOutline.description,
      script: response.script || "",
      imagePrompt: imagePrompt,
      duration: estimateDuration(response.script || "")
    };

    generatedScenes.push(rawScene);
  }

  // Re-number scenes sequentially
  let idx = 1;
  for (const scene of generatedScenes) {
    scene.sceneNumber = idx++;
    console.log(`[Script Node] Finalized Scene ${scene.sceneNumber}: duration ${scene.duration}s, desc: "${scene.description}"`);
  }

  console.log(`\x1b[32m[Script Node] Completed scripts and image prompts for all ${generatedScenes.length} scenes.\x1b[0m`);
  return {
    scenes: generatedScenes
  };
}
