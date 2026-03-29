import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { apisDir, githubOwner, packagePrefix, repoRoot } from "../config.mjs";

export async function loadPackageContexts() {
  const entries = await readdir(apisDir, { withFileTypes: true });
  const contexts = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const apiDir = path.join(apisDir, entry.name);
    const generatorsPath = path.join(apiDir, "generators.yml");
    const generatorsRaw = await readFile(generatorsPath, "utf8");
    const generatorsConfig = parse(generatorsRaw);

    const packageName = getFirstGeneratorField(
      generatorsConfig,
      "output",
      "package-name",
      `package-name in ${path.relative(repoRoot, generatorsPath)}`
    );
    const githubRepository = getFirstGeneratorField(
      generatorsConfig,
      "github",
      "repository",
      `repository in ${path.relative(repoRoot, generatorsPath)}`
    );

    contexts.push({
      apiDir,
      apiSlug: entry.name,
      generatorsPath,
      packageName,
      githubRepository
    });
  }

  return contexts;
}

export function validateSourcePackages(packageContexts) {
  for (const context of packageContexts) {
    if (typeof context.packageName !== "string" || !context.packageName.startsWith(packagePrefix)) {
      throw new Error(
        `Generator output in ${path.relative(repoRoot, context.generatorsPath)} must start with ${packagePrefix}. Found ${String(context.packageName)}.`
      );
    }

    const repositoryPrefix = `${githubOwner}/`;
    if (
      typeof context.githubRepository !== "string" ||
      !context.githubRepository.startsWith(repositoryPrefix)
    ) {
      throw new Error(
        `GitHub repository in ${path.relative(repoRoot, context.generatorsPath)} must start with ${repositoryPrefix}. Found ${String(context.githubRepository)}.`
      );
    }
  }
}

export function filterPackageContexts(packageContexts, packageDirFilter) {
  if (packageDirFilter == null) {
    return packageContexts;
  }

  return packageContexts.filter((context) => path.resolve(context.apiDir) === packageDirFilter);
}

function getFirstGeneratorField(config, sectionName, fieldName, description) {
  const groups = config?.groups;
  if (groups == null || typeof groups !== "object" || Array.isArray(groups)) {
    throw new Error(`Could not find groups in ${description}.`);
  }

  for (const group of Object.values(groups)) {
    const generators = group?.generators;
    if (!Array.isArray(generators)) {
      continue;
    }

    for (const generator of generators) {
      const value = generator?.[sectionName]?.[fieldName];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }

  throw new Error(`Could not find ${description}.`);
}
