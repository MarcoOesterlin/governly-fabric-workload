import { ConfidentialClientApplication } from '@azure/msal-node';

export class AuthService {
  private cca: ConfidentialClientApplication;

  constructor(clientId: string, clientSecret: string, tenantId: string) {
    this.cca = new ConfidentialClientApplication({
      auth: {
        clientId,
        clientSecret,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
    });
  }

  async getOboToken(userToken: string, scopes: string[]): Promise<string> {
    const result = await this.cca.acquireTokenOnBehalfOf({
      oboAssertion: userToken,
      scopes,
    });

    if (!result?.accessToken) {
      throw new Error('OBO token exchange returned no access token');
    }

    return result.accessToken;
  }
}
