import type { INodeProperties } from 'n8n-workflow'

/**
 * Customers — read only.
 *
 * Added for the contract workflows, which need the address and the person a
 * contract is addressed to. There is deliberately no create or update: a
 * customer record is the thing invoices, projects and contracts all hang off,
 * and a workflow that can rewrite it is a workflow that can quietly change
 * what a past invoice said.
 */
export const clientOperations: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['client'] } },
    options: [
      {
        name: 'Get',
        value: 'get',
        action: 'Get a client',
        routing: {
          request: {
            method: 'GET',
            url: '=/api/automations/connector/clients/{{$parameter.clientId}}',
          },
        },
      },
      {
        name: 'Get Many',
        value: 'getMany',
        action: 'Get many clients',
        routing: { request: { method: 'GET', url: '/api/automations/connector/clients' } },
      },
    ],
    default: 'get',
  },
]

export const clientFields: INodeProperties[] = [
  {
    displayName: 'Client ID',
    name: 'clientId',
    type: 'string',
    required: true,
    default: '',
    description: 'The soloops client ID, e.g. out of the webhook payload',
    displayOptions: { show: { resource: ['client'], operation: ['get'] } },
  },
  {
    displayName: 'Filters',
    name: 'additionalFields',
    type: 'collection',
    placeholder: 'Add Filter',
    default: {},
    displayOptions: { show: { resource: ['client'], operation: ['getMany'] } },
    options: [
      {
        displayName: 'Archived',
        name: 'archived',
        type: 'boolean',
        default: false,
        routing: { send: { type: 'query', property: 'archived' } },
      },
      {
        displayName: 'Limit',
        name: 'limit',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 200 },
        default: 50,
        routing: { send: { type: 'query', property: 'limit' } },
      },
      {
        displayName: 'Search',
        name: 'q',
        type: 'string',
        default: '',
        description: 'Matches name and company',
        routing: { send: { type: 'query', property: 'q' } },
      },
    ],
  },
]
