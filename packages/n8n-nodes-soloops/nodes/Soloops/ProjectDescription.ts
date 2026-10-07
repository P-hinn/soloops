import type { INodeProperties } from 'n8n-workflow'

export const projectOperations: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['project'] } },
    options: [
      {
        name: 'Create',
        value: 'create',
        action: 'Create a project',
        routing: { request: { method: 'POST', url: '/api/automations/connector/projects' } },
      },
      {
        name: 'Get Many',
        value: 'getMany',
        action: 'Get many projects',
        routing: { request: { method: 'GET', url: '/api/automations/connector/projects' } },
      },
    ],
    default: 'create',
  },
]

export const projectFields: INodeProperties[] = [
  {
    displayName: 'Name',
    name: 'name',
    type: 'string',
    required: true,
    default: '',
    displayOptions: { show: { resource: ['project'], operation: ['create'] } },
    routing: { send: { type: 'body', property: 'name' } },
  },
  {
    displayName: 'Key',
    name: 'key',
    type: 'string',
    required: true,
    default: '',
    placeholder: 'ACME-DWH',
    // soloops enforces uniqueness and answers 409 on a collision, which
    // surfaces in n8n as a failed node rather than a silent second project.
    description: 'Short identifier, unique across soloops',
    displayOptions: { show: { resource: ['project'], operation: ['create'] } },
    routing: { send: { type: 'body', property: 'key' } },
  },
  {
    displayName: 'Additional Fields',
    name: 'additionalFields',
    type: 'collection',
    placeholder: 'Add Field',
    default: {},
    displayOptions: { show: { resource: ['project'], operation: ['create'] } },
    options: [
      {
        displayName: 'Client ID',
        name: 'clientId',
        type: 'string',
        default: '',
        routing: { send: { type: 'body', property: 'clientId' } },
      },
      {
        displayName: 'Description',
        name: 'description',
        type: 'string',
        typeOptions: { rows: 3 },
        default: '',
        routing: { send: { type: 'body', property: 'description' } },
      },
      {
        displayName: 'Due On',
        name: 'dueOn',
        type: 'dateTime',
        default: '',
        routing: { send: { type: 'body', property: 'dueOn' } },
      },
      {
        displayName: 'Hourly Rate (Cents)',
        name: 'hourlyRateCents',
        type: 'number',
        default: 0,
        routing: { send: { type: 'body', property: 'hourlyRateCents' } },
      },
    ],
  },
  {
    displayName: 'Filters',
    name: 'additionalFields',
    type: 'collection',
    placeholder: 'Add Filter',
    default: {},
    displayOptions: { show: { resource: ['project'], operation: ['getMany'] } },
    options: [
      {
        displayName: 'Limit',
        name: 'limit',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 200 },
        default: 50,
        routing: { send: { type: 'query', property: 'limit' } },
      },
      {
        displayName: 'Status',
        name: 'status',
        type: 'options',
        options: [
          { name: 'Aktiv', value: 'ACTIVE' },
          { name: 'Pausiert', value: 'PAUSED' },
          { name: 'Fertig', value: 'DONE' },
          { name: 'Archiviert', value: 'ARCHIVED' },
        ],
        default: 'ACTIVE',
        routing: { send: { type: 'query', property: 'status' } },
      },
    ],
  },
]
