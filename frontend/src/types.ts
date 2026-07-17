export interface Character {
  name: string;
  role: string;
  description: string;
}

export interface Scene {
  sceneNumber: number;
  setting: string;
  description: string;
  script: string;
  imagePrompt: string;
  duration?: number;
  imagePath?: string;
  videoPath?: string;
}

export interface StoryManifest {
  title: string;
  genre: string;
  premise: string;
  style: string;
  storyDuration: number;
  characters: Character[];
  scenes: Scene[];
  mergedVideoPath?: string;
  outputDir?: string;
}
