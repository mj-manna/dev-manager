/**
 * Select option value for “install dependencies” merged into the Run… dropdown.
 * Not a valid npm script name, so it cannot collide with package.json scripts.
 */
export const PACKAGE_JSON_SELECT_INSTALL_VALUE = '__dm_install__'

/** Mirrors `/api/deployments/package-json` runnerSource values. */
export type PackageRunnerSource =
  | 'package_manager_field'
  | 'pnpm_lock'
  | 'yarn_lock'
  | 'bun_lock'
  | 'package_lock_json'
  | 'npm_default'

/** Long description for badge / accessibility (how we chose pnpm vs npm, etc.). */
export function packageManagerDetectionDescription(
  source: string,
  detail?: string,
): string {
  switch (source as PackageRunnerSource) {
    case 'package_manager_field':
      return detail
        ? `Taken from package.json "packageManager": ${detail}. (This field overrides lockfiles.)`
        : `Taken from package.json field "packageManager". (This field overrides lockfiles.)`
    case 'pnpm_lock':
      return 'pnpm-lock.yaml is present in the project folder (no packageManager field matched).'
    case 'yarn_lock':
      return 'yarn.lock is present in the project folder (no packageManager field matched).'
    case 'bun_lock':
      return 'A Bun lockfile (bun.lockb or bun.lock) is present (no packageManager field matched).'
    case 'package_lock_json':
      return 'package-lock.json is present — npm is used for install and script commands.'
    case 'npm_default':
    default:
      return 'No "packageManager" in package.json and no lockfile found (pnpm, yarn, bun, or package-lock); defaulting to npm.'
  }
}

/** Install dependencies using the same package manager we detected for that project. */
export function formatPackageInstallCommand(runner: string): string {
  const r = runner.toLowerCase()
  if (r === 'pnpm') return 'pnpm install'
  if (r === 'yarn') return 'yarn install'
  if (r === 'bun') return 'bun install'
  return 'npm install'
}

/** Build shell command to run a package.json script (cwd is applied separately by the terminal). */
export function formatPackageScriptCommand(runner: string, scriptName: string): string {
  const safe = /^[a-zA-Z0-9._-]+$/.test(scriptName)
    ? scriptName
    : `'${scriptName.replace(/'/g, `'\\''`)}'`
  const r = runner.toLowerCase()
  if (r === 'pnpm') return `pnpm run ${safe}`
  if (r === 'yarn') return `yarn run ${safe}`
  if (r === 'bun') return `bun run ${safe}`
  return `npm run ${safe}`
}
