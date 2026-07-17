import { StateGraph } from "@langchain/langgraph";
import { StoryState } from "./state.ts";
import { outlineNode } from "./nodes/outlineNode.ts";
import { characterNode } from "./nodes/characterNode.ts";
import { scriptNode } from "./nodes/scriptNode.ts";
import { compilationNode } from "./nodes/compilationNode.ts";

// Build the workflow
const workflow = new StateGraph(StoryState)
  .addNode("generate_outline", outlineNode)
  .addNode("generate_characters", characterNode)
  .addNode("generate_script", scriptNode)
  .addNode("compile_story", compilationNode)
  
  // Define structural path of execution
  .addEdge("__start__", "generate_outline")
  .addEdge("generate_outline", "generate_characters")
  .addEdge("generate_characters", "generate_script")
  .addEdge("generate_script", "compile_story")
  .addEdge("compile_story", "__end__");

// Compile the state machine
export const graph = workflow.compile();
