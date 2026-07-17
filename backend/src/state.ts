import { Annotation } from "@langchain/langgraph";

export interface StoryOutline {
  title: string;
  genre: string;
  premise: string;
  characterRoles: { name: string; role: string; briefRoleDescription: string }[];
  sceneOutlines: { sceneNumber: number; setting: string; description: string }[];
}

export interface Character {
  name: string;
  role: string;
  description: string;
  looks: string; // Detailed visual descriptors (clothing, hair, facial features, etc.) for AI art consistency
}

export interface Scene {
  sceneNumber: number;
  setting: string;
  description: string;
  script: string;       // Dialogues and actions, e.g. [Character A]: "Hello..."
  imagePrompt: string;  // Detailed image generation prompt incorporating character looks and scene setting
  duration: number;     // Duration of the scene in seconds
  // These will be filled by the AudioNode
  voiceover?: string;   // Narration script for voice generation
  bgmPrompt?: string;   // Prompt for music generator (tempo, genre, instruments, mood)
  sfx?: string[];       // Sound effects in this scene
  sameCameraAngle?: boolean; // Whether the scene has the exact same camera angle as the previous one
}

// LangGraph state annotation defining which fields can be modified.
export const StoryState = Annotation.Root({
  topic: Annotation<string>(),
  style: Annotation<string>(),
  outline: Annotation<StoryOutline>(),
  characters: Annotation<Character[]>(),
  scenes: Annotation<Scene[]>(),
  outputFile: Annotation<string>(),
});

export type StoryStateType = typeof StoryState.State;
