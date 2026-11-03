export function shouldLoadWorkingDirectoryEnv(input: {
  cwdEnvExists: boolean;
  isNexusEnvFile: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = input.env ?? process.env;
  return env.NEXUS_DISABLE_CWD_ENV_FILE !== "true"
    && input.cwdEnvExists
    && !input.isNexusEnvFile;
}
