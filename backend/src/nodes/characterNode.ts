import { callOllama } from "../config.ts";
import type { StoryStateType, Character } from "../state.ts";

export async function characterNode(state: StoryStateType): Promise<Partial<StoryStateType>> {
  console.log(`\n\x1b[35m=== RUNNING CHARACTER NODE ===\x1b[0m`);
  
  if (!state.outline || !state.outline.characterRoles) {
    throw new Error("Outline data not found. Make sure outlineNode runs first.");
  }

  const characterRolesList = JSON.stringify(state.outline.characterRoles, null, 2);
  const premise = state.outline.premise;

  const systemPrompt = `You are a character designer and concept artist.
Your task is to take the basic character list and story premise, and design a detailed character profile for each character.
Focus on creating highly descriptive visual "looks" for each character. These looks should contain specific details (e.g., gender, approximate age, hair style/color, skin tone, eye color, clothing style, facial features, accessories) to ensure visual consistency when generating images for each scene of the video.

CRITICAL CAMERA AVOIDANCE RULE:
Characters do NOT know there is a camera. They should NEVER look directly at the camera or viewer. Avoid descriptors like "looking at camera", "looking at the viewer", or "staring forward". Instead, their poses and gaze should be directed at other characters, their tasks, or looking into the surrounding area of the scene.

The overall visual style of the conceptual art is: ${state.style || "realistic"}.
Incorporate style-specific descriptors into their "looks" (e.g., if style is anime, use descriptors like 'anime art style, cel-shaded, clean line art'; if cartoon, 'cartoon illustration style, vibrant colors, expressive features'; if 3d, '3d render style, digital art, stylized 3d model'; if realistic, 'cinematic, realistic photography style, highly detailed textures'; if line-drawing, 'line-drawing style, only black lines with white background, clean line art, minimalist black and white sketch, no color, no shading').

Generate a JSON object that strictly adheres to this structure:
{
  "characters": [
    {
      "name": "The character's name (must match the original name exactly)",
      "role": "The character's role in the story",
      "description": "A paragraph about their personality, goals, and history in the story.",
      "looks": "A highly detailed, comma-separated physical description for image generators (e.g., 'A 35-year-old woman, sharp blue eyes looking off-camera, short brown pixie-cut hair, wearing a white futuristic lab coat over a blue jumpsuit, determined expression, silver earring')"
    }
  ]
}

Only return a raw, valid JSON object.`;

  const userPrompt = `Story Premise: ${premise}
Characters to design:
${characterRolesList}`;

  const response = await callOllama([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], true);

  const characters = response.characters as Character[];
  
  console.log(`\x1b[32m[Character Node] Generated detailed looks for ${characters.length} characters:\x1b[0m`);
  for (const char of characters) {
    console.log(` - ${char.name}: ${char.looks.substring(0, 80)}...`);
  }

  return {
    characters: characters
  };
}
