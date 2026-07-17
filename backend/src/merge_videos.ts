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

  let targetFolderArg = process.env.output_dir ? `${process.env.output_dir}/video` : undefined;
  if (!targetFolderArg) {
    targetFolderArg = process.argv[2];
  }
  if (!targetFolderArg) {
    logError("No target folder path provided.");
    console.log("\nUsage:\n  bun src/merge_videos.ts <folder_path> [output_file_name]");
    process.exit(1);
  }

  const targetFolder = path.resolve(targetFolderArg);
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
    logError(`Target path is not a valid directory: ${targetFolder}`);
    process.exit(1);
  }

  // Read all files in the directory
  let files: string[];
  try {
    files = await fs.readdir(targetFolder);
  } catch (err: any) {
    logError(`Failed to read directory contents: ${err.message}`);
    process.exit(1);
  }

  // Filter and parse sequential files ending in \d+_\.mp4
  const regex = /(\d+)_\.mp4$/i;
  const videoFiles = files
    .map((name) => {
      const match = name.match(regex);
      return {
        name,
        num: match && match[1] ? parseInt(match[1], 10) : null,
      };
    })
    .filter((f): f is { name: string; num: number } => f.num !== null);

  if (videoFiles.length === 0) {
    logWarning("No video files ending with '<number>_.mp4' found in the target directory.");
    process.exit(0);
  }

  // Sort them numerically, falling back to alphabetical for ties
  videoFiles.sort((a, b) => {
    if (a.num !== b.num) {
      return a.num - b.num;
    }
    return a.name.localeCompare(b.name);
  });

  logInfo(`Found ${videoFiles.length} sequential videos to merge:`);
  videoFiles.forEach((f) => {
    console.log(`  - ${f.name} (Index: ${f.num})`);
  });

  const absoluteVideoPaths = videoFiles.map((f) => path.join(targetFolder, f.name));
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
