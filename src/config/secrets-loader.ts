/**
 * SecretsLoader — loads secrets from AWS SSM Parameter Store into
 * process.env at boot, BEFORE the rest of the app initializes.
 *
 * Control via environment variables (set in Dokploy):
 *   SECRETS_SOURCE=env   — skip SSM (default, dev)
 *   SECRETS_SOURCE=ssm   — fetch from SSM_PATH_PREFIX
 *
 *   SSM_PATH_PREFIX=/maismilhas/prod/taskpilot-worker  (default)
 *   AWS_REGION=us-east-1
 *
 * Required IAM permissions on the runtime user:
 *   ssm:GetParametersByPath on the path prefix
 *   kms:Decrypt for SecureString params
 *
 * Env values already set on the process win — SSM never overwrites a
 * non-empty existing var. Lets local dev override individual values
 * and keeps the loader idempotent.
 */

import {
  SSMClient,
  GetParametersByPathCommand,
  type Parameter,
} from '@aws-sdk/client-ssm';

const DEFAULT_PATH_PREFIX = '/maismilhas/prod/taskpilot-worker';

export async function loadSecretsFromSSM(): Promise<void> {
  const source = (process.env.SECRETS_SOURCE || 'env').toLowerCase();

  if (source !== 'ssm') {
    console.log(
      `[secrets-loader] SECRETS_SOURCE=${source} — skipping SSM, using local env`,
    );
    return;
  }

  const pathPrefix = process.env.SSM_PATH_PREFIX || DEFAULT_PATH_PREFIX;
  const region = process.env.AWS_REGION || 'us-east-1';

  const client = new SSMClient({ region });
  const parameters: Parameter[] = [];
  let nextToken: string | undefined;

  try {
    do {
      const resp = await client.send(
        new GetParametersByPathCommand({
          Path: pathPrefix,
          Recursive: true,
          WithDecryption: true,
          MaxResults: 10,
          NextToken: nextToken,
        }),
      );
      if (resp.Parameters) parameters.push(...resp.Parameters);
      nextToken = resp.NextToken;
    } while (nextToken);
  } catch (err) {
    console.error(
      `[secrets-loader] failed to fetch from SSM path ${pathPrefix}:`,
      (err as Error).message,
    );
    throw new Error(
      `SecretsLoader: cannot reach SSM (${(err as Error).message}). ` +
        `Set SECRETS_SOURCE=env to bypass.`,
    );
  }

  let loaded = 0;
  let skipped = 0;
  for (const param of parameters) {
    if (!param.Name || param.Value === undefined) continue;
    const key = param.Name.replace(`${pathPrefix}/`, '').toUpperCase();
    if (process.env[key] !== undefined && process.env[key] !== '') {
      skipped += 1;
      continue;
    }
    process.env[key] = param.Value;
    loaded += 1;
  }

  console.log(
    `[secrets-loader] loaded ${loaded} parameters from SSM (${pathPrefix}), ${skipped} skipped (already in env)`,
  );
}
