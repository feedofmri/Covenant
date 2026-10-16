// Loads shared/deployments/<network>.json and the exported ABIs.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadDeployment(network = process.env.DEPLOYMENT || "localhost") {
  const file = path.join(here, "deployments", `${network}.json`);
  if (!existsSync(file)) throw new Error(`No deployment file for "${network}" at ${file}. Run the deploy script first.`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export function loadAbi(name) {
  const file = path.join(here, "abi", `${name}.json`);
  if (!existsSync(file)) throw new Error(`ABI ${name} not exported. Run: npm run build:contracts`);
  return JSON.parse(readFileSync(file, "utf8")).abi;
}

export function loadArtifact(name) {
  return JSON.parse(readFileSync(path.join(here, "abi", `${name}.json`), "utf8"));
}

export const deploymentPath = (network) => path.join(here, "deployments", `${network}.json`);
