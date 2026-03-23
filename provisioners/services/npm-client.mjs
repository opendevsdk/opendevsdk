import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { githubWorkflowFileName, npmRegistryBaseUrl } from "../config.mjs";
import { log } from "../utils/log.mjs";
import { runCommand } from "../utils/run-command.mjs";

export function createNpmClient() {
  return {
    ensurePackage,
    packageExists
  };
}

async function ensurePackage(packageName, repository) {
  const exists = await packageExists(packageName);
  if (exists) {
    log(`npm package ${packageName} already exists`);
    return;
  }

  const npmToken = process.env.NPM_TOKEN
  if (typeof npmToken !== "string" || npmToken.trim().length === 0) {
    throw new Error(`NPM_TOKEN is required to create ${packageName}.`);
  }

  log(`Creating npm package ${packageName}`);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "opendevsdk-bootstrap-"));
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
        NPM_TOKEN: npmToken
      }
    });

    await ensureTrustedPublisher(packageName, repository);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function packageExists(packageName) {
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

async function ensureTrustedPublisher(packageName, repository) {
  const npmToken = process.env.NPM_TOKEN
  if (typeof npmToken !== "string" || npmToken.trim().length === 0) {
    throw new Error(`NPM_TOKEN is required to configure trusted publishing for ${packageName}.`);
  }

  const npmOtp = process.env.NPM_TRUST_OTP ?? process.env.NPM_OTP;
  if (typeof npmOtp !== "string" || npmOtp.trim().length === 0) {
    throw new Error(
      `NPM_TRUST_OTP or NPM_OTP is required to configure trusted publishing for ${packageName}.`
    );
  }

  log(`Configuring npm trusted publisher for ${packageName}`);

  const response = await fetch(`${npmRegistryBaseUrl}/-/package/${encodeURIComponent(packageName)}/trust`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${npmToken.trim()}`,
      "Content-Type": "application/json",
      "npm-otp": npmOtp.trim()
    },
    body: JSON.stringify([
      {
        type: "github",
        claims: {
          repository,
          workflow_ref: {
            file: githubWorkflowFileName
          }
        }
      }
    ])
  });

  if (response.status === 409) {
    log(`npm trusted publisher already exists for ${packageName}`);
    return;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to configure npm trusted publisher for ${packageName}: ${response.status} ${body}`
    );
  }
}
