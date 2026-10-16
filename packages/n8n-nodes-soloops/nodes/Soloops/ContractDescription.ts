import type { INodeProperties } from 'n8n-workflow'

/**
 * Contracts, for the signing workflow.
 *
 * Two operations, and deliberately not four: the contract is created by
 * soloops when it sends it, and edited by whoever looks at it. What a workflow
 * needs is to find the contract a Zoho event belongs to and to report that it
 * came back signed.
 */
export const contractOperations: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['contract'] } },
    options: [
      {
        name: 'Get Many',
        value: 'getMany',
        action: 'Get many contracts',
        routing: { request: { method: 'GET', url: '/api/automations/connector/contracts' } },
      },
      {
        name: 'Mark Signed',
        value: 'markSigned',
        action: 'Mark a contract as signed',
        routing: {
          request: {
            method: 'POST',
            url: '=/api/automations/connector/contracts/{{$parameter.contractId}}/signed',
          },
        },
      },
    ],
    default: 'getMany',
  },
]

export const contractFields: INodeProperties[] = [
  {
    displayName: 'Contract ID',
    name: 'contractId',
    type: 'string',
    required: true,
    default: '',
    displayOptions: { show: { resource: ['contract'], operation: ['markSigned'] } },
  },
  {
    displayName: 'File Name',
    name: 'file',
    type: 'string',
    default: '',
    description:
      'Name of the signed PDF inside the contract directory, as Get Many handed it out in fileName',
    displayOptions: { show: { resource: ['contract'], operation: ['markSigned'] } },
    routing: { send: { type: 'body', property: 'file' } },
  },
  {
    displayName: 'Filters',
    name: 'additionalFields',
    type: 'collection',
    placeholder: 'Add Filter',
    default: {},
    displayOptions: { show: { resource: ['contract'], operation: ['getMany'] } },
    options: [
      {
        displayName: 'Client ID',
        name: 'clientId',
        type: 'string',
        default: '',
        routing: { send: { type: 'query', property: 'clientId' } },
      },
      {
        displayName: 'External ID',
        name: 'externalId',
        type: 'string',
        default: '',
        description: 'The signature request this contract was sent as, e.g. the Zoho request ID',
        routing: { send: { type: 'query', property: 'externalId' } },
      },
      {
        displayName: 'Limit',
        name: 'limit',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 100 },
        default: 20,
        routing: { send: { type: 'query', property: 'limit' } },
      },
      {
        displayName: 'Status',
        name: 'status',
        type: 'options',
        default: 'versendet',
        options: [
          { name: 'Abgelehnt', value: 'abgelehnt' },
          { name: 'Beendet', value: 'beendet' },
          { name: 'Entwurf', value: 'entwurf' },
          { name: 'Signiert', value: 'signiert' },
          { name: 'Versendet', value: 'versendet' },
        ],
        routing: { send: { type: 'query', property: 'status' } },
      },
    ],
  },
]
