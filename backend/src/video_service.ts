import { spawn } from "child_process";

/**
 * Triggers video merge script (merge_videos.ts)
 */
export async function runVideoMerge(): Promise<void> {
  console.log("[Server] Running video merge script...");
  return new Promise<void>((resolve, reject) => {
    const child = spawn("bun", ["src/merge_videos.ts"], { stdio: "inherit", shell: true });
    child.on("close", (code) => {
      if (code === 0) {
        console.log("[Server] Video merge successfully completed.");
        resolve();
      } else {
        reject(new Error(`Video merge exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}
