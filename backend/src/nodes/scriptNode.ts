import { callOllama } from "../config.ts";
import type { StoryStateType, Scene } from "../state.ts";

export function estimateDuration(script: string, description: string): number {
  const cleanScript = (script || "")
    .replace(/\[[^\]]+\]/g, "") // remove speaker tags
    .replace(/\([^)]+\)/g, "") // remove stage directions
    .trim();
  const scriptWords = cleanScript.split(/\s+/).filter(Boolean).length;
  
  const cleanDesc = (description || "").trim();
  const descWords = cleanDesc.split(/\s+/).filter(Boolean).length;

  // Dialogue time: ~2 words per second, plus 2 seconds base
  const scriptDuration = scriptWords > 0 ? Math.ceil(scriptWords / 2) + 2 : 0;
  // Action description time: ~3 words per second, plus 3 seconds base
  const descDuration = descWords > 0 ? Math.ceil(descWords / 3) + 3 : 6;

  const calculated = Math.max(scriptDuration, descDuration);
  return Math.min(16, Math.max(6, calculated));
}

export async function scriptNode(state: StoryStateType): Promise<Partial<StoryStateType>> {
  console.log(`\n\x1b[35m=== RUNNING SCRIPT & SCENE NODE (Sequential) ===\x1b[0m`);
  
  if (!state.outline || !state.characters) {
    throw new Error("Outline and Character data must be generated first.");
  }

  const premise = state.outline.premise;
  const characters = JSON.stringify(state.characters, null, 2);
  const generatedScenes: Scene[] = [];

  let prevScene: Scene | undefined;

  for (const sceneOutline of state.outline.sceneOutlines) {
    console.log(`[Script Node] Writing script & image prompt for Scene ${sceneOutline.sceneNumber}/${state.outline.sceneOutlines.length}...`);

    const systemPrompt = `You are a professional screenwriter and storyboarding artist.
Your job is to write a detailed script and design a detailed image generation prompt for a SPECIFIC scene in the story.

You will be given the story premise, character profiles, the outline of the scene to write, and optionally the details of the previous scene for continuity.

The overall visual style of the story is: ${state.style || "realistic"}.
You MUST ensure that the "imagePrompt" matches this style. Explicitly add style-specific descriptors (e.g. 'anime style, cel-shaded, studio ghibli-like' for anime, 'realistic photography style, cinematic lighting, photorealistic' for realistic, 'stylized 3d model, 3d render, blender render' for 3d, 'cartoon style, vector art, 2d animation look' for cartoon, or 'line-drawing style, only black lines with white background, clean line art, minimalist black and white sketch, no color, no shading' for line-drawing).

Instructions:
1. Write the script for this scene. Format speaker lines as: [Character Name]: Dialogue. Do NOT use narrator voice/narration. ONLY characters should speak. Any actions or non-verbal details should be written in parentheses, e.g. ([Character Name] looks up in fear).
2. Keep the script (dialogue) brief. It should have at most 2-3 short sentences (maximum 30 words in total for the entire script of this scene) so that the scene can easily be spoken in under 6 to 16 seconds.
3. Generate a highly detailed image generation prompt for this scene. This prompt will be used with AI image generators (like Midjourney or Stable Diffusion) to create a visual representation of this scene.
   - You MUST incorporate the specific physical looks and clothing of the characters present in the scene from their character descriptions.
   - You MUST specify a distinct and authentic camera angle/shot type (e.g., low-angle shot, extreme close-up, high-angle bird's-eye view, wide establishing shot, over-the-shoulder shot, dynamic dutch angle, tracking medium shot) to ensure the scene looks authentic and cinematic.
   - You MUST ensure the camera/framing and focus align with the scene action:
     * If a character is speaking in the script, focus the camera on them (e.g., close-up or medium shot of the speaker).
     * If nobody is speaking, focus the camera on another area of the scene, such as a reaction shot of another character's face (listening or reacting) or details of the environment.
   - CRITICAL: Characters MUST NEVER look directly at the camera or viewer. They do not know a camera exists. They should look at each other, look into the surrounding area, or look away from the camera.
   - Describe the environment setting, the action being performed, facial expressions, lighting (e.g., low-key lighting, neon glow, sunset warm light), and cinematic style (e.g., cinematic, realistic, photorealistic, animated).
   - Maintain character appearance consistency.
4. CONTINUITY: You are aware of the previous scene's details. Ensure that the visual action, description, and dialogues of the current scene flow naturally and look visually connected to the previous scene.
5. CAMERA CUT: Determine if this scene takes place in the exact same setting and continues with the exact same camera angle/framing/shot type as the previous scene (without any camera cut, panning, or shot type change). Set the "sameCameraAngle" boolean to true if it does, and false if there is a cut, new framing, or it's the first scene.

Generate a JSON object that strictly adheres to this structure:
{
  "setting": "Setting description for this scene",
  "description": "Brief summary of the scene's action (ensure it is aware of and connects logically with the previous scene description)",
  "script": "The full detailed script of the scene containing dialogues.",
  "duration": A number between 6 and 16 representing the duration of the scene in seconds based on dialogue length and action complexity,
  "imagePrompt": "A highly detailed, single-paragraph image generation prompt containing camera direction, lighting, setting details, character names with their exact looks, poses, and expressions.",
  "sameCameraAngle": true or false
}

Only return a raw, valid JSON object.`;

    let userPrompt = `Story Premise: ${premise}

Characters:
${characters}

Current Scene to Write:
Scene Number: ${sceneOutline.sceneNumber}
Setting: ${sceneOutline.setting}
Outline Description: ${sceneOutline.description}`;

    if (prevScene) {
      userPrompt += `\n\nPrevious Scene Details (for continuity):
Scene Number: ${prevScene.sceneNumber}
Setting: ${prevScene.setting}
Visual Action Description: ${prevScene.description}
Script/Dialogue: ${prevScene.script}
Image Prompt: ${prevScene.imagePrompt}`;
    }

    const response = await callOllama([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], true);

    const imagePrompt = response.imagePrompt || "";
    const finalDescription = response.description || sceneOutline.description;
    const finalScript = response.script || "";
    
    // Create the raw scene
    const rawScene: Scene = {
      sceneNumber: sceneOutline.sceneNumber,
      setting: response.setting || sceneOutline.setting,
      description: finalDescription,
      script: finalScript,
      imagePrompt: imagePrompt,
      duration: typeof response.duration === 'number' && response.duration >= 6 && response.duration <= 16
        ? Math.round(response.duration)
        : estimateDuration(finalScript, finalDescription),
      sameCameraAngle: response.sameCameraAngle === true
    };

    generatedScenes.push(rawScene);
    prevScene = rawScene;
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
