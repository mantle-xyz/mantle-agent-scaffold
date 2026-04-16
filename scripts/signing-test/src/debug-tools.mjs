import { allTools } from "../../../packages/core/dist/tools/index.js";

console.log("Tool keys starting with mantle_get:");
for (const key of Object.keys(allTools).sort()) {
  if (key.includes("Position") || key.includes("position")) {
    console.log("  " + key);
  }
}

console.log("\nmantle_getV3Positions defined?", !!allTools["mantle_getV3Positions"]);
console.log("mantle_getLBPositions defined?", !!allTools["mantle_getLBPositions"]);
