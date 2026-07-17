import { callOllama } from "../config.ts";
import type { StoryStateType, Scene } from "../state.ts";
import { sendBgmPrompt } from "../comfy.ts";

export async function audioNode(state: StoryStateType): Promise<Partial<StoryStateType>> {
  console.log(`\n\x1b[35m=== RUNNING AUDIO & SFX NODE (Sequential) ===\x1b[0m`);
  
  if (!state.scenes) {
    throw new Error("Scenes must be generated before audio node can run.");
  }

  const updatedScenes: Scene[] = [];

  for (const scene of state.scenes) {
    console.log(`[Audio Node] Designing sound and voiceover for Scene ${scene.sceneNumber}/${state.scenes.length}...`);

    const systemPrompt = `You are a sound designer and audio director for video productions.
Your task is to take the script of a single scene and design the audio layout (voiceover text, background music, and sound effects).

Instructions:
1. voiceover: Extract and format a clean text narration for Text-To-Speech (TTS) software. This should include all spoken dialogue and narrations in order, but remove any formatting tags like '[Narrator]:' or '[Character Name]:' and remove stage directions in brackets/parentheses. It should be a clean, continuous spoken script. Keep this voiceover text extremely short and concise (under 10 words) to ensure it can be read in under 5-8 seconds.
2. bgmPrompt: Create a descriptive prompt for AI music generators (e.g., Suno or Udio) describing the background music for this scene (including genre, tempo, instruments, mood, e.g., "haunting orchestral strings, slow tempo, melancholic piano, dark and suspenseful ambient background music").
3. sfx: A list of specific sound effects (SFX) that should be layered into the scene (e.g., ["heavy footsteps on wood", "glass shattering", "wind howling outside"]).

Generate a JSON object that strictly adheres to this structure:
{
  "voiceover": "A clean voiceover script for TTS",
  "bgmPrompt": "A detailed music generation prompt",
  "sfx": ["sfx_name_1", "sfx_name_2"]
}

Only return a raw, valid JSON object.`;

    const userPrompt = `Scene Number: ${scene.sceneNumber}
Setting: ${scene.setting}
Description: ${scene.description}
Script: ${scene.script}`;

    const response = await callOllama([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], true);

    const bgmPrompt = response.bgmPrompt || "";

    const voiceoverText = response.voiceover || "";
    const words = voiceoverText.trim().split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    // Assume average speaking rate is 2.5 words per second (150 WPM)
    const assumedSpeechDuration = Math.ceil(wordCount / 2.5);
    // Strictly cap the duration between 5 and 10 seconds
    const dynamicDuration = Math.min(10, Math.max(5, wordCount > 0 ? assumedSpeechDuration + 2 : scene.duration));

    console.log(`[Audio Node] Calculated dynamic duration for Scene ${scene.sceneNumber}: ${dynamicDuration}s (based on ${wordCount} words)`);

    updatedScenes.push({
      ...scene,
      voiceover: response.voiceover,
      bgmPrompt: bgmPrompt,
      sfx: response.sfx || [],
      duration: dynamicDuration
    });

    if (bgmPrompt) {
      await sendBgmPrompt(bgmPrompt, dynamicDuration);
    }
  }

  console.log(`\x1b[32m[Audio Node] Completed audio specifications for all ${updatedScenes.length} scenes.\x1b[0m`);
  return {
    scenes: updatedScenes
  };
}
