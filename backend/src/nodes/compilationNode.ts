import { type StoryStateType } from "../state.ts";
import * as fs from "fs/promises";
import * as path from "path";

export async function compilationNode(state: StoryStateType): Promise<Partial<StoryStateType>> {
  console.log(`\n\x1b[35m=== RUNNING COMPILATION NODE ===\x1b[0m`);
  
  const storyDuration = state.scenes?.reduce((acc, scene) => acc + (scene.duration || 0), 0) || 0;

  const finalStory = {
    title: state.outline?.title,
    genre: state.outline?.genre,
    premise: state.outline?.premise,
    style: state.style,
    storyDuration: storyDuration,
    characters: state.characters,
    scenes: state.scenes
  };

  const outputPath = state.outputFile || "story_output.json";
  const absolutePath = path.resolve(outputPath);

  console.log(`[Compilation Node] Saving final story manifest to: ${absolutePath}`);
  
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, JSON.stringify(finalStory, null, 2), "utf-8");

  console.log(`\n\x1b[32m=== STORY MANIFEST GENERATED SUCCESSFULLY ===\x1b[0m`);
  console.log(`Title: ${finalStory.title}`);
  console.log(`Genre: ${finalStory.genre}`);
  console.log(`Premise: ${finalStory.premise}`);
  console.log(`Saved manifest to: [story_output.json](file:///${absolutePath.replace(/\\/g, '/')})`);
  console.log(`============================================\n`);

  return {};
}
