import { log } from "../../utils/log.mjs";

export function createTypescriptProvisioner({ githubProvisioner, npmProvisioner }) {
  return {
    id: "typescript",
    getTargets(context) {
      const targetName = `${context.apiSlug}-typescript`;

      return [
        {
          context,
          targetName,
          generatedPackageName: context.packageName,
          githubRepository: context.githubRepository
        }
      ];
    },
    async provision(target) {
      log(`Provisioning TypeScript target for ${target.context.apiSlug}`);
      await githubProvisioner.provision({
        repository: target.githubRepository,
        packageName: target.generatedPackageName
      });
      await npmProvisioner.provision({
        packageName: target.generatedPackageName,
        repository: target.githubRepository
      });
    }
  };
}
