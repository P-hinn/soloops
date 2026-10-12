import type { IAuthenticateGeneric, ICredentialType, INodeProperties } from 'n8n-workflow'

/**
 * Zoho Sign, as n8n stores it.
 *
 * Shipped with the soloops nodes although no soloops node uses it: the
 * contract workflows need the three OAuth values somewhere, and the
 * alternative was `$env` inside expressions. That requires
 * `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, which hands *every* workflow on the
 * instance — including anything imported from the template gallery — the Zoho
 * client secret. A credential is scoped to the nodes that reference it.
 *
 * What it does is narrow on purpose: it appends the three values to the query
 * of the token request, which is exactly the call that needs them. Everything
 * afterwards runs on the short-lived access token the response carries, and
 * that is not a secret worth storing.
 *
 * The host stays in the workflow rather than in here: `$credentials` is not
 * readable from a URL expression, and `accounts.zoho.eu` is not a secret.
 * An account in the US data centre needs the `.com` host in both workflows.
 */
export class ZohoSignApi implements ICredentialType {
  name = 'zohoSignApi'

  displayName = 'Zoho Sign API'

  documentationUrl = 'https://www.zoho.com/sign/api/'

  properties: INodeProperties[] = [
    {
      displayName: 'Client ID',
      name: 'clientId',
      type: 'string',
      default: '',
      required: true,
      description: 'Self Client on api-console.zoho.eu, scope ZohoSign.documents.ALL',
    },
    {
      displayName: 'Client Secret',
      name: 'clientSecret',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
    },
    {
      displayName: 'Refresh Token',
      name: 'refreshToken',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description: 'Exchanged once from the authorization code, then valid until revoked',
    },
  ]

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      qs: {
        grant_type: 'refresh_token',
        client_id: '={{$credentials.clientId}}',
        client_secret: '={{$credentials.clientSecret}}',
        refresh_token: '={{$credentials.refreshToken}}',
      },
    },
  }
}
