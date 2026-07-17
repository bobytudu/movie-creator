import { callOllama } from "../config.ts";
import type { StoryStateType, StoryOutline } from "../state.ts";

export async function outlineNode(state: StoryStateType): Promise<Partial<StoryStateType>> {
  console.log(`\n\x1b[35m=== RUNNING OUTLINE NODE ===\x1b[0m`);
  console.log(`Topic: "${state.topic}"`);

  const systemPrompt = `You are a professional screenwriter and creative director.
Your job is to take a story topic/premise and create a structured, compelling story outline.

The overall visual style of the story is: ${state.style || "realistic"}. Design the premise and scenes to match this style's characteristics.

CRITICAL INSTRUCTIONS FOR SCENE STRUCTURE AND DURATION:
1. Every scene in the outline represents a single short camera cut/shot, and MUST NOT be longer than 5 to 8 seconds (maximum 10 seconds absolute limit).
2. To keep scenes under 8-10 seconds, a person must not speak continuously or perform actions for too long in a single scene.
3. You MUST cut/split the action or conversation:
   - When a character is speaking, dedicate a short scene/shot to that character speaking.
   - When nobody is speaking, or between lines of dialogue, dedicate a separate shot focusing on other areas of the scene (e.g., reaction shots focusing on another character's face, or focusing on the surroundings/environment) to look realistic.
4. Ensure the story is detailed by generating a sequence of 10 to 18 short scenes/shots (cuts) rather than a few long scenes.

Generate a JSON object that strictly adheres to this structure:
{
  "title": "A catchy and creative title for the video story",
  "genre": "The genre of the story (e.g. Science Fiction, Mystery, Suspense, Comedy, Historical)",
  "premise": "A detailed 2-3 sentence overview of the plot and themes.",
  "characterRoles": [
    {
      "name": "Full name or moniker of the character",
      "role": "Their role in the story (e.g. Protagonist, Antagonist, Mentor, Comic Relief)",
      "briefRoleDescription": "A 1-sentence description of who they are and what they do in the plot."
    }
  ],
  "sceneOutlines": [
    {
      "sceneNumber": 1,
      "setting": "The setting description (e.g. 'A futuristic spaceship cockpit at night, lit by blinking console screens')",
      "description": "What happens in this scene, the main action, and the narrative progress (e.g., 'Character A speaks briefly while looking at B' or 'Reaction shot of Character B looking surprised' or 'Shot of the blinking spaceship console'). Keep this description brief and focused on a single shot."
    }
  ]
}

Ensure the story has between 2 to 4 distinct characters and between 10 to 18 detailed short scenes/shots. Do not output anything other than raw, valid JSON.`;

  const userPrompt = `Create a story outline for the topic: "${state.topic}"`;

  const outline = (await callOllama([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], true)) as StoryOutline;

  console.log(`\x1b[32m[Outline Node] Generated outline for: "${outline.title}"\x1b[0m`);
  console.log(`[Outline Node] Created ${outline.characterRoles?.length || 0} characters and ${outline.sceneOutlines?.length || 0} scenes.`);

  return {
    outline: outline
  };
}
