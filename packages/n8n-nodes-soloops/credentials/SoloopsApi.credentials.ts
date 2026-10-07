import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow'

/**
 * The soloops connection, as n8n stores it.
 *
 * Two fields and no OAuth dance: soloops is a single-tenant application run by
 * the person configuring this, so a bearer token is the honest mechanism. The
 * token is minted in soloops under Automatisierungen → Verbindungen, which is
 * also where it can be revoked without touching anything else.
 */
export class SoloopsApi implements ICredentialType {
  name = 'soloopsApi'

  displayName = 'soloops API'

  documentationUrl = 'https://github.com/P-hinn/soloops#automatisierungen'

  properties: INodeProperties[] = [
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      // Inside the compose network n8n reaches the API by service name. This
      // is the default because it is right for the bundled setup; a separately
      // hosted n8n needs the address soloops answers on from there.
      default: 'http://api:3000',
      placeholder: 'http://api:3000',
      description: 'Where soloops answers. Inside Docker this is the service name, not localhost.',
    },
    {
      displayName: 'Automation Token',
      name: 'token',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description:
        'Minted in soloops under Automatisierungen → Verbindungen. Starts with slp_ and is shown exactly once.',
    },
  ]

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        Authorization: '=Bearer {{$credentials.token}}',
      },
    },
  }

  /**
   * The "Test" button in n8n. Points at the connector's own ping rather than
   * at a real resource, so a credential with read-only scope still tests green
   * and the result says something about the token, not about whether any leads
   * happen to exist.
   */
  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.baseUrl}}',
      url: '/api/automations/connector/ping',
      method: 'GET',
    },
  }
}
