import type { INodeProperties } from 'n8n-workflow'

export const noteOperations: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['note'] } },
    options: [
      {
        name: 'Create',
        value: 'create',
        action: 'Create a note',
        routing: { request: { method: 'POST', url: '/api/automations/connector/notes' } },
      },
      {
        name: 'Get Many',
        value: 'getMany',
        action: 'Get many notes',
        routing: { request: { method: 'GET', url: '/api/automations/connector/notes' } },
      },
    ],
    default: 'create',
  },
]

export const noteFields: INodeProperties[] = [
  {
    displayName: 'Filters',
    name: 'additionalFields',
    type: 'collection',
    placeholder: 'Add Filter',
    default: {},
    displayOptions: { show: { resource: ['note'], operation: ['getMany'] } },
    options: [
      {
        displayName: 'Client ID',
        name: 'clientId',
        type: 'string',
        default: '',
        routing: { send: { type: 'query', property: 'clientId' } },
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
        displayName: 'Project ID',
        name: 'projectId',
        type: 'string',
        default: '',
        routing: { send: { type: 'query', property: 'projectId' } },
      },
      {
        displayName: 'Title Contains',
        name: 'q',
        type: 'string',
        default: '',
        routing: { send: { type: 'query', property: 'q' } },
      },
    ],
  },
  {
    displayName: 'Title',
    name: 'title',
    type: 'string',
    required: true,
    default: '',
    displayOptions: { show: { resource: ['note'], operation: ['create'] } },
    routing: { send: { type: 'body', property: 'title' } },
  },
  {
    displayName: 'Body',
    name: 'body',
    type: 'string',
    typeOptions: { rows: 5 },
    default: '',
    description: 'Markdown',
    displayOptions: { show: { resource: ['note'], operation: ['create'] } },
    routing: { send: { type: 'body', property: 'body' } },
  },
  {
    displayName: 'Additional Fields',
    name: 'additionalFields',
    type: 'collection',
    placeholder: 'Add Field',
    default: {},
    displayOptions: { show: { resource: ['note'], operation: ['create'] } },
    options: [
      {
        displayName: 'Client ID',
        name: 'clientId',
        type: 'string',
        default: '',
        routing: { send: { type: 'body', property: 'clientId' } },
      },
      {
        displayName: 'Project ID',
        name: 'projectId',
        type: 'string',
        default: '',
        routing: { send: { type: 'body', property: 'projectId' } },
      },
    ],
  },
]
