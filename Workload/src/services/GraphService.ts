export interface SensitivityLabel {
  id: string;
  name: string;
  description?: string;
  color?: string;
  sensitivity?: number;
  tooltip?: string;
  isActive?: boolean;
  isAppliable?: boolean;
  contentFormats?: string[];
  parent?: { id: string; name: string };
}

export class GraphService {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  async listSensitivityLabels(): Promise<SensitivityLabel[]> {
    const response = await fetch(
      'https://graph.microsoft.com/beta/security/informationProtection/sensitivityLabels',
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      const error = Object.assign(
        new Error(`Graph API error ${response.status}: ${text}`),
        { status: response.status }
      );
      throw error;
    }

    const data = (await response.json()) as { value: SensitivityLabel[] };
    return data.value ?? [];
  }
}
