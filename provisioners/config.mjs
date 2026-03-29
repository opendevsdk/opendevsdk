import path from "node:path";
import { fileURLToPath } from "node:url";

export const packagePrefix = "@opendevsdk/";
export const githubOwner = "opendevsdk";
export const githubApiBaseUrl = "https://api.github.com";
export const npmRegistryBaseUrl = "https://registry.npmjs.org";
export const githubWorkflowFileName = "ci.yml";

const currentFilePath = fileURLToPath(import.meta.url);
const provisionersDir = path.dirname(currentFilePath);

export const repoRoot = path.resolve(provisionersDir, "..");
export const apisDir = path.join(repoRoot, "fern", "apis");
