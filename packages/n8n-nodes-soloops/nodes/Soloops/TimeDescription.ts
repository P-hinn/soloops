import type { INodeProperties } from 'n8n-workflow'

export const timeOperations: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['time'] } },
    options: [
      {
        name: 'Log',
        value: 'log',
        action: 'Log time on a project',
        routing: { request: { method: 'POST', url: '/api/automations/connector/time' } },
      },
    ],
    default: 'log',
  },
]

export const timeFields: INodeProperties[] = [
  {
    displayName: 'Project ID',
    name: 'projectId',
    type: 'string',
    required: true,
    default: '',
    displayOptions: { show: { resource: ['time'], operation: ['log'] } },
    routing: { send: { type: 'body', property: 'projectId' } },
  },
  {
    displayName: 'Minutes',
    name: 'minutes',
    type: 'number',
    required: true,
    typeOptions: { minValue: 1, maxValue: 1440 },
    default: 30,
    // soloops stores seconds; the API takes minutes and converts at the edge,
    // because a workflow thinks in minutes and nobody wants that arithmetic
    // in an expression.
    description: 'Duration in minutes',
    displayOptions: { show: { resource: ['time'], operation: ['log'] } },
    routing: { send: { type: 'body', property: 'minutes' } },
  },
  {
    displayName: 'Additional Fields',
    name: 'additionalFields',
    type: 'collection',
    placeholder: 'Add Field',
    default: {},
    displayOptions: { show: { resource: ['time'], operation: ['log'] } },
    options: [
      {
        displayName: 'Billable',
        name: 'billable',
        type: 'boolean',
        default: true,
        routing: { send: { type: 'body', property: 'billable' } },
      },
      {
        displayName: 'Description',
        name: 'description',
        type: 'string',
        default: '',
        routing: { send: { type: 'body', property: 'description' } },
      },
      {
        displayName: 'Started At',
        name: 'startedAt',
        type: 'dateTime',
        default: '',
        description: 'Defaults to the duration ending now',
        routing: { send: { type: 'body', property: 'startedAt' } },
      },
    ],
  },
]
