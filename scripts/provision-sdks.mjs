import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const packagePrefix = "@opensdkdev/";
const githubOwner = "opensdkdev";
const githubApiBaseUrl = "https://api.github.com";
const npmRegistryBaseUrl = "https://registry.npmjs.org";
const currentFilePath = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(currentFilePath);
const repoRoot = path.resolve(scriptsDir, "..");
const packagesDir = path.join(repoRoot, "packages");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageContexts = await loadPackageContexts();

  validateSourcePackages(packageContexts);

  if (options.validateOnly) {
    for (const context of packageContexts) {
      getTypescriptTargets(context);
    }
    log(`Validated ${packageContexts.length} package definition(s)`);
    return;
  }

  const contextsToProcess = filterPackageContexts(packageContexts, options.packageDir);

  if (contextsToProcess.length === 0) {
    throw new Error("No packages matched the requested filter.");
  }

  for (const context of contextsToProcess) {
    const targets = getTypescriptTargets(context);
    if (targets.length === 0) {
      throw new Error(`No TypeScript generator targets were found for ${context.packageName}.`);
    }

    for (const target of targets) {
      await ensureGitHubRepository(target.githubRepository, target.generatedPackageName);
      await ensureNpmPackage(target.generatedPackageName, target.githubRepository);
    }
  }
}

function parseArgs(args) {
  const options = {
    packageDir: null,
    validateOnly: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--validate-only") {
      options.validateOnly = true;
      continue;
    }

    if (argument === "--package-dir") {
      const value = args[index + 1];
      if (value == null) {
        throw new Error("--package-dir requires a value.");
      }
      options.packageDir = path.resolve(process.cwd(), value);
      index += 1;
      continue;
    }

    throw new Error(`Unsupported argument: ${argument}`);
  }

  return options;
}

async function loadPackageContexts() {
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const contexts = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageDir = path.join(packagesDir, entry.name);
    const packageJsonPath = path.join(packageDir, "package.json");
    const packageJsonRaw = await readFile(packageJsonPath, "utf8");
    const packageJson = JSON.parse(packageJsonRaw);
    const generatorsPath = path.join(packageDir, "fern", "generators.yml");
    const generatorsRaw = await readOptionalFile(generatorsPath);

    contexts.push({
      packageDir,
      packageName: packageJson.name,
      packageSlug: entry.name,
      generatorsPath,
      generatorsRaw
    });
  }

  return contexts;
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function validateSourcePackages(packageContexts) {
  for (const context of packageContexts) {
    if (typeof context.packageName !== "string" || !context.packageName.startsWith(packagePrefix)) {
      throw new Error(
        `Package ${path.relative(repoRoot, context.packageDir)} must start with ${packagePrefix}. Found ${String(context.packageName)}.`
      );
    }
  }
}

function filterPackageContexts(packageContexts, packageDirFilter) {
  if (packageDirFilter == null) {
    return packageContexts;
  }

  return packageContexts.filter((context) => path.resolve(context.packageDir) === packageDirFilter);
}

function getTypescriptTargets(context) {
  if (context.generatorsRaw == null) {
    throw new Error(`Missing generators file at ${path.relative(repoRoot, context.generatorsPath)}.`);
  }

  const generatorsConfig = YAML.parse(context.generatorsRaw);
  const generatorEntries = generatorsConfig?.groups?.typescript?.generators;

  if (!Array.isArray(generatorEntries)) {
    return [];
  }

  return generatorEntries.map((generator) => {
    const generatedPackageName = generator?.output?.["package-name"];
    const githubRepository = generator?.github?.repository;
    const expectedTargetName = `${context.packageSlug}-typescript`;
    const expectedPackageName = `${packagePrefix}${expectedTargetName}`;
    const expectedRepository = `${githubOwner}/${expectedTargetName}`;

    if (generator?.output?.location !== "npm") {
      throw new Error(
        `TypeScript generator in ${path.relative(repoRoot, context.generatorsPath)} must publish to npm.`
      );
    }

    if (generatedPackageName !== expectedPackageName) {
      throw new Error(
        `Expected ${path.relative(repoRoot, context.generatorsPath)} to set output.package-name to ${expectedPackageName}, found ${String(generatedPackageName)}.`
      );
    }

    if (githubRepository !== expectedRepository) {
      throw new Error(
        `Expected ${path.relative(repoRoot, context.generatorsPath)} to set github.repository to ${expectedRepository}, found ${String(githubRepository)}.`
      );
    }

    return {
      generatedPackageName,
      githubRepository
    };
  });
}

async function ensureGitHubRepository(repository, packageName) {
  const [owner, repoName] = repository.split("/");
  if (owner !== githubOwner || repoName == null || repoName.length === 0) {
    throw new Error(`Unsupported GitHub repository target: ${repository}`);
  }

  let repo = await githubRequest("GET", `/repos/${repository}`, {
    allow404: true,
    requireAuth: false
  });

  if (repo == null) {
    log(`Creating GitHub repository ${repository}`);
    repo = await githubRequest("POST", `/orgs/${githubOwner}/repos`, {
      body: {
        name: repoName,
        description: `Generated SDK package for ${packageName}`,
        private: false,
        auto_init: true
      }
    });
  } else {
    log(`GitHub repository ${repository} already exists`);
  }

  let defaultBranch = repo.default_branch;
  if (typeof defaultBranch !== "string" || defaultBranch.length === 0) {
    defaultBranch = await initializeGitHubRepository(repository, repoName);
  }

  await ensureGitHubReadme(repository, defaultBranch, repoName);
}

async function initializeGitHubRepository(repository, repoName) {
  log(`Initializing empty GitHub repository ${repository}`);

  const readmeContent = `# ${repoName}\n`;
  const blob = await githubRequest("POST", `/repos/${repository}/git/blobs`, {
    body: {
      content: readmeContent,
      encoding: "utf-8"
    }
  });
  const tree = await githubRequest("POST", `/repos/${repository}/git/trees`, {
    body: {
      tree: [
        {
          path: "README.md",
          mode: "100644",
          type: "blob",
          sha: blob.sha
        }
      ]
    }
  });
  const commit = await githubRequest("POST", `/repos/${repository}/git/commits`, {
    body: {
      message: "chore: initialize repository",
      tree: tree.sha
    }
  });

  await githubRequest("POST", `/repos/${repository}/git/refs`, {
    body: {
      ref: "refs/heads/main",
      sha: commit.sha
    }
  });
  await githubRequest("PATCH", `/repos/${repository}`, {
    body: {
      default_branch: "main"
    }
  });

  return "main";
}

async function ensureGitHubReadme(repository, branch, repoName) {
  const readme = await githubRequest(
    "GET",
    `/repos/${repository}/contents/README.md?ref=${encodeURIComponent(branch)}`,
    {
      allow404: true,
      requireAuth: false
    }
  );

  if (readme != null) {
    return;
  }

  log(`Adding README.md to ${repository}`);
  await githubRequest("PUT", `/repos/${repository}/contents/README.md`, {
    body: {
      message: "chore: initialize repository",
      content: Buffer.from(`# ${repoName}\n`, "utf8").toString("base64"),
      branch
    }
  });
}

async function ensureNpmPackage(packageName, repository) {
  const exists = await npmPackageExists(packageName);
  if (exists) {
    log(`npm package ${packageName} already exists`);
    return;
  }

  const npmToken = process.env.NPM_TOKEN ?? process.env.NODE_AUTH_TOKEN;
  if (typeof npmToken !== "string" || npmToken.trim().length === 0) {
    throw new Error(`NPM_TOKEN is required to create ${packageName}.`);
  }

  log(`Creating npm package ${packageName}`);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "opensdkdev-bootstrap-"));
  try {
    const bootstrapPackageJson = {
      name: packageName,
      version: "0.0.0",
      description: `Bootstrap package for ${packageName}`,
      license: "MIT",
      repository: {
        type: "git",
        url: `git+https://github.com/${repository}.git`
      },
      publishConfig: {
        access: "public"
      }
    };

    await writeFile(path.join(tempDir, "package.json"), `${JSON.stringify(bootstrapPackageJson, null, 2)}\n`);
    await writeFile(path.join(tempDir, "README.md"), `# ${packageName}\n`);

    await runCommand("npm", ["publish", "--access", "public"], {
      cwd: tempDir,
      env: {
        ...process.env,
        NODE_AUTH_TOKEN: npmToken,
        NPM_TOKEN: npmToken
      }
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function npmPackageExists(packageName) {
  const response = await fetch(`${npmRegistryBaseUrl}/${encodeURIComponent(packageName)}`);

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to query npm registry for ${packageName}: ${response.status} ${body}`);
  }

  return true;
}

async function githubRequest(method, pathname, options = {}) {
  const { allow404 = false, body, requireAuth = true } = options;
  const githubToken = process.env.GH_TOKEN?.trim();

  if (!githubToken && requireAuth) {
    throw new Error(`GH_TOKEN is required for GitHub API request ${method} ${pathname}.`);
  }

  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  if (body != null) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${githubApiBaseUrl}${pathname}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body)
  });

  if (response.status === 404 && allow404) {
    return null;
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API request failed for ${method} ${pathname}: ${response.status} ${errorBody}`);
  }

  if (response.status === 204) {
    return null;
  }

  const responseText = await response.text();
  return responseText.length === 0 ? null : JSON.parse(responseText);
}

async function runCommand(command, args, options) {
  await new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, {
      ...options,
      stdio: "inherit"
    });

    childProcess.on("error", reject);
    childProcess.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${String(code)}.`));
    });
  });
}

function log(message) {
  console.log(`[provision] ${message}`);
}

main().catch((error) => {
  console.error(`[provision] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
