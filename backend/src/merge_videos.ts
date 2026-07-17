import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { config } from 'dotenv'

config()
const execAsync = promisify(exec);

// Standard styling helper
function logHeader(text: string) {
  console.log(`\n\x1b[35m=== ${text} ===\x1b[0m`);
}
function logInfo(text: string) {
  console.log(`\x1b[34m[Info] ${text}\x1b[0m`);
}
function logSuccess(text: string) {
  console.log(`\x1b[32m[Success] ${text}\x1b[0m`);
}
function logWarning(text: string) {
  console.log(`\x1b[33m[Warning] ${text}\x1b[0m`);
}
function logError(text: string, err?: any) {
  console.error(`\x1b[31m[Error] ${text}\x1b[0m`, err || "");
}

async function main() {
  logHeader("ISOLATED VIDEO MERGE UTILITY");

  const manifestPath = path.resolve(process.cwd(), "story_output_assets.json");
  logInfo(`Loading manifest: ${manifestPath}`);

  let storyData: any;
  try {
    const content = await fs.readFile(manifestPath, "utf-8");
    storyData = JSON.parse(content);
  } catch (err: any) {
    logError(`Failed to read/parse manifest: ${err.message}`);
    process.exit(1);
  }

  if (!storyData.scenes || !Array.isArray(storyData.scenes)) {
    logError("Invalid manifest structure: scenes array not found.");
    process.exit(1);
  }

  // Sort scenes by sceneNumber
  const scenes = [...storyData.scenes].sort((a: any, b: any) => (a.sceneNumber || 0) - (b.sceneNumber || 0));

  const absoluteVideoPaths: string[] = [];
  logInfo(`Scanning scenes from manifest:`);
  for (const scene of scenes) {
    if (scene.videoPath) {
      const absPath = path.resolve(scene.videoPath);
      try {
        await fs.access(absPath);
        absoluteVideoPaths.push(absPath);
        console.log(`  - Scene ${scene.sceneNumber}: Found video at ${scene.videoPath}`);
      } catch {
        logWarning(`  - Scene ${scene.sceneNumber}: Video file not found at ${absPath}`);
      }
    } else {
      logWarning(`  - Scene ${scene.sceneNumber}: No videoPath specified in manifest.`);
    }
  }

  if (absoluteVideoPaths.length === 0) {
    logWarning("No valid video files found from the manifest.");
    process.exit(0);
  }

  let targetFolderArg = process.env.output_dir ? `${process.env.output_dir}/video` : undefined;
  if (!targetFolderArg) {
    targetFolderArg = process.argv[2];
  }

  let targetFolder = targetFolderArg ? path.resolve(targetFolderArg) : undefined;
  if (!targetFolder && absoluteVideoPaths.length > 0) {
    targetFolder = path.dirname(absoluteVideoPaths[0]!);
  }

  if (!targetFolder) {
    logError("No target folder path provided.");
    process.exit(1);
  }

  const outputFileName = process.argv[3] || "merged_output.mp4";
  const finalOutputPath = path.join(targetFolder, outputFileName);

  logInfo(`Target Folder:  ${targetFolder}`);
  logInfo(`Output File:    ${finalOutputPath}`);

  // Check if directory exists
  try {
    const stats = await fs.stat(targetFolder);
    if (!stats.isDirectory()) {
      throw new Error("Path is not a directory");
    }
  } catch (err: any) {
    // Attempt to create target directory if it doesn't exist
    try {
      await fs.mkdir(targetFolder, { recursive: true });
    } catch {
      logError(`Target path is not a valid directory and could not be created: ${targetFolder}`);
      process.exit(1);
    }
  }

  const tempFilePath = path.join(targetFolder, "temp_merge_list.txt");

  try {
    const fileContent = absoluteVideoPaths
      .map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
      .join("\n");

    await fs.writeFile(tempFilePath, fileContent, "utf-8");
    logInfo(`Created temporary concat list: ${tempFilePath}`);

    const command = `ffmpeg -y -f concat -safe 0 -i "${tempFilePath}" -c copy "${finalOutputPath}"`;
    logInfo(`Running command: ${command}`);

    const { stdout, stderr } = await execAsync(command);
    logSuccess(`Merged video saved successfully to: ${finalOutputPath}`);
  } catch (err: any) {
    logError("Failed to merge videos using ffmpeg", err);
  } finally {
    try {
      await fs.unlink(tempFilePath);
    } catch {
      // Ignore if temp file doesn't exist
    }
  }

  logHeader("MERGE COMPLETE");
}

main().catch((err) => {
  logError("Fatal error during merge execution", err);
});
