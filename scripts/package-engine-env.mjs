/**
 * Environment handed to EVERY child process package-engine.mjs spawns (git,
 * node, npm ci). The engine's package.json lifecycle scripts run inside
 * `npm ci`, so anything in this environment is visible to third-party install
 * code: the builder-stage git token and any other git/registry credentials
 * must not be. The token reaches git only through the remote URL, never the
 * environment, so scrubbing loses nothing.
 */
const CREDENTIAL_ENV = /^(ARIA_ENGINE_GIT_TOKEN|GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|GIT_ASKPASS|SSH_ASKPASS|GIT_(?:.*(?:TOKEN|PASSWORD|PASSWD|CREDENTIAL|ASKPASS)).*|npm_config_.*(?:authtoken|_auth|password).*)$/i;

export function scrubbedChildEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || CREDENTIAL_ENV.test(k)) continue;
    out[k] = v;
  }
  return out;
}
