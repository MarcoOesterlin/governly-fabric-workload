import 'dotenv/config';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

interface AppConfig {
  clientId: string;
  clientSecret: string;
  audience: string;
  workloadName: string;
  backendPort: number;
  publisherTenantId: string;
}

async function loadConfig(): Promise<AppConfig> {
  let clientId: string;
  let clientSecret: string;
  let audience: string;

  const keyVaultUrl = process.env.KEYVAULT_URL;

  if (keyVaultUrl) {
    const credential = new DefaultAzureCredential();
    const secretClient = new SecretClient(keyVaultUrl, credential);

    const [clientIdSecret, clientSecretSecret, audienceSecret] = await Promise.all([
      secretClient.getSecret('GovernlyClientId'),
      secretClient.getSecret('GovernlyClientSecret'),
      secretClient.getSecret('GovernlyAudience'),
    ]);

    clientId = clientIdSecret.value!;
    clientSecret = clientSecretSecret.value!;
    audience = audienceSecret.value!;
  } else {
    clientId = process.env.CLIENTID!;
    clientSecret = process.env.CLIENTSECRET!;
    audience = process.env.AUDIENCE!;
  }

  return {
    clientId,
    clientSecret,
    audience,
    workloadName: process.env.WORKLOAD_NAME ?? 'Governly',
    backendPort: parseInt(process.env.BACKEND_PORT ?? '5000', 10),
    publisherTenantId: process.env.PUBLISHER_TENANT_ID ?? '',
  };
}

let _config: AppConfig | null = null;

export async function getConfig(): Promise<AppConfig> {
  if (!_config) {
    _config = await loadConfig();
  }
  return _config;
}
