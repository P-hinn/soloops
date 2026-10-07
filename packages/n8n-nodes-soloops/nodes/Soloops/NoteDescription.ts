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
    ],
    default: 'create',
  },
]

export const noteFields: INodeProperties[] = [
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
