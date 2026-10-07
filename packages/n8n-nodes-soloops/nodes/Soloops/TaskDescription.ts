import type { INodeProperties } from 'n8n-workflow'

export const taskOperations: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['task'] } },
    options: [
      {
        name: 'Complete',
        value: 'complete',
        action: 'Mark a task as done',
        routing: {
          request: {
            method: 'POST',
            url: '=/api/automations/connector/tasks/{{$parameter.taskId}}/complete',
          },
        },
      },
      {
        name: 'Create',
        value: 'create',
        action: 'Create a task',
        routing: { request: { method: 'POST', url: '/api/automations/connector/tasks' } },
      },
      {
        name: 'Get Many',
        value: 'getMany',
        action: 'Get many tasks',
        routing: { request: { method: 'GET', url: '/api/automations/connector/tasks' } },
      },
    ],
    default: 'create',
  },
]

export const taskFields: INodeProperties[] = [
  {
    displayName: 'Task ID',
    name: 'taskId',
    type: 'string',
    required: true,
    default: '',
    displayOptions: { show: { resource: ['task'], operation: ['complete'] } },
  },
  {
    displayName: 'Title',
    name: 'title',
    type: 'string',
    required: true,
    default: '',
    displayOptions: { show: { resource: ['task'], operation: ['create'] } },
    routing: { send: { type: 'body', property: 'title' } },
  },
  {
    displayName: 'Additional Fields',
    name: 'additionalFields',
    type: 'collection',
    placeholder: 'Add Field',
    default: {},
    displayOptions: { show: { resource: ['task'], operation: ['create'] } },
    options: [
      {
        displayName: 'Assignee',
        name: 'assignee',
        type: 'string',
        default: '',
        routing: { send: { type: 'body', property: 'assignee' } },
      },
      {
        displayName: 'Due On',
        name: 'dueOn',
        type: 'dateTime',
        default: '',
        routing: { send: { type: 'body', property: 'dueOn' } },
      },
      {
        displayName: 'Meeting ID',
        name: 'meetingId',
        type: 'string',
        default: '',
        routing: { send: { type: 'body', property: 'meetingId' } },
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
  {
    displayName: 'Filters',
    name: 'additionalFields',
    type: 'collection',
    placeholder: 'Add Filter',
    default: {},
    displayOptions: { show: { resource: ['task'], operation: ['getMany'] } },
    options: [
      {
        displayName: 'Done',
        name: 'done',
        type: 'boolean',
        default: false,
        routing: { send: { type: 'query', property: 'done' } },
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
        displayName: 'Project ID',
        name: 'projectId',
        type: 'string',
        default: '',
        routing: { send: { type: 'query', property: 'projectId' } },
      },
    ],
  },
]
