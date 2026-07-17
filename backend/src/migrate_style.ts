import * as fs from "fs/promises";
import * as path from "path";
import { loadAppConfig } from "./config.ts";

const appConfig = loadAppConfig();
const targetStyle = appConfig.style;

const characterStyleMapping: Record<string, string> = {
  "Captain Mara Kellan": "A 62-year-old woman, silver-white hair cut in a practical, messy short bob with frayed ends, pale blue eyes, weathered skin showing lines and wrinkles, slight stoop in posture, wearing a worn, charcoal-grey flight suit with corporate patches on the sleeves, a heavy utility belt with a magnetic tool tether, fingerless compression gloves, a vintage analog wristwatch on left wrist, standing on a vibrating metal deck plate of a freighter bridge, harsh overhead LED lighting casting distinct shadows",
  "Unit 734 'Sable'": "A humanoid figure of indeterminate gender, late 30s apparent age, completely hairless scalp with visible subdermal data ports glowing faint cyan at the temples, face dominated by seamless matte-black ocular implants covering the entire eye socket area, sharp jawline, thin pale lips, wearing a form-fitting, matte-black tactical exosuit with carbon-fiber plating on chest and forearms, magnetic coilgun holsters at hips, faint iridescent fiber-optic veins pulsing along neck and hands, standing in a sterile white hangar bay",
  "Dr. Aris Thorne": "A 58-year-old man, gaunt face, unkempt salt-and-pepper beard, deep-set hazel eyes behind rectangular glasses held together by tape at the bridge, messy shoulder-length grey hair tied back, wearing a stained, oversized off-white lab coat over a faded t-shirt and grease-stained coveralls, a red glowing data-port jack at his temple, fingers stained yellow and black, sitting in a cluttered control room with monitors and cables",
  "The Nebula (Designation: 'Echo')": "A non-humanoid entity visualization, stylized volumetric fluid simulation. Inside a transparent, hexagonal magnetic containment bottle (2m x 2m x 4m) mounted in the cargo bay: a swirling, high-density nebula core, deep indigo and violet plasma shot through with veins of brilliant gold and electric blue, churning slowly in zero-g. The plasma forms transient, fractal structures resembling neural networks or eyes. Faint gravitational lensing distorts the view of the cargo bay walls. The container's magnetic field projectors glow with intense, oscillating teal light at the corners"
};

function migratePromptStyle(prompt: string, targetStyle: string): string {
  if (!prompt) return prompt;

  let migrated = prompt;
  
  // Clean up style keywords from other styles to avoid style mixing
  const styleKeywords = [
    // Anime
    /anime art style/gi, /cel-shaded/gi, /clean line art/gi, /studio ghibli-like/gi, /cel-shaded, high-quality anime illustration/gi, /clean anime shading/gi, /clean anime look/gi, /clean anime aesthetic/gi,
    // Realistic
    /cinematic realistic photography style/gi, /highly detailed skin textures/gi, /photorealistic/gi, /8k resolution/gi, /highly detailed textures/gi, /detailed skin textures/gi, /8k/gi, /cinematic lighting/gi,
    // 3D
    /stylized 3d model/gi, /3d render/gi, /blender render/gi, /Pixar style/gi, /highly detailed 3D digital art/gi,
    // Cartoon
    /cartoon style/gi, /vector art/gi, /2d animation look/gi, /vibrant colors/gi, /expressive cartoon style/gi, /cartoon illustration style/gi, /expressive features/gi,
    // Line-drawing
    /line-drawing style/gi, /only black lines with white background/gi, /clean line art/gi, /minimalist black and white sketch/gi, /no color/gi, /no shading/gi
  ];

  for (const pattern of styleKeywords) {
    migrated = migrated.replace(pattern, "");
  }

  // Clean double commas or leading/trailing spaces
  migrated = migrated.replace(/,\s*,/g, ",").trim();
  if (migrated.startsWith(",")) migrated = migrated.substring(1).trim();
  if (migrated.endsWith(",")) migrated = migrated.substring(0, migrated.length - 1).trim();

  // Prepend new style descriptors
  let stylePrefix = "";
  if (targetStyle === "anime") {
    stylePrefix = "Anime art style, cel-shaded, clean line art, studio ghibli-like, ";
  } else if (targetStyle === "cartoon") {
    stylePrefix = "Cartoon style, vector art, 2d animation look, vibrant colors, ";
  } else if (targetStyle === "3d") {
    stylePrefix = "Stylized 3d model, 3d render, blender render, Pixar style, ";
  } else if (targetStyle === "realistic") {
    stylePrefix = "Cinematic realistic photography style, cinematic lighting, photorealistic, ";
  } else if (targetStyle === "line-drawing") {
    stylePrefix = "Line-drawing style, only black lines with white background, clean line art, minimalist black and white sketch, no color, no shading, ";
  } else {
    stylePrefix = `${targetStyle} style, `;
  }

  return stylePrefix + migrated;
}

async function migrateManifest(filePath: string) {
  try {
    await fs.access(filePath);
  } catch {
    console.log(`Manifest not found at ${filePath}. Skipping.`);
    return;
  }

  console.log(`Migrating style of manifest: ${filePath}`);
  const content = await fs.readFile(filePath, "utf-8");
  const storyData = JSON.parse(content);

  storyData.style = targetStyle;

  // 1. Migrate Characters
  if (storyData.characters && Array.isArray(storyData.characters)) {
    for (const char of storyData.characters) {
      const charName = char.name;
      const baseLooks = char.looks || characterStyleMapping[charName] || "";
      if (baseLooks) {
        console.log(`  Updating looks for character: ${charName}`);
        char.looks = migratePromptStyle(baseLooks, targetStyle);
      }
    }
  }

  // 2. Migrate Scenes Prompts and Clear Existing Paths
  if (storyData.scenes && Array.isArray(storyData.scenes)) {
    for (const scene of storyData.scenes) {
      if (scene.imagePrompt) {
        scene.imagePrompt = migratePromptStyle(scene.imagePrompt, targetStyle);
      }
      
      // Clear paths to trigger regeneration of assets in the new style
      if (scene.imagePath) {
        console.log(`  Clearing imagePath for Scene ${scene.sceneNumber || 'unknown'}`);
        delete scene.imagePath;
      }
      if (scene.videoPath) {
        console.log(`  Clearing videoPath for Scene ${scene.sceneNumber || 'unknown'}`);
        delete scene.videoPath;
      }
    }
  }

  await fs.writeFile(filePath, JSON.stringify(storyData, null, 2), "utf-8");
  console.log(`Successfully migrated and saved: ${filePath}\n`);
}

async function main() {
  const file1 = path.resolve("C:/personal_projects/workflow/story_output.json");
  const file2 = path.resolve("C:/personal_projects/workflow/story_output_assets.json");

  await migrateManifest(file1);
  await migrateManifest(file2);

  console.log("Style migration successfully complete!");
}

main().catch(err => {
  console.error("Fatal error during style migration: ", err);
});
