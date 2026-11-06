// The Worker's optional secrets, which a deploy puts only when the
// environment has them (OPTIONAL_SECRETS in scripts/deploy.mjs). `wrangler
// types` writes only the secrets in secrets.required into
// worker-configuration.d.ts, so these are declared here, beside the
// generated Env, on both names it gives the Env.

declare namespace Cloudflare {
  interface Env {
    // The Anthropic API key the policy reader calls the API with
    // (src/anthropic.ts). Without it, the reader reads nothing with the model.
    ANTHROPIC_API_KEY?: string;
  }
}

interface Env {
  ANTHROPIC_API_KEY?: string;
}
